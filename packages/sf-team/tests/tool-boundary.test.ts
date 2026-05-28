/**
 * S-M27 — Runtime-faithful integration test for the M2 typed-error
 * pipeline. Reproduces the exact Pi `agent-loop.js:367,390,418` error
 * path so we don't rely on typed fields surviving the runtime boundary
 * (verified inline: `agent-loop.js:428-433` calls
 * `createErrorToolResult(error.message)` with `details: {}` BEFORE any
 * `tool_result` hook fires).
 *
 * This is approach (b) in the milestone spec: a small fake that calls
 * the same code path as the real agent loop. We register one sf-team
 * tool name with a synthetic `execute()` that throws a typed error,
 * drive a single tool call through the fake harness, and assert the
 * captured `tool_result` event has `isError === true`,
 * `content[0].text` starts with the expected `FAILED:` envelope, and
 * contains the right `RESUME:` instruction.
 *
 * The real Pi `agent-loop.js:367,390,418` and `createErrorToolResult`
 * (lines 428-433 in `pi-agent-core@0.74.0`) is the live runtime
 * surface this test pins.
 */
import { describe, expect, it } from "vitest";

import {
  EmptyDiffError,
  SfTeamToolError,
  WorkflowStateError,
  wrapExecute,
} from "../src/errors";

// ---------------------------------------------------------------------------
// Fake agent-loop harness (mirrors `agent-loop.js:367,390,418` + `:428-433`)
// ---------------------------------------------------------------------------
function createErrorToolResult(message: string): { content: Array<{ type: "text"; text: string }>; details: Record<string, unknown> } {
  return { content: [{ type: "text", text: message }], details: {} };
}

interface ToolResultEvent {
  type: "tool_execution_end";
  toolCallId: string;
  toolName: string;
  result: { content: Array<{ type: string; text: string }>; details: Record<string, unknown> };
  isError: boolean;
}

async function runToolThroughFakeAgentLoop(
  tool: { name: string; execute: (...args: any[]) => Promise<any> },
  args: Record<string, unknown>,
): Promise<ToolResultEvent> {
  try {
    const result = await tool.execute("call-1", args, undefined, undefined, { hasUI: false });
    return { type: "tool_execution_end", toolCallId: "call-1", toolName: tool.name, result, isError: false };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const result = createErrorToolResult(message);
    return { type: "tool_execution_end", toolCallId: "call-1", toolName: tool.name, result, isError: true };
  }
}

