import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { Value } from "typebox/value";

import sfTeamExtension from "../extensions/sf-team";
import { TEAM_BASE_TOOL_NAMES, TEAM_TOOL_NAMES } from "../src/register";

class FakePi {
  tools: Array<{ name: string; description: string; parameters: unknown; execute: (...args: any[]) => Promise<any> }> = [];
  registerTool(tool: { name: string; description: string; parameters: unknown; execute: (...args: any[]) => Promise<any> }): void {
    this.tools.push(tool);
  }
  registerCommand(_name: string, _options: unknown): void {}
  sendUserMessage(_content: string): void {}
}

describe("final boundary test (post-collapse): 11-tool surface, real schemas, no legacy aliases", () => {
  it("registers all 11 tool names in the canonical order", () => {
    const pi = new FakePi();
    sfTeamExtension(pi as never);
    expect(pi.tools.map((t) => t.name)).toEqual([...TEAM_TOOL_NAMES]);
  });

  it("none of the registered tools have STUB / 'not yet implemented' descriptions", () => {
    const pi = new FakePi();
    sfTeamExtension(pi as never);
    for (const t of pi.tools) {
      expect(t.description).not.toMatch(/STUB/i);
      expect(t.description).not.toMatch(/not yet implemented/i);
    }
  });

  it("each `<base>` (start) schema exposes the expected required key (no empty placeholders)", () => {
    const pi = new FakePi();
    sfTeamExtension(pi as never);
    const expected: Record<string, string> = {
      sf_team_plan: "title",
      sf_team_implement: "slug",
      sf_team_task: "title",
      sf_team_auto: "title",
      sf_team_followup: "title",
    };
    for (const [name, key] of Object.entries(expected)) {
      const t = pi.tools.find((x) => x.name === name);
      expect(t, `${name} must be registered`).toBeDefined();
      const schemaJson = JSON.stringify(t!.parameters);
      expect(schemaJson, `${name} schema must mention required key ${key}`).toContain(key);
    }
  });

  it("`<base>` and `<base>_resume` schemas are flat single-objects, not anyOf unions", () => {
    const pi = new FakePi();
    sfTeamExtension(pi as never);
    const startInputs: Record<string, Record<string, unknown>> = {
      sf_team_plan: { title: "New plan" },
      sf_team_implement: { slug: "2026-05-06-plan" },
      sf_team_task: { title: "Single task" },
      sf_team_auto: { title: "Auto plan" },
      sf_team_followup: { title: "Followup" },
    };
    for (const [name, normal] of Object.entries(startInputs)) {
      const t = pi.tools.find((x) => x.name === name)!;
      // accepts the flat normal input
      expect(Value.Check(t.parameters as never, normal), `${name} should accept ${JSON.stringify(normal)}`).toBe(true);
      // rejects resume-shaped input on a start tool
      expect(Value.Check(t.parameters as never, { resume: "2026-05-06-plan" }), `${name} should reject resume input`).toBe(false);
      // rejects empty object (the required key is missing)
      expect(Value.Check(t.parameters as never, {}), `${name} should reject {}`).toBe(false);
    }
    for (const base of TEAM_BASE_TOOL_NAMES) {
      const resumeName = `${base}_resume`;
      const t = pi.tools.find((x) => x.name === resumeName)!;
      expect(Value.Check(t.parameters as never, { resume: "2026-05-06-plan" }), `${resumeName} should accept { resume }`).toBe(true);
      // rejects normal start-shaped input on a _resume tool
      expect(Value.Check(t.parameters as never, { title: "x" }), `${resumeName} should reject normal input`).toBe(false);
      // resume key is required
      expect(Value.Check(t.parameters as never, {}), `${resumeName} should reject {}`).toBe(false);
    }
  });

  it("invoking each `<base>` (start) tool in an isolated empty cwd fails fast or aborts (never returns the stub payload)", async () => {
    // CRITICAL: production handlers create worktrees / acquire locks / spawn
    // pi as side effects. To prove the tools are NOT the old stubs without
    // touching the user's real repo, we run each invocation with `chdir` set
    // to an empty tmp dir (no .git, no ai_plan/). Real handlers fail fast at
    // parent-plan-resolution or lock-acquisition; the OLD stubs would
    // succeed instantly with text="not yet implemented" + details.stub=true.
    const isolatedRoot = mkdtempSync(path.join(tmpdir(), "ct-boundary-"));
    const originalCwd = process.cwd();
    process.chdir(isolatedRoot);
    try {
      const pi = new FakePi();
      sfTeamExtension(pi as never);
      const ctrl = new AbortController();
      const fakeCtx = {
        hasUI: false,
        cwd: isolatedRoot,
        ui: {
          confirm: async () => false,
          select: async () => undefined,
          notify: () => undefined,
        },
        sessionManager: {} as never,
        modelRegistry: {} as never,
        isIdle: () => true,
        signal: ctrl.signal,
        abort: () => ctrl.abort(),
        hasPendingMessages: () => false,
        shutdown: () => undefined,
        getContextUsage: () => undefined,
        compact: () => undefined,
        getSystemPrompt: () => "",
      };
      // Only test `<base>` (start) tools — `_resume` requires existing slugs
      // (would fail before reaching the real handler).
      const startTools = pi.tools.filter((t) => !t.name.endsWith("_resume"));
      for (const t of startTools) {
        const minimalParams: Record<string, unknown> = { title: "x", slug: "x", brief: "x" };
        let outcome: unknown;
        try {
          outcome = await Promise.race([
            t.execute("call-1", minimalParams, undefined, undefined, fakeCtx as never),
            new Promise((resolve) => setTimeout(() => resolve({ __timeout: true } as const), 250)),
          ]);
        } catch {
          continue; // real handler threw; not a stub
        }
        if (outcome && typeof outcome === "object" && "__timeout" in outcome) continue;
        const o = outcome as { content?: { text?: string }[]; details?: { stub?: boolean } };
        const text = o?.content?.[0]?.text ?? "";
        expect(text).not.toMatch(/not yet implemented/i);
        expect(o?.details?.stub).not.toBe(true);
      }
      ctrl.abort();
    } finally {
      process.chdir(originalCwd);
      rmSync(isolatedRoot, { recursive: true, force: true });
    }
  }, 10_000);
});
