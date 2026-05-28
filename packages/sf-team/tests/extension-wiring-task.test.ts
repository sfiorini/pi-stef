import { describe, expect, it } from "vitest";

import sfTeamExtension from "../extensions/sf-team";
import { TEAM_TOOL_NAMES } from "../src/register";

class FakePi {
  tools: Array<{ name: string; description: string; execute: (...args: any[]) => Promise<any>; parameters: unknown }> = [];
  registerTool(tool: { name: string; description: string; execute: (...args: any[]) => Promise<any>; parameters: unknown }): void {
    this.tools.push({ name: tool.name, description: tool.description, execute: tool.execute, parameters: tool.parameters });
  }
  registerCommand(_name: string, _options: unknown): void {}
  sendUserMessage(_content: string): void {}
}

describe("extension wiring: sf_team_plan / sf_team_task surface as `<base>` + `<base>_resume`", () => {
  it("registers all 10 tool names from TEAM_TOOL_NAMES", () => {
    const pi = new FakePi();
    sfTeamExtension(pi as never);
    expect(pi.tools.map((t) => t.name)).toEqual([...TEAM_TOOL_NAMES]);
  });

  it("sf_team_plan and sf_team_task expose tool-specific knobs in their schemas (not stubs)", async () => {
    const pi = new FakePi();
    sfTeamExtension(pi as never);
    const plan = pi.tools.find((t) => t.name === "sf_team_plan");
    expect(plan?.description).not.toMatch(/STUB/i);
    expect(plan?.description).not.toMatch(/not yet implemented/i);
    expect(JSON.stringify(plan?.parameters)).toContain("title");

    const task = pi.tools.find((t) => t.name === "sf_team_task");
    expect(task?.description).not.toMatch(/STUB/i);
    expect(task?.description).not.toMatch(/not yet implemented/i);
    expect(JSON.stringify(task?.parameters)).toContain("allowDirty");
  });

  it("every registered tool has a real description (no STUB markers)", () => {
    const pi = new FakePi();
    sfTeamExtension(pi as never);
    for (const t of pi.tools) {
      expect(t.description).not.toMatch(/STUB/i);
      expect(t.description).not.toMatch(/not yet implemented/i);
    }
  });
});
