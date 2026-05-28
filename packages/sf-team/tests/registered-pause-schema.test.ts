import { describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { Value } from "typebox/value";

import sfTeamExtension from "../extensions/sf-team";
import { planFolderPath } from "../src/plan/paths";
import * as autoModule from "../src/tools/auto";
import * as implementModule from "../src/tools/implement";

interface RegisteredTool {
  name: string;
  description: string;
  parameters: unknown;
  execute: (...args: unknown[]) => Promise<unknown>;
}

class FakePi {
  tools: RegisteredTool[] = [];
  registerTool(tool: RegisteredTool): void {
    this.tools.push(tool);
  }
  registerCommand(_name: string, _options: unknown): void {}
  sendUserMessage(_content: string): void {}
}

function loadTools(): { implement: RegisteredTool; auto: RegisteredTool } {
  const pi = new FakePi();
  sfTeamExtension(pi as never);
  const implement = pi.tools.find((t) => t.name === "sf_team_implement")!;
  const auto = pi.tools.find((t) => t.name === "sf_team_auto")!;
  expect(implement, "sf_team_implement registration must exist").toBeDefined();
  expect(auto, "sf_team_auto registration must exist").toBeDefined();
  return { implement, auto };
}

function seedPlanProgress(root: string, slug: string): void {
  const folder = planFolderPath(root, slug);
  mkdirSync(folder, { recursive: true });
  writeFileSync(path.join(folder, "milestone-plan.md"), "# Plan\n");
  writeFileSync(path.join(folder, "continuation-runbook.md"), "# Runbook\n");
  writeFileSync(
    path.join(folder, "story-tracker.md"),
    `### M1: One

| Story | Description | Status | Notes |
|-------|-------------|--------|-------|
| S-101 | one | completed | abc |

**Approval Status:** approved (abc)

### M2: Two

| Story | Description | Status | Notes |
|-------|-------------|--------|-------|
| S-201 | two | completed | def |

**Approval Status:** approved (def)

### M3: Three

| Story | Description | Status | Notes |
|-------|-------------|--------|-------|
| S-301 | three | pending | |

**Approval Status:** pending
`,
  );
}

describe("S-207: registered tool input schemas accept pauseBetweenMilestones", () => {
  it("sf_team_implement Value.Check passes WITH pauseBetweenMilestones=true|false|absent", () => {
    const { implement } = loadTools();
    const schema = implement.parameters;
    expect(Value.Check(schema as never, { slug: "x" })).toBe(true);
    expect(Value.Check(schema as never, { slug: "x", pauseBetweenMilestones: true })).toBe(true);
    expect(Value.Check(schema as never, { slug: "x", pauseBetweenMilestones: false })).toBe(true);
    // Wrong type rejected.
    expect(Value.Check(schema as never, { slug: "x", pauseBetweenMilestones: "yes" })).toBe(false);
  });

  it("sf_team_auto Value.Check passes WITH pauseBetweenMilestones=true|false|absent", () => {
    const { auto } = loadTools();
    const schema = auto.parameters;
    expect(Value.Check(schema as never, { title: "x" })).toBe(true);
    expect(Value.Check(schema as never, { title: "x", pauseBetweenMilestones: true })).toBe(true);
    expect(Value.Check(schema as never, { title: "x", pauseBetweenMilestones: false })).toBe(true);
    expect(Value.Check(schema as never, { title: "x", pauseBetweenMilestones: "no" })).toBe(false);
  });
});

describe("S-207: registered handler forwards pauseBetweenMilestones to the underlying tool", () => {
  it("sf_team_implement.execute passes params.pauseBetweenMilestones into createSfTeamImplement input", async () => {
    // Spy the factory: when the registered tool is invoked, the factory's
    // returned function is called with an input object — we capture that.
    const captured: Array<Record<string, unknown>> = [];
    const fakeHandler = vi.fn(async (input: Record<string, unknown>) => {
      captured.push(input);
      return { slug: input.slug, mode: "single-milestone", milestones: [] };
    });
    const factorySpy = vi
      .spyOn(implementModule, "createSfTeamImplement")
      .mockReturnValue(fakeHandler as never);

    try {
      // Re-register with the spy active.
      const pi = new FakePi();
      sfTeamExtension(pi as never);
      const tool = pi.tools.find((t) => t.name === "sf_team_implement")!;
      const fakeCtx = { hasUI: false, ui: undefined };
      // execute(id, params, signal, onUpdate, ctx)
      await tool.execute("test-id", { slug: "demo-slug", pauseBetweenMilestones: false }, undefined, undefined, fakeCtx);

      expect(fakeHandler).toHaveBeenCalledTimes(1);
      expect(captured[0].slug).toBe("demo-slug");
      expect(captured[0].pauseBetweenMilestones).toBe(false);
      // Production registration MUST NOT inject a default shouldContinue
      // callback (S-206). When the user did not pass one, the input must
      // not have one either.
      expect(captured[0].shouldContinue).toBeUndefined();
    } finally {
      factorySpy.mockRestore();
    }
  });

  it("sf_team_implement output reports plan progress, not only this invocation count", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "ct-registered-progress-"));
    const prevCwd = process.cwd();
    const slug = "demo-slug";
    seedPlanProgress(root, slug);
    const fakeHandler = vi.fn(async () => ({
      slug,
      mode: "single-milestone",
      branch: "implement/demo-slug",
      milestones: [{ id: "M2", approved: true, rounds: 1, commitSha: "def" }],
    }));
    const factorySpy = vi
      .spyOn(implementModule, "createSfTeamImplement")
      .mockReturnValue(fakeHandler as never);

    try {
      process.chdir(root);
      const pi = new FakePi();
      sfTeamExtension(pi as never);
      const tool = pi.tools.find((t) => t.name === "sf_team_implement")!;
      const fakeCtx = { hasUI: false, ui: undefined };
      const response = await tool.execute("test-id", { slug }, undefined, undefined, fakeCtx) as {
        content: Array<{ text: string }>;
      };

      expect(response.content[0].text).toContain("1 milestone(s) approved this run");
      expect(response.content[0].text).toContain("Plan status: 2/3 milestone(s) approved; 1 pending (M3).");
      expect(response.content[0].text).toContain("Next: ask whether to continue with M3.");
      expect(response.content[0].text).not.toContain("1/1 milestone(s)");
    } finally {
      process.chdir(prevCwd);
      factorySpy.mockRestore();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("sf_team_auto.execute passes params.pauseBetweenMilestones into createSfTeamAuto input", async () => {
    const captured: Array<Record<string, unknown>> = [];
    const fakeHandler = vi.fn(async (input: Record<string, unknown>) => {
      captured.push(input);
      return { slug: "x", planRounds: 0, implement: { slug: "x", mode: "all-milestones", milestones: [] } };
    });
    const factorySpy = vi
      .spyOn(autoModule, "createSfTeamAuto")
      .mockReturnValue(fakeHandler as never);

    try {
      const pi = new FakePi();
      sfTeamExtension(pi as never);
      const tool = pi.tools.find((t) => t.name === "sf_team_auto")!;
      const fakeCtx = { hasUI: false, ui: undefined };
      await tool.execute("test-id", { title: "demo", pauseBetweenMilestones: true }, undefined, undefined, fakeCtx);

      expect(fakeHandler).toHaveBeenCalledTimes(1);
      expect(captured[0].title).toBe("demo");
      expect(captured[0].pauseBetweenMilestones).toBe(true);
    } finally {
      factorySpy.mockRestore();
    }
  });

  it("sf_team_implement default registration omits shouldContinue (S-206)", () => {
    // Source-level guard: even WITHOUT spying, the registration body should
    // not contain a literal `shouldContinue:` assignment in the input it
    // forwards. Source is read directly to enforce the contract at PR time.
    const fs = require("node:fs") as typeof import("node:fs");
    const path = require("node:path") as typeof import("node:path");
    const registerSrc = fs.readFileSync(
      path.resolve(new URL(".", import.meta.url).pathname, "..", "src", "register.ts"),
      "utf8",
    );
    // Locate the registerImplementTool body.
    const fnIdx = registerSrc.indexOf("function registerImplementTool");
    expect(fnIdx).toBeGreaterThan(-1);
    const body = registerSrc.slice(fnIdx, fnIdx + 4000);
    // The handler input passed to `await handler({ ... })` must NOT carry
    // a literal `shouldContinue:` — production registration relies on the
    // config knob alone.
    expect(body).not.toMatch(/shouldContinue:\s*[a-zA-Z_]/);
  });
});
