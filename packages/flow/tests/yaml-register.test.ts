import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { registerGeneratedFlow, registerDiscoveredFlows } from "../src/yaml/register.js";
import type { FlowYaml } from "../src/yaml/schema.js";
import { skillDocPath } from "../src/messages.js";
import { globalWorkflowsDir, projectWorkflowsDir } from "../src/paths.js";

const validFlow: FlowYaml = {
  name: "auth-audit",
  description: "d",
  input: "prompt",
  agents: {},
  phases: [{ id: "p", skill: "sf-flow-plan", out: "x" }],
};

describe("registerGeneratedFlow", () => {
  it("registers a /<name> command that delegates to sf_flow_auto", () => {
    const registered: { name: string; description: string }[] = [];
    const fakePi = {
      registerCommand: (name: string, opts: { description?: string }) => {
        registered.push({ name, description: opts.description ?? "" });
      },
      sendUserMessage: () => {},
    } as any;
    registerGeneratedFlow(fakePi, validFlow);
    expect(registered[0].name).toBe("auth-audit");
    expect(registered[0].description).toBe("d");
  });

  it("generates eagerly so an invalid flow throws at registration", () => {
    const fakePi = { registerCommand: () => {}, sendUserMessage: () => {} } as any;
    expect(() =>
      registerGeneratedFlow(fakePi, {
        name: "bad",
        description: "d",
        input: "prompt" as const,
        agents: {},
        phases: [{ id: "p", prompt: "no run kind" }],
      } as any),
    ).toThrow();
  });

  it("handler sends a sf_flow_auto directive via sendUserMessage when idle", async () => {
    const sent: { content: string; options: unknown }[] = [];
    let captured: ((args: string, ctx: unknown) => Promise<void>) | undefined;
    const fakePi = {
      registerCommand: (_name: string, opts: { handler: (args: string, ctx: unknown) => Promise<void> }) => {
        captured = opts.handler;
      },
      sendUserMessage: (content: string, options?: unknown) => sent.push({ content, options }),
    } as any;
    registerGeneratedFlow(fakePi, validFlow);
    expect(captured).toBeDefined();
    await captured!("do the thing", { isIdle: () => true, ui: { notify: () => {} } } as any);
    expect(sent).toHaveLength(1);
    expect(sent[0].content).toContain('workflow="auth-audit"');
    expect(sent[0].content).toContain('input="do the thing"');
    expect(sent[0].content).toContain(skillDocPath("sf-flow-auto"));
    // idle -> no deliverAs option
    expect(sent[0].options).toBeUndefined();
  });

  it("handler queues as followUp when the agent is busy", async () => {
    const sent: { content: string; options: unknown }[] = [];
    let captured: ((args: string, ctx: unknown) => Promise<void>) | undefined;
    const fakePi = {
      registerCommand: (_name: string, opts: { handler: (args: string, ctx: unknown) => Promise<void> }) => {
        captured = opts.handler;
      },
      sendUserMessage: (content: string, options?: unknown) => sent.push({ content, options }),
    } as any;
    registerGeneratedFlow(fakePi, validFlow);
    await captured!("x", { isIdle: () => false, ui: { notify: () => {} } } as any);
    expect(sent[0].content).toContain(skillDocPath("sf-flow-auto"));
    expect(sent[0].options).toEqual({ deliverAs: "followUp" });
  });

  it("handler falls back to ctx.ui.notify when sendUserMessage is unavailable", async () => {
    const notifications: { msg: string; level: string }[] = [];
    let captured: ((args: string, ctx: unknown) => Promise<void>) | undefined;
    const fakePi = {
      registerCommand: (_name: string, opts: { handler: (args: string, ctx: unknown) => Promise<void> }) => {
        captured = opts.handler;
      },
      // no sendUserMessage
    } as any;
    registerGeneratedFlow(fakePi, validFlow);
    await captured!("x", {
      isIdle: () => true,
      ui: { notify: (msg: string, level: string) => notifications.push({ msg, level }) },
    } as any);
    expect(notifications).toHaveLength(1);
    expect(notifications[0].level).toBe("warning");
    expect(notifications[0].msg).toContain("sf_flow_auto");
  });
});

describe("registerDiscoveredFlows", () => {
  const VALID = (name: string, desc: string) =>
    `name: ${name}\ndescription: ${desc}\ninput: prompt\nagents:\n  worker: {}\nphases:\n  - id: do\n    agent: worker\n`;

  function fakePi() {
    const registered: { name: string; description: string }[] = [];
    return {
      pi: {
        registerCommand: (name: string, opts: { description?: string }) =>
          registered.push({ name, description: opts.description ?? "" }),
        sendUserMessage: () => {},
      } as any,
      registered,
    };
  }

  it("registers a global workflow as a /<name> command", async () => {
    const home = mkdtempSync(join(tmpdir(), "disc-h-"));
    const repo = mkdtempSync(join(tmpdir(), "disc-r-"));
    mkdirSync(globalWorkflowsDir(home), { recursive: true });
    writeFileSync(join(globalWorkflowsDir(home), "code-review.yaml"), VALID("code-review", "global default"));
    const { pi, registered } = fakePi();
    await registerDiscoveredFlows(pi, { repoRoot: repo, home });
    expect(registered).toEqual([{ name: "code-review", description: "global default" }]);
  });

  it("project workflow overrides a global of the same name", async () => {
    const home = mkdtempSync(join(tmpdir(), "disc-h-"));
    const repo = mkdtempSync(join(tmpdir(), "disc-r-"));
    mkdirSync(globalWorkflowsDir(home), { recursive: true });
    writeFileSync(join(globalWorkflowsDir(home), "code-review.yaml"), VALID("code-review", "GLOBAL"));
    mkdirSync(projectWorkflowsDir(repo), { recursive: true });
    writeFileSync(join(projectWorkflowsDir(repo), "code-review.yaml"), VALID("code-review", "PROJECT"));
    const { pi, registered } = fakePi();
    await registerDiscoveredFlows(pi, { repoRoot: repo, home });
    expect(registered).toHaveLength(1);
    expect(registered[0].description).toBe("PROJECT");
  });

  it("skips an invalid workflow but still registers the valid one", async () => {
    const home = mkdtempSync(join(tmpdir(), "disc-h-"));
    const repo = mkdtempSync(join(tmpdir(), "disc-r-"));
    const dir = globalWorkflowsDir(home);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "good.yaml"), VALID("good-flow", "ok"));
    writeFileSync(join(dir, "bad.yaml"), "name: bad\ndescription: d\ninput: prompt\nagents: {}\nphases: []\n");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { pi, registered } = fakePi();
    await registerDiscoveredFlows(pi, { repoRoot: repo, home });
    expect(registered.map((r) => r.name)).toEqual(["good-flow"]);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("no-ops when neither dir exists", async () => {
    const home = mkdtempSync(join(tmpdir(), "disc-h-"));
    const repo = mkdtempSync(join(tmpdir(), "disc-r-"));
    const { pi, registered } = fakePi();
    await registerDiscoveredFlows(pi, { repoRoot: repo, home });
    expect(registered).toEqual([]);
  });
});
