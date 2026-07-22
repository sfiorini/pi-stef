import { describe, it, expect } from "vitest";
import {
  teamDeprecatedNotice,
  teamDeprecatedDescriptionPrefix,
  prependTeamDeprecationNotice,
} from "../src/deprecation";

describe("team deprecation", () => {
  it("notice names the flow tool for mapped tools", () => {
    expect(teamDeprecatedNotice("sf_team_plan")).toContain("sf_flow_plan (/sf-flow-plan)");
    expect(teamDeprecatedNotice("sf_team_implement")).toContain("sf_flow_implement (/sf-flow-implement)");
    expect(teamDeprecatedNotice("sf_team_auto")).toContain("sf_flow_auto (/sf-flow-auto)");
    expect(teamDeprecatedNotice("sf_team_task")).toContain("sf_flow_auto (/sf-flow-auto)");
    expect(teamDeprecatedNotice("sf_team_followup")).toContain("sf_flow_plan (/sf-flow-plan)");
  });

  it("notice gives prose guidance for resume/steer", () => {
    expect(teamDeprecatedNotice("sf_team_resume")).toContain("sf_flow_implement <slug>");
    expect(teamDeprecatedNotice("sf_team_steer")).toContain("native steering");
  });

  it("description prefix is per-tool for mapped, generic for guidance", () => {
    expect(teamDeprecatedDescriptionPrefix("sf_team_plan")).toBe("[DEPRECATED — use /sf-flow-plan] ");
    expect(teamDeprecatedDescriptionPrefix("sf_team_resume")).toBe("[DEPRECATED — use @pi-stef/flow] ");
    expect(teamDeprecatedDescriptionPrefix("sf_team_steer")).toBe("[DEPRECATED — use @pi-stef/flow] ");
  });

  it("prepend mutates first text content", () => {
    const res = { content: [{ type: "text", text: "sf_team_plan: ok" }], details: {} };
    const out = prependTeamDeprecationNotice("sf_team_plan", res);
    expect(out.content[0].text).toBe(teamDeprecatedNotice("sf_team_plan") + "sf_team_plan: ok");
    expect(out).toBe(res); // same object, mutated
  });
});
