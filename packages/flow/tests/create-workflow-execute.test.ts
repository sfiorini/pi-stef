import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerSfFlow } from "../src/register.js";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

interface ToolDef {
  name: string;
  parameters: unknown;
  execute: (...args: unknown[]) => Promise<unknown>;
}

function makeFakePi(): { api: ExtensionAPI; toolDefs: ToolDef[]; commands: string[] } {
  const toolDefs: ToolDef[] = [];
  const commands: string[] = [];
  const api = {
    registerTool: vi.fn((def: ToolDef) => toolDefs.push(def)),
    registerCommand: vi.fn((name: string) => commands.push(name)),
    sendUserMessage: vi.fn(),
  } as unknown as ExtensionAPI;
  return { api, toolDefs, commands };
}

function getCreateWorkflow(pi: { api: ExtensionAPI; toolDefs: ToolDef[] }) {
  registerSfFlow(pi.api);
  const tool = pi.toolDefs.find((d) => d.name === "sf_flow_create_workflow");
  if (!tool) throw new Error("sf_flow_create_workflow not registered");
  return tool;
}

let testDir: string;

beforeEach(() => {
  testDir = mkdtempSync(join(tmpdir(), "flow-exec-"));
});

describe("sf_flow_create_workflow execute", () => {
  // Case 1: no params → wizard phase
  it("case 1: no params → wizard (backward-compat no-op)", async () => {
    const pi = makeFakePi();
    const tool = getCreateWorkflow(pi);
    const result = (await tool.execute("id", undefined, undefined, undefined, {
      cwd: testDir,
    })) as { details: { phase: string }; content: { text: string }[] };
    expect(result.details.phase).toBe("wizard");
    expect(result.content[0].text).toContain("read the skill");
  });

  // Case 2: param schema has groups_yaml + overwrite + additionalProperties:false
  it("case 2: parameter schema includes groups_yaml, overwrite, additionalProperties:false", () => {
    const pi = makeFakePi();
    const tool = getCreateWorkflow(pi);
    const params = tool.parameters as {
      properties: Record<string, unknown>;
      additionalProperties: boolean;
    };
    expect(params.properties).toHaveProperty("groups_yaml");
    expect(params.properties).toHaveProperty("overwrite");
    expect(params.additionalProperties).toBe(false);
  });

  // Case 3: Path A — complete valid → done, file written, command registered
  it("case 3: complete valid params → done, file written, command registered", async () => {
    const pi = makeFakePi();
    const tool = getCreateWorkflow(pi);
    const result = (await tool.execute(
      "id",
      {
        name: "my-flow",
        description: "A test flow",
        input: "prompt",
        agents_yaml: "worker:\n  model: haiku",
        phases_yaml: '- id: scan\n  agent: worker\n  prompt: "do stuff"\n  out: results',
      },
      undefined,
      undefined,
      { cwd: testDir },
    )) as { details: { phase: string; created: boolean; name: string }; content: unknown[] };
    expect(result.details.phase).toBe("done");
    expect(result.details.created).toBe(true);
    // File written
    const { existsSync, readFileSync } = await import("node:fs");
    const expectedPath = join(testDir, ".pi", "sf", "flow", "workflows", "my-flow.yaml");
    expect(existsSync(expectedPath)).toBe(true);
    const content = readFileSync(expectedPath, "utf8");
    expect(content).toContain("name: my-flow");
    // Command registered
    expect(pi.commands).toContain("my-flow");
  });

  // Case 4: Path A — complete invalid (phase references nonexistent agent)
  it("case 4: complete invalid (ghost agent) → validation-error, no file written", async () => {
    const pi = makeFakePi();
    const tool = getCreateWorkflow(pi);
    const result = (await tool.execute(
      "id",
      {
        name: "bad-flow",
        description: "A bad flow",
        input: "prompt",
        agents_yaml: "worker:\n  model: haiku",
        phases_yaml: '- id: scan\n  agent: ghost\n  prompt: "do stuff"\n  out: results',
      },
      undefined,
      undefined,
      { cwd: testDir },
    )) as { details: { phase: string; errors: string[] } };
    expect(result.details.phase).toBe("validation-error");
    expect(result.details.errors.length).toBeGreaterThan(0);
    // File NOT written
    const { existsSync } = await import("node:fs");
    const expectedPath = join(testDir, ".pi", "sf", "flow", "workflows", "bad-flow.yaml");
    expect(existsSync(expectedPath)).toBe(false);
  });

  // Case 5: Path B — partial valid (only agents + phases, missing name/description)
  it("case 5: partial valid (agents + phases only) → partial-valid", async () => {
    const pi = makeFakePi();
    const tool = getCreateWorkflow(pi);
    const result = (await tool.execute(
      "id",
      {
        agents_yaml: "worker:\n  model: haiku",
        phases_yaml: '- id: scan\n  agent: worker\n  prompt: "do stuff"\n  out: results',
      },
      undefined,
      undefined,
      { cwd: testDir },
    )) as {
      details: { phase: string; validSections: string[]; missing: string[] };
    };
    expect(result.details.phase).toBe("partial-valid");
    expect(result.details.validSections).toContain("agents");
    expect(result.details.validSections).toContain("phases");
    expect(result.details.missing).toContain("name");
    expect(result.details.missing).toContain("description");
  });

  // Case 6: Path B — partial invalid (invalid agents YAML content)
  it("case 6: partial invalid (agents with bogus field) → validation-error", async () => {
    const pi = makeFakePi();
    const tool = getCreateWorkflow(pi);
    const result = (await tool.execute(
      "id",
      {
        agents_yaml: "worker:\n  bogus_field: true",
      },
      undefined,
      undefined,
      { cwd: testDir },
    )) as { details: { phase: string; errors: string[] } };
    expect(result.details.phase).toBe("validation-error");
    expect(result.details.errors.length).toBeGreaterThan(0);
  });

  // Case 7: YAML parse error
  it("case 7: YAML parse error → parse-error with section", async () => {
    const pi = makeFakePi();
    const tool = getCreateWorkflow(pi);
    const result = (await tool.execute(
      "id",
      {
        agents_yaml: "worker: [unclosed",
      },
      undefined,
      undefined,
      { cwd: testDir },
    )) as { details: { phase: string; section: string; error: string } };
    expect(result.details.phase).toBe("parse-error");
    expect(result.details.section).toBe("agents");
  });

  // Case 8: collision — existing workflow file
  it("case 8: collision with existing workflow → collision phase", async () => {
    const pi = makeFakePi();
    const tool = getCreateWorkflow(pi);
    // Pre-create the file
    const workflowsDir = join(testDir, ".pi", "sf", "flow", "workflows");
    mkdirSync(workflowsDir, { recursive: true });
    writeFileSync(join(workflowsDir, "existing.yaml"), "name: existing\n");

    const result = (await tool.execute(
      "id",
      {
        name: "existing",
        description: "Clash",
        input: "prompt",
        agents_yaml: "w:\n  model: haiku",
        phases_yaml: '- id: p\n  agent: w\n  prompt: "d"\n  out: o',
      },
      undefined,
      undefined,
      { cwd: testDir },
    )) as { details: { phase: string; name: string } };
    expect(result.details.phase).toBe("collision");
    expect(result.details.name).toBe("existing");
  });

  // Case 9: collision + overwrite:true → done
  it("case 9: collision + overwrite:true → done, file overwritten", async () => {
    const pi = makeFakePi();
    const tool = getCreateWorkflow(pi);
    // Pre-create the file
    const workflowsDir = join(testDir, ".pi", "sf", "flow", "workflows");
    mkdirSync(workflowsDir, { recursive: true });
    writeFileSync(join(workflowsDir, "existing.yaml"), "name: existing\n");

    const result = (await tool.execute(
      "id",
      {
        name: "existing",
        description: "Overwritten flow",
        input: "prompt",
        agents_yaml: "w:\n  model: haiku",
        phases_yaml: '- id: p\n  agent: w\n  prompt: "d"\n  out: o',
        overwrite: true,
      },
      undefined,
      undefined,
      { cwd: testDir },
    )) as { details: { phase: string; created: boolean } };
    expect(result.details.phase).toBe("done");
    expect(result.details.created).toBe(true);
  });
});
