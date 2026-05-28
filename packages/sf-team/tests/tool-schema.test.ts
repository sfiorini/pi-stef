/**
 * Tool-schema shape tests for the post-collapse surface (11 tools: 5
 * `<base>` start + 5 `<base>_resume` + standalone `sf_team_steer`).
 * The legacy throwing aliases that existed under M1 are removed.
 *
 * - Each `<base>` (start) tool's `parameters` is a single Type.Object
 *   with `additionalProperties: false` (the historical anyOf union is
 *   GONE).
 * - Each `<base>_resume` tool's `parameters` is a single Type.Object
 *   that requires `resume`.
 */
import { describe, expect, it } from "vitest";
import { Value } from "typebox/value";

import sfTeamExtension from "../extensions/sf-team";
import { TEAM_BASE_TOOL_NAMES, TEAM_TOOL_NAMES, type TeamBaseToolName } from "../src/register";

class FakePi {
  tools: Array<{ name: string; description: string; parameters: unknown; execute: (...args: any[]) => Promise<any> }> = [];
  registerTool(tool: { name: string; description: string; parameters: unknown; execute: (...args: any[]) => Promise<any> }): void {
    this.tools.push(tool);
  }
  registerCommand(_name: string, _options: unknown): void {}
  sendUserMessage(_content: string): void {}
}

interface ParamSchema {
  type?: string;
  anyOf?: unknown;
  additionalProperties?: boolean;
  required?: string[];
  properties?: Record<string, unknown>;
}

function asSchema(parameters: unknown): ParamSchema {
  return parameters as ParamSchema;
}

const requiredStartKey: Record<TeamBaseToolName, string> = {
  sf_team_plan: "title",
  sf_team_implement: "slug",
  sf_team_task: "title",
  sf_team_auto: "title",
  sf_team_followup: "title",
};

function loadSfTeamPi(): FakePi {
  const pi = new FakePi();
  sfTeamExtension(pi as never);
  return pi;
}

describe("tool-schema: 11-tool post-collapse surface (5 `<base>` + 5 `<base>_resume` + steer)", () => {
  it("registers exactly the 11 tools enumerated by TEAM_TOOL_NAMES (no legacy aliases)", () => {
    const pi = loadSfTeamPi();
    const names = pi.tools.map((t) => t.name);
    expect(names).toEqual([...TEAM_TOOL_NAMES]);
    expect(names).toHaveLength(11);
    for (const base of TEAM_BASE_TOOL_NAMES) {
      expect(names).toContain(base);
      expect(names).toContain(`${base}_resume`);
      // No `_start` suffix anywhere — that was the M1 shape.
      expect(names).not.toContain(`${base}_start`);
    }
  });

  it("each `<base>` (start) schema is a single Type.Object with additionalProperties:false (no anyOf)", () => {
    const pi = loadSfTeamPi();
    for (const base of TEAM_BASE_TOOL_NAMES) {
      const t = pi.tools.find((x) => x.name === base)!;
      const schema = asSchema(t.parameters);
      expect(schema.type, `${base} must be a single object schema`).toBe("object");
      expect(schema.anyOf, `${base} must NOT be an anyOf union`).toBeUndefined();
      expect(schema.additionalProperties).toBe(false);
      const startKey = requiredStartKey[base];
      expect(schema.properties, `${base} must define properties`).toBeDefined();
      expect(schema.properties).toHaveProperty(startKey);
      expect(schema.required ?? []).toContain(startKey);
    }
  });

  it("each `<base>_resume` schema is a single Type.Object that requires `resume`", () => {
    const pi = loadSfTeamPi();
    for (const base of TEAM_BASE_TOOL_NAMES) {
      const resumeName = `${base}_resume`;
      const t = pi.tools.find((x) => x.name === resumeName)!;
      const schema = asSchema(t.parameters);
      expect(schema.type, `${resumeName} must be a single object schema`).toBe("object");
      expect(schema.anyOf, `${resumeName} must NOT be an anyOf union`).toBeUndefined();
      expect(schema.additionalProperties).toBe(false);
      expect(schema.properties).toHaveProperty("resume");
      expect(schema.required ?? []).toContain("resume");
    }
  });

  it("each `<base>` schema accepts the normal input but rejects {} and { resume }", () => {
    const pi = loadSfTeamPi();
    for (const base of TEAM_BASE_TOOL_NAMES) {
      const t = pi.tools.find((x) => x.name === base)!;
      const startKey = requiredStartKey[base];
      const normal: Record<string, unknown> = { [startKey]: "x" };
      expect(Value.Check(t.parameters as never, normal)).toBe(true);
      expect(Value.Check(t.parameters as never, {})).toBe(false);
      expect(Value.Check(t.parameters as never, { resume: "x" })).toBe(false);
    }
  });

  it("each `<base>_resume` schema accepts { resume } but rejects normal start input", () => {
    const pi = loadSfTeamPi();
    for (const base of TEAM_BASE_TOOL_NAMES) {
      const resumeName = `${base}_resume`;
      const t = pi.tools.find((x) => x.name === resumeName)!;
      const startKey = requiredStartKey[base];
      expect(Value.Check(t.parameters as never, { resume: "x" })).toBe(true);
      expect(Value.Check(t.parameters as never, {})).toBe(false);
      expect(Value.Check(t.parameters as never, { [startKey]: "x" })).toBe(false);
    }
  });
});
