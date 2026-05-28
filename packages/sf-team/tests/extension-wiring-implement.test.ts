import { describe, expect, it } from "vitest";

import sfTeamExtension from "../extensions/sf-team";
import { TEAM_TOOL_NAMES } from "../src/register";

class FakePi {
  tools: Array<{ name: string; description: string; parameters: unknown; execute: (...args: any[]) => Promise<any> }> = [];
  registerTool(tool: { name: string; description: string; parameters: unknown; execute: (...args: any[]) => Promise<any> }): void {
    this.tools.push(tool);
  }
  registerCommand(_name: string, _options: unknown): void {}
  sendUserMessage(_content: string): void {}
}

describe("extension wiring: implement / auto / followup start tools expose their required keys", () => {
  it("sf_team_implement exposes `slug` in its schema", () => {
    const pi = new FakePi();
    sfTeamExtension(pi as never);
    const t = pi.tools.find((x) => x.name === "sf_team_implement");
    expect(t?.description).not.toMatch(/STUB/i);
    expect(t?.description).not.toMatch(/not yet implemented/i);
    expect(JSON.stringify(t?.parameters)).toContain("slug");
  });

  it("sf_team_auto exposes `title` in its schema", () => {
    const pi = new FakePi();
    sfTeamExtension(pi as never);
    const t = pi.tools.find((x) => x.name === "sf_team_auto");
    expect(t?.description).not.toMatch(/STUB/i);
    expect(t?.description).not.toMatch(/not yet implemented/i);
    expect(JSON.stringify(t?.parameters)).toContain("title");
  });

  it("sf_team_followup is a real handler, and every registered start tool has a real description", () => {
    const pi = new FakePi();
    sfTeamExtension(pi as never);
    const followup = pi.tools.find((x) => x.name === "sf_team_followup");
    expect(followup?.description).not.toMatch(/STUB/i);
    expect(followup?.description).not.toMatch(/not yet implemented/i);
    for (const name of [
      "sf_team_plan",
      "sf_team_task",
      "sf_team_implement",
      "sf_team_auto",
      "sf_team_followup",
    ]) {
      const t = pi.tools.find((x) => x.name === name);
      expect(t?.description).not.toMatch(/STUB/i);
      expect(t?.description).not.toMatch(/not yet implemented/i);
    }
  });

  it("instructs the outer assistant to repeat known total cost in its final summary", () => {
    const pi = new FakePi();
    sfTeamExtension(pi as never);
    for (const name of TEAM_TOOL_NAMES) {
      const t = pi.tools.find((x) => x.name === name);
      expect(t?.description, `${name} description`).toContain("Your total cost is");
      expect(t?.description, `${name} description`).toContain("Total cost: $9.99");
      expect(t?.description, `${name} description`).toContain("extract the actual amount");
    }
  });
});
