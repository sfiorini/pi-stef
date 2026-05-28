import { describe, expect, it } from "vitest";

import sfTeamExtension from "../extensions/sf-team";
import { TEAM_TOOL_NAMES } from "../src/register";

class FakePi {
  tools: Array<{ name: string; description: string; execute: (...args: any[]) => Promise<any> }> = [];
  commands: Array<{ name: string; description?: string; handler: (args: string, ctx: any) => Promise<void> }> = [];
  sentMessages: Array<{ content: string; options?: { deliverAs?: "steer" | "followUp" } }> = [];

  registerTool(tool: { name: string; description: string; execute: (...args: any[]) => Promise<any> }): void {
    this.tools.push({ name: tool.name, description: tool.description, execute: tool.execute });
  }

  registerCommand(name: string, options: { description?: string; handler: (args: string, ctx: any) => Promise<void> }): void {
    this.commands.push({ name, description: options.description, handler: options.handler });
  }

  sendUserMessage(content: string, options?: { deliverAs?: "steer" | "followUp" }): void {
    this.sentMessages.push({ content, options });
  }
}

class FakePiNoCommand {
  tools: Array<{ name: string; description: string; execute: (...args: any[]) => Promise<any> }> = [];
  registerTool(tool: { name: string; description: string; execute: (...args: any[]) => Promise<any> }): void {
    this.tools.push({ name: tool.name, description: tool.description, execute: tool.execute });
  }
  // intentionally no registerCommand / sendUserMessage — emulates older pi
}

class FakePiNoSendUserMessage {
  tools: Array<{ name: string; description: string }> = [];
  commands: Array<{ name: string; handler: (args: string, ctx: any) => Promise<void> }> = [];
  registerTool(tool: { name: string; description: string }): void {
    this.tools.push({ name: tool.name, description: tool.description });
  }
  registerCommand(name: string, options: { handler: (args: string, ctx: any) => Promise<void> }): void {
    this.commands.push({ name, handler: options.handler });
  }
  // no sendUserMessage — handler must fall back to ctx.ui.notify
}

describe("M1 smoke: extension entry registers the production tool surface", () => {
  it("registers all 10 sf_team_* tools (5 base + 5 _resume)", () => {
    const pi = new FakePi();
    sfTeamExtension(pi as never);
    expect(pi.tools.map((t) => t.name)).toEqual([...TEAM_TOOL_NAMES]);
  });

  it("after M12 wiring: NO sf_team_* tool returns 'not yet implemented' (final boundary)", async () => {
    const pi = new FakePi();
    sfTeamExtension(pi as never);
    for (const tool of pi.tools) {
      // Don't actually invoke (would require real spawn). The boundary
      // contract is that the tool's description+schema is real, which the
      // dedicated extension-wiring-final.test.ts covers explicitly.
      expect(tool.description).not.toMatch(/not yet implemented/i);
      expect(tool.description).not.toMatch(/STUB/i);
    }
  });

  it("registers /sf_team_* slash commands so the tools surface in pi's `/` menu", async () => {
    const pi = new FakePi();
    sfTeamExtension(pi as never);
    expect(pi.commands.map((c) => c.name)).toEqual([...TEAM_TOOL_NAMES]);

    // Handler with args + idle agent delegates via sendUserMessage with no
    // delivery mode — same path as natural-language typing.
    const planCmd = pi.commands.find((c) => c.name === "sf_team_plan")!;
    await planCmd.handler("Add OAuth login", { isIdle: () => true });
    expect(pi.sentMessages.at(-1)?.content).toMatch(/sf_team_plan/);
    expect(pi.sentMessages.at(-1)?.content).toMatch(/Add OAuth login/);
    expect(pi.sentMessages.at(-1)?.options).toBeUndefined();

    // Handler with empty args asks the user for input rather than firing blind.
    await planCmd.handler("   ", { isIdle: () => true });
    expect(pi.sentMessages.at(-1)?.content).toMatch(/Ask me first/);

    // Handler while agent is streaming queues with deliverAs: "followUp"
    // so the directive isn't dropped.
    await planCmd.handler("Add metrics", { isIdle: () => false });
    expect(pi.sentMessages.at(-1)?.options).toEqual({ deliverAs: "followUp" });
  });

  it("survives older pi runtimes that don't have registerCommand", () => {
    const pi = new FakePiNoCommand();
    expect(() => sfTeamExtension(pi as never)).not.toThrow();
    expect(pi.tools.map((t) => t.name)).toEqual([...TEAM_TOOL_NAMES]);
  });

  it("falls back to ctx.ui.notify when sendUserMessage is missing", async () => {
    const pi = new FakePiNoSendUserMessage();
    sfTeamExtension(pi as never);
    expect(pi.commands.map((c) => c.name)).toEqual([...TEAM_TOOL_NAMES]);
    const planCmd = pi.commands.find((c) => c.name === "sf_team_plan")!;
    const notifications: Array<{ msg: string; level: string }> = [];
    await planCmd.handler("Add OAuth", {
      ui: { notify: (msg: string, level: string) => notifications.push({ msg, level }) },
      isIdle: () => true,
    });
    expect(notifications).toHaveLength(1);
    expect(notifications[0].msg).toMatch(/can't post.*to the agent/i);
    expect(notifications[0].level).toBe("warning");
  });
});
