import { describe, it, expect } from "vitest";
import { registerGeneratedFlow } from "../src/yaml/register.js";
import type { FlowYaml } from "../src/yaml/schema.js";

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
