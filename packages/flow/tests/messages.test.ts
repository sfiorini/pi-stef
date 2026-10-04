import { describe, it, expect } from "vitest";
import { buildImplementReadyMessage, buildAutoReadyMessage, summarizePhaseModels, skillDocPath, type AgentInfoMap } from "../src/messages.js";
import type { AgentFileInfo } from "../src/config/agent-files.js";
import type { FlowYaml } from "../src/yaml/schema.js";

function fakeInfo(over: Partial<AgentFileInfo> = {}): AgentFileInfo {
  return {
    path: "/agents/reviewer.md",
    source: "global",
    frontmatter: { model: "anthropic/claude-sonnet-5-5" },
    ...over,
  };
}

describe("buildImplementReadyMessage", () => {
  it("directs the agent to cd into the worktree and read the sf-flow-implement skill file", () => {
    const msg = buildImplementReadyMessage({
      slug: "oauth",
      worktreePath: "/repo/flow-oauth",
      reviewerInfo: fakeInfo(),
      developerInfo: fakeInfo({ path: "/agents/developer.md" }),
      planPath: "ai_plan/2026-07-20-oauth",
    });
    expect(msg).toContain("cd /repo/flow-oauth");
    expect(msg).toContain(skillDocPath("sf-flow-implement"));
    expect(msg).toContain("sf_flow_finalize");
    // report-only .md lines
    expect(msg).toContain("anthropic/claude-sonnet-5-5");
    expect(msg).toContain("/agents/developer.md");
  });

  it("notes inherit-the-orchestrator when the .md carries no model", () => {
    const msg = buildImplementReadyMessage({
      slug: "x",
      worktreePath: "/w",
      reviewerInfo: fakeInfo({ frontmatter: {} }),
      developerInfo: null,
      planPath: "ai_plan/x",
    });
    expect(msg).toContain("inherits the orchestrator");
    expect(msg).toContain("no .md found");
  });

  it("surfaces a disabled .md (enabled: false)", () => {
    const msg = buildImplementReadyMessage({
      slug: "x",
      worktreePath: "/w",
      reviewerInfo: fakeInfo({ frontmatter: { enabled: false } }),
      developerInfo: null,
      planPath: "ai_plan/x",
    });
    expect(msg).toContain("DISABLED");
  });
});

describe("buildAutoReadyMessage", () => {
  it("directs the agent to read the sf-flow-auto skill file with the resolved path", () => {
    const msg = buildAutoReadyMessage({
      workflowName: "code-review",
      inputSummary: "prompt: review",
      resolvedWorkflowPath: "/h/.pi/sf/flow/workflows/code-review.yaml",
    });
    expect(msg).toContain("code-review");
    expect(msg).toContain("/h/.pi/sf/flow/workflows/code-review.yaml");
    expect(msg).toContain(skillDocPath("sf-flow-auto"));
  });

  it("includes the auto-proceed directive (no halt after tool return, no confirmation)", () => {
    const msg = buildAutoReadyMessage({
      workflowName: "deep-research",
      inputSummary: "prompt: research X",
      resolvedWorkflowPath: "/h/.pi/sf/flow/workflows/deep-research.yaml",
    });
    expect(msg).toContain("Continue executing now — do not stop after this tool returns.");
    expect(msg).toContain("Do not stop after reading the skill.");
    expect(msg).toContain("Do not ask for confirmation.");
    expect(msg).toContain(skillDocPath("sf-flow-auto"));
  });

  it("renders the generated script block and the do-NOT-pass-model directive", () => {
    const msg = buildAutoReadyMessage({
      workflowName: "ship-feature",
      inputSummary: "prompt: add login",
      resolvedWorkflowPath: "/h/.pi/sf/flow/workflows/ship-feature.yaml",
      script: "phase('plan');\nlog(`INLINE SKILL PHASE: sf-flow-plan.`);",
    });
    expect(msg).toContain("```js");
    expect(msg).toContain("INLINE SKILL PHASE");
    expect(msg).toContain("run INLINE");
    expect(msg).toContain("write NO code");
    // THE central directive of the refactor:
    expect(msg).toContain("Do NOT pass a model at dispatch");
    expect(msg).toContain(skillDocPath("sf-flow-auto"));
  });

  it("renders the per-phase report (informational) from the .md files", () => {
    const msg = buildAutoReadyMessage({
      workflowName: "w", inputSummary: "prompt: x",
      resolvedWorkflowPath: "/w.yaml",
      phaseModels: [
        { phase: "impl", kind: "tier1-skill", skill: "sf-flow-implement", model: "dev", source: ".md (global)" },
        { phase: "scan", kind: "tier2-agent", agent: "scanner", model: "haiku", source: ".md (project)" },
      ],
    });
    expect(msg).toContain("Per-phase effective models (informational)");
    expect(msg).toContain("impl (tier1-skill, skill sf-flow-implement): dev");
    expect(msg).toContain("scan (tier2-agent, agent scanner): haiku");
    // the old config-groups table + EXACT-model directive are GONE
    expect(msg).not.toContain("Config model groups");
    expect(msg).not.toContain("EXACT model");
  });

  it("warns when a declared agent has no discoverable .md", () => {
    const msg = buildAutoReadyMessage({
      workflowName: "w", inputSummary: "prompt: x",
      resolvedWorkflowPath: "/w.yaml",
      missingAgents: ["ghost"],
    });
    expect(msg).toContain("No .md found for: ghost");
    expect(msg).toContain("general-purpose");
  });
});