describe("S-M27 typed-error pipeline (runtime-faithful)", () => {
  it("EmptyDiffError yields { isError:true, content[0].text starts with FAILED: <toolName> empty_diff: } and names the resume tool", async () => {
    const synthetic = {
      name: "sf_team_implement",
      execute: wrapExecute(
        "sf_team_implement",
        async () => {
          throw new EmptyDiffError({
            toolName: "sf_team_implement",
            milestoneId: "M5",
            attempts: 1,
            slug: "2026-05-06-feature-flags",
            worktreePath: "/tmp/wt",
            resumeTool: "sf_team_implement_resume",
          });
        },
      ),
    };
    const event = await runToolThroughFakeAgentLoop(synthetic, {});
    expect(event.isError).toBe(true);
    expect(event.result.details).toEqual({}); // runtime drops typed fields
    const text = event.result.content[0].text;
    expect(text.startsWith("FAILED: sf_team_implement empty_diff:")).toBe(true);
    expect(text).toContain("M5");
    expect(text).toContain("RESUME: invoke sf_team_implement_resume { resume: '2026-05-06-feature-flags' }");
    expect(text).toContain("implement.empty_diff_retry_model");
  });

  it("untyped Error thrown inside an execute body is converted by wrapExecute into FAILED: <toolName> internal: ...", async () => {
    const synthetic = {
      name: "sf_team_implement",
      execute: wrapExecute(
        "sf_team_implement",
        async () => {
          throw new Error("plain untyped failure");
        },
      ),
    };
    const event = await runToolThroughFakeAgentLoop(synthetic, {});
    expect(event.isError).toBe(true);
    const text = event.result.content[0].text;
    expect(text.startsWith("FAILED: sf_team_implement internal:")).toBe(true);
    expect(text).toContain("plain untyped failure");
    expect(text.toLowerCase()).toContain("consult the sf-team transcript");
  });

  // Smarter resume hint: when wrapExecute's toolName resolves to a known
  // base or _resume tool, the RESUME: line names the matching `_resume`
  // tool directly so calling LLMs don't have to infer it from the
  // "consult the transcript" generic copy.
  it("wrapExecute internal-error hint names the matching _resume tool when toolName is a recognized base name", async () => {
    const synthetic = {
      name: "sf_team_auto",
      execute: wrapExecute("sf_team_auto", async () => {
        throw new Error("planner crashed");
      }),
    };
    const event = await runToolThroughFakeAgentLoop(synthetic, {});
    expect(event.isError).toBe(true);
    const text = event.result.content[0].text;
    expect(text.startsWith("FAILED: sf_team_auto internal:")).toBe(true);
    expect(text).toContain("RESUME: invoke sf_team_auto_resume { resume: '<slug-or-path>' }");
    expect(text.toLowerCase()).toContain("consult the sf-team transcript");
  });

  it("wrapExecute internal-error hint also resolves _resume tool when toolName is itself a _resume", async () => {
    const synthetic = {
      name: "sf_team_implement_resume",
      execute: wrapExecute("sf_team_implement_resume", async () => {
        throw new Error("transient outage");
      }),
    };
    const event = await runToolThroughFakeAgentLoop(synthetic, {});
    const text = event.result.content[0].text;
    expect(text.startsWith("FAILED: sf_team_implement_resume internal:")).toBe(true);
    expect(text).toContain("RESUME: invoke sf_team_implement_resume { resume: '<slug-or-path>' }");
  });

  it("wrapExecute falls back to the generic transcript-only hint for unknown tool names", async () => {
    const synthetic = {
      name: "unknown_tool",
      execute: wrapExecute("unknown_tool", async () => {
        throw new Error("???");
      }),
    };
    const event = await runToolThroughFakeAgentLoop(synthetic, {});
    const text = event.result.content[0].text;
    expect(text.startsWith("FAILED: unknown_tool internal:")).toBe(true);
    expect(text).not.toMatch(/_resume \{ resume:/);
    expect(text.toLowerCase()).toContain("consult the sf-team transcript");
  });

  it("WorkflowStateError yields FAILED: <toolName> workflow_state: with the configured RESUME hint", async () => {
    const synthetic = {
      name: "sf_team_task",
      execute: wrapExecute(
        "sf_team_task",
        async () => {
          throw new WorkflowStateError({
            toolName: "sf_team_task",
            description: "developer produced no staged changes",
            resumeHint: "invoke sf_team_task_resume { resume: 'demo' } after staging changes",
            details: { slug: "demo" },
          });
        },
      ),
    };
    const event = await runToolThroughFakeAgentLoop(synthetic, {});
    expect(event.isError).toBe(true);
    const text = event.result.content[0].text;
    expect(text.startsWith("FAILED: sf_team_task workflow_state:")).toBe(true);
    expect(text).toContain("developer produced no staged changes");
    expect(text).toContain("RESUME: invoke sf_team_task_resume { resume: 'demo' } after staging changes");
  });
});

// ---------------------------------------------------------------------------
// withTool semantic checks (R3 P2: no in-place mutation of Error.message)
// ---------------------------------------------------------------------------
describe("S-M26 withTool: returns a NEW instance with recomposed Error.message", () => {
  it("withTool preserves merged details on the new instance (auto's autoSlug survives the rewrap)", () => {
    const original = new EmptyDiffError({
      toolName: "sf_team_implement",
      milestoneId: "M5",
      attempts: 3,
      slug: "auto-slug",
      resumeTool: "sf_team_implement_resume",
    });
    const reframed = original.withTool("sf_team_auto", "sf_team_auto_resume", {
      autoSlug: "auto-slug",
      slug: "auto-slug",
    });
    // Subclass-canonical fields preserved from the original.
    expect(reframed.details.milestoneId).toBe("M5");
    expect(reframed.details.attempts).toBe(3);
    expect(reframed.details.slug).toBe("auto-slug");
    // Auto's extras survive the clone (S-M21 / S-M26 contract: "all the same details plus the supplied overrides").
    expect(reframed.details.autoSlug).toBe("auto-slug");
    // Original is untouched.
    expect(original.details.autoSlug).toBeUndefined();
  });

  it("withTool preserves subclass identity (returns EmptyDiffError, not base SfTeamToolError)", () => {
    const original = new EmptyDiffError({
      toolName: "sf_team_implement",
      milestoneId: "M3",
      attempts: 2,
      slug: "demo-slug",
      resumeTool: "sf_team_implement_resume",
    });
    const reframed = original.withTool("sf_team_auto", "sf_team_auto_resume", { autoSlug: "auto-slug", slug: "auto-slug" });
    expect(reframed).toBeInstanceOf(EmptyDiffError);
    expect(reframed).not.toBe(original);
    // Subclass identity preserved; base SfTeamToolError instanceof still true via prototype chain.
    expect(reframed).toBeInstanceOf(SfTeamToolError);
    expect(reframed.kind).toBe("empty_diff");
  });

  it("withTool produces a new instance and leaves the original untouched", () => {
    const original = new EmptyDiffError({
      toolName: "sf_team_implement",
      milestoneId: "M3",
      attempts: 2,
      slug: "demo-slug",
      resumeTool: "sf_team_implement_resume",
    });
    const reframed = original.withTool("sf_team_auto", "sf_team_auto_resume", { autoSlug: "auto-slug", slug: "auto-slug" });

    // Independent objects.
    expect(reframed).not.toBe(original);
    expect(original.message.startsWith("FAILED: sf_team_implement ")).toBe(true);
    expect(original.toolName).toBe("sf_team_implement");

    // New instance has the auto surface name.
    expect(reframed.message.startsWith("FAILED: sf_team_auto empty_diff:")).toBe(true);
    expect(reframed.toolName).toBe("sf_team_auto");
    expect(reframed.resumeTool).toBe("sf_team_auto_resume");
    // Subclass-specific resume hint is preserved through composeResumeHintWith.
    expect(reframed.message).toContain("RESUME: invoke sf_team_auto_resume { resume: 'auto-slug' }");
    expect(reframed.message).toContain("implement.empty_diff_retry_model");
  });

  it("the auto-wraps-implement test path matches the M2 spec (S-M27): rethrown error names the auto surface", async () => {
    // Simulate: implement throws EmptyDiffError; auto catches and rewraps via withTool.
    let captured: SfTeamToolError | undefined;
    try {
      try {
        throw new EmptyDiffError({
          toolName: "sf_team_implement",
          milestoneId: "M5",
          attempts: 3,
          slug: "auto-slug",
          resumeTool: "sf_team_implement_resume",
        });
      } catch (err) {
        if (err instanceof SfTeamToolError) {
          throw err.withTool("sf_team_auto", "sf_team_auto_resume", {
            autoSlug: "auto-slug",
            slug: "auto-slug",
          });
        }
        throw err;
      }
    } catch (err) {
      captured = err as SfTeamToolError;
    }
    expect(captured).toBeInstanceOf(SfTeamToolError);
    const m = captured!.message;
    expect(m.startsWith("FAILED: sf_team_auto empty_diff:")).toBe(true);
    expect(m).toContain("RESUME: invoke sf_team_auto_resume { resume: 'auto-slug' }");
  });
});
