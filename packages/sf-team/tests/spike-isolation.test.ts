import { existsSync, readFileSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  assertSpikeOutcome,
  buildReviewerArgv,
  classifyEvent,
  extractFinalAssistantText,
  extractVerdict,
  parseLineDelimitedJson,
  REVIEWER_BASE_FLAGS,
  SpikeRunError,
  spikeArtifactPath,
  spikeReviewSamplePlan,
  type SpikeRunResult,
} from "../src/runtime/spike";

describe("M0 spike: reviewer argv profile", () => {
  it("includes every locked isolation flag and the read-only tool allowlist", () => {
    const argv = buildReviewerArgv({ task: "ignored" });
    expect(argv).toEqual([
      "--mode",
      "json",
      "--no-session",
      "--no-skills",
      "--no-prompt-templates",
      "--no-extensions",
      "--no-context-files",
      "--tools",
      "read,grep,find,ls",
      "-p",
      "ignored",
    ]);
  });

  it("never injects --skill into the reviewer profile", () => {
    const argv = buildReviewerArgv({ task: "ignored", model: "claude-opus-4-7" });
    expect(argv.some((arg) => arg === "--skill")).toBe(false);
    expect(REVIEWER_BASE_FLAGS).not.toContain("--skill");
  });

  it("appends --model and --thinking when supplied (still no --skill)", () => {
    const argv = buildReviewerArgv({ task: "t", model: "claude-opus-4-7", thinking: "xhigh" });
    expect(argv).toContain("--model");
    expect(argv).toContain("claude-opus-4-7");
    expect(argv).toContain("--thinking");
    expect(argv).toContain("xhigh");
    expect(argv).not.toContain("--skill");
  });
});

describe("M0 spike: line-delimited JSON parser", () => {
  it("returns the trailing partial line as remainder", () => {
    const fixture = '{"type":"agent_start"}\n{"type":"turn_st';
    const { events, remainder } = parseLineDelimitedJson(fixture);
    expect(events).toEqual([{ type: "agent_start" }]);
    expect(remainder).toBe('{"type":"turn_st');
  });

  it("ignores blank lines and pre-protocol banners", () => {
    const fixture = '\n  \npi banner ignored\n{"type":"session","id":"abc"}\n';
    const { events, remainder } = parseLineDelimitedJson(fixture);
    expect(events).toEqual([{ type: "session", id: "abc" }]);
    expect(remainder).toBe("");
  });

  it("classifies known and unknown event types", () => {
    expect(classifyEvent({ type: "agent_start" }).type).toBe("agent_start");
    expect(classifyEvent({ type: "tool_call", toolName: "read" }).type).toBe("tool_call");
    expect(classifyEvent({ type: "wat" }).type).toBe("unknown");
    expect(classifyEvent({}).type).toBe("unknown");
  });
});

describe("M0 spike: verdict + final-text extraction", () => {
  it("extracts the LAST verdict line so plans containing the words don't poison parsing", () => {
    const text = "Earlier we said VERDICT: REVISE.\n## Verdict\nVERDICT: APPROVED";
    expect(extractVerdict(text)).toBe("APPROVED");
  });

  it("returns UNKNOWN when no verdict line is present", () => {
    expect(extractVerdict("approved is the right answer")).toBe("UNKNOWN");
  });

  it("returns the joined final-assistant text from agent_end.messages", () => {
    const finalText = extractFinalAssistantText({
      type: "agent_end",
      messages: [
        { role: "user", content: [{ type: "text", text: "ignored" }] },
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "internal" },
            { type: "text", text: "## Verdict\nVERDICT: APPROVED" },
          ],
        },
      ],
    });
    expect(finalText).toBe("## Verdict\nVERDICT: APPROVED");
  });

  it("returns empty string when no assistant message is present", () => {
    expect(extractFinalAssistantText({ type: "agent_end", messages: [] })).toBe("");
  });
});

describe("M0 spike: success-artifact path convention", () => {
  it("anchors the artifact under <cwd>/.sf-team/spike/verdict-<iso>.md", () => {
    const at = spikeArtifactPath("/repo", new Date("2026-05-01T08:00:00.000Z"));
    expect(at).toBe("/repo/.sf-team/spike/verdict-2026-05-01T08-00-00-000Z.md");
  });
});

describe("M0 spike: assertSpikeOutcome gates", () => {
  function makeResult(overrides: Partial<SpikeRunResult>): SpikeRunResult {
    return {
      exitCode: 0,
      finalText: "## Verdict\nVERDICT: APPROVED",
      events: [],
      toolCalls: [],
      stderrTail: "",
      ...overrides,
    };
  }

  it("returns the verdict on success", () => {
    expect(assertSpikeOutcome(makeResult({}))).toBe("APPROVED");
    expect(assertSpikeOutcome(makeResult({ finalText: "VERDICT: REVISE" }))).toBe("REVISE");
  });

  it("throws SpikeRunError when the subprocess exited non-zero", () => {
    expect(() => assertSpikeOutcome(makeResult({ exitCode: 2, stderrTail: "boom" }))).toThrow(SpikeRunError);
  });

  it("throws SpikeRunError when the verdict is UNKNOWN", () => {
    const fn = () => assertSpikeOutcome(makeResult({ finalText: "no verdict here" }));
    expect(fn).toThrow(SpikeRunError);
    expect(fn).toThrow(/non-conforming/);
  });

  it("preserves stderrTail and toolCalls on the thrown error for diagnostics", () => {
    try {
      assertSpikeOutcome(
        makeResult({ exitCode: 1, stderrTail: "stack trace", toolCalls: [{ toolName: "read", input: {} }] }),
      );
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(SpikeRunError);
      const sre = err as SpikeRunError;
      expect(sre.stderrTail).toBe("stack trace");
      expect(sre.toolCalls).toEqual([{ toolName: "read", input: {} }]);
      expect(sre.exitCode).toBe(1);
    }
  });
});

describe("M0 spike: end-to-end isolated reviewer call (integration)", () => {
  const integrationEnabled = process.env.PI_INTEGRATION === "1";
  const piAvailable = (() => {
    if (!integrationEnabled) return false;
    const pathEnv = process.env.PATH ?? "";
    return pathEnv
      .split(":")
      .some((dir) => dir.length > 0 && existsSync(`${dir}/pi`));
  })();

  it.skipIf(!piAvailable)(
    "spawns isolated pi reviewer, refuses coercion (no bash/edit tool_calls), parses verdict, and writes artifact",
    async () => {
      const tmp = mkdtempSync(path.join(tmpdir(), "spike-iso-"));
      const artifactPath = path.join(tmp, "verdict.md");
      try {
        const result = await spikeReviewSamplePlan({ artifactPath });

        // The reviewer prompt explicitly TRIES to coerce bash + edit. The
        // isolation profile must defeat the coercion.
        const bashCalls = result.toolCalls.filter((tc) => tc.toolName === "bash");
        const editCalls = result.toolCalls.filter(
          (tc) => tc.toolName === "edit" || tc.toolName === "write",
        );
        expect(bashCalls.length).toBe(0);
        expect(editCalls.length).toBe(0);

        // End-to-end parser proof: verdict must be one of the two valid forms
        // (NOT UNKNOWN — that would mean the parser failed against real output).
        expect(["APPROVED", "REVISE"]).toContain(result.verdict);

        // Success-artifact path convention must be honored.
        expect(existsSync(result.artifactPath)).toBe(true);
        const body = readFileSync(result.artifactPath, "utf8");
        expect(body).toContain(`verdict=${result.verdict}`);
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    },
    180_000,
  );
});