describe("summarizePhaseModels", () => {
  const emptyInfo: AgentInfoMap = new Map();

  it("classifies a raw phase as 'other' with no model resolution", () => {
    const flow: FlowYaml = {
      name: "raw-flow", description: "d", input: "prompt",
      agents: {},
      phases: [{ id: "myphase", raw: "console.log('hello');" }],
    };
    const summary = summarizePhaseModels(flow, emptyInfo);
    expect(summary).toHaveLength(1);
    expect(summary[0]).toMatchObject({ phase: "myphase", kind: "other", model: null });
  });

  it("reports a tier-2 agent's model from its .md (with source)", () => {
    const flow: FlowYaml = {
      name: "t", description: "d", input: "prompt",
      agents: { scanner: {} },
      phases: [{ id: "scan", agent: "scanner", prompt: "go" }],
    };
    const info: AgentInfoMap = new Map([
      ["scanner", fakeInfo({ path: "/proj/.pi/agents/scanner.md", source: "project", frontmatter: { model: "haiku" } })],
    ]);
    const summary = summarizePhaseModels(flow, info);
    expect(summary[0]).toMatchObject({ phase: "scan", kind: "tier2-agent", agent: "scanner", model: "haiku", source: ".md (project)" });
  });

  it("YAML model wins over the .md while the YAML field still exists (M2 transitional)", () => {
    // Differing values on purpose — catches the masked-precedence gap the
    // reviewer found (codegen still bakes def?.model until M3).
    const flow: FlowYaml = {
      name: "t", description: "d", input: "prompt",
      agents: { scanner: { model: "yaml/sc" } },
      phases: [{ id: "scan", agent: "scanner", prompt: "go" }],
    };
    const info: AgentInfoMap = new Map([
      ["scanner", fakeInfo({ frontmatter: { model: "md/sc" } })],
    ]);
    const summary = summarizePhaseModels(flow, info);
    expect(summary[0].model).toBe("yaml/sc");
    expect(summary[0].source).toContain("YAML agents.<name>.model");
  });

  it("classifies a questions phase as tier2-elicitor with the questions agent name", () => {
    const qFlow: FlowYaml = {
      name: "q", description: "d", input: "prompt",
      agents: { elicitor: {} },
      phases: [{ id: "clarify", questions: "elicitor", max_rounds: 5, out: "reqs" }],
    };
    const info: AgentInfoMap = new Map([
      ["elicitor", fakeInfo({ path: "/agents/elicitor.md", frontmatter: { model: "haiku" } })],
    ]);
    const summary = summarizePhaseModels(qFlow, info);
    expect(summary[0]).toMatchObject({ phase: "clarify", kind: "tier2-elicitor", agent: "elicitor", model: "haiku" });
  });

  it("reports inherit-the-orchestrator for an agent with no .md", () => {
    const flow: FlowYaml = {
      name: "t", description: "d", input: "prompt",
      agents: { custom: {} },
      phases: [{ id: "x", agent: "custom", prompt: "go" }],
    };
    const summary = summarizePhaseModels(flow, emptyInfo);
    expect(summary[0].model).toBeNull();
    expect(summary[0].source).toContain("no .md");
  });

  it("reports inherit-the-orchestrator for a .md with no model field", () => {
    const flow: FlowYaml = {
      name: "t", description: "d", input: "prompt",
      agents: { planner: {} },
      phases: [{ id: "plan", agent: "planner", prompt: "go" }],
    };
    const info: AgentInfoMap = new Map([
      ["planner", fakeInfo({ path: "/agents/planner.md", frontmatter: {} })],
    ]);
    const summary = summarizePhaseModels(flow, info);
    expect(summary[0].model).toBeNull();
    expect(summary[0].source).toContain("no model, inherits orchestrator");
  });

  it("surfaces a disabled .md as DISABLED", () => {
    const flow: FlowYaml = {
      name: "t", description: "d", input: "prompt",
      agents: { reviewer: {} },
      phases: [{ id: "rev", agent: "reviewer", prompt: "go" }],
    };
    const info: AgentInfoMap = new Map([
      ["reviewer", fakeInfo({ frontmatter: { model: "a/b", enabled: false } })],
    ]);
    const summary = summarizePhaseModels(flow, info);
    expect(summary[0].model).toBeNull();
    expect(summary[0].source).toContain("DISABLED");
  });

  it("tier-1 skill phases report their representative role agent from the .md", () => {
    const flow: FlowYaml = {
      name: "t", description: "d", input: "prompt",
      agents: {},
      phases: [
        { id: "plan", skill: "sf-flow-plan" },
        { id: "other", skill: "some-other-skill" },
      ],
    };
    const info: AgentInfoMap = new Map([
      ["researcher", fakeInfo({ path: "/agents/researcher.md", frontmatter: { model: "rs-model" } })],
    ]);
    const summary = summarizePhaseModels(flow, info);
    expect(summary[0]).toMatchObject({ phase: "plan", kind: "tier1-skill", model: "rs-model" });
    expect(summary[1]).toMatchObject({ phase: "other", kind: "other", model: null });
  });

  it("renders a raw phase WITHOUT an agent name in buildAutoReadyMessage", () => {
    const flow: FlowYaml = {
      name: "raw-flow", description: "d", input: "prompt",
      agents: {},
      phases: [{ id: "myphase", raw: "console.log('hello');" }],
    };
    const summary = summarizePhaseModels(flow, emptyInfo);
    const msg = buildAutoReadyMessage({
      workflowName: "raw-flow",
      inputSummary: "prompt: x",
      resolvedWorkflowPath: "/raw.yaml",
      phaseModels: summary,
    });
    const myPhaseLine = msg.split("\n").find((l) => l.includes("myphase"));
    expect(myPhaseLine).toBeDefined();
    // A raw phase has no skill/agent — render "(no agent)", never "agent undefined".
    expect(myPhaseLine).toContain("(no agent)");
    expect(myPhaseLine).not.toContain("agent undefined");
  });
});
