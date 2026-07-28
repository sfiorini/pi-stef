import { describe, it, expect } from "vitest";
import { buildImplementReadyMessage, buildAutoReadyMessage, summarizePhaseModels, skillDocPath } from "../src/messages.js";
import type { FlowYaml } from "../src/yaml/schema.js";

describe("buildImplementReadyMessage", () => {
  it("directs the agent to cd into the worktree and read the sf-flow-implement skill file", () => {
    const msg = buildImplementReadyMessage({
      slug: "oauth",
      worktreePath: "/repo/flow-oauth",
      reviewerModel: "anthropic/sonnet-4-6",
      developerModel: "anthropic/sonnet-4-6",
      planPath: "ai_plan/2026-07-20-oauth",
    });
    expect(msg).toContain("cd /repo/flow-oauth");
    expect(msg).toContain(skillDocPath("sf-flow-implement"));
    expect(msg).toContain("sf_flow_finalize");
    expect(msg).toContain("Developer model: anthropic/sonnet-4-6");
  });

  it("notes when a model is inherited (null)", () => {
    const msg = buildImplementReadyMessage({
      slug: "x",
      worktreePath: "/w",
      reviewerModel: null,
      developerModel: null,
      planPath: "ai_plan/x",
    });
    expect(msg).toContain("inherits from parent");
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

  it("renders the generated script block + 7-row model table when script + models are passed", () => {
    const msg = buildAutoReadyMessage({
      workflowName: "ship-feature",
      inputSummary: "prompt: add login",
      resolvedWorkflowPath: "/h/.pi/sf/flow/workflows/ship-feature.yaml",
      script: "phase('plan');\nlog(`INLINE SKILL PHASE: sf-flow-plan.`);",
      models: {
        reviewerModel: "sonnet",
        researcherModel: "haiku",
        developerModel: "opus",
        plannerModel: null,
        auditorModel: null,
        synthModel: null,
        designerModel: null,
      },
    });
    expect(msg).toContain("```js");
    expect(msg).toContain("INLINE SKILL PHASE");
    expect(msg).toContain("run INLINE");
    expect(msg).toContain("write NO code");
    expect(msg).toContain("reviewer: sonnet");
    expect(msg).toContain("developer: opus");
    expect(msg).toContain("planner: (inherit orchestrator)");
    expect(msg).toContain(skillDocPath("sf-flow-auto"));
  });

  it("renders the per-phase model summary and the 'config does not apply to tier-2' note", () => {
    const msg = buildAutoReadyMessage({
      workflowName: "w", inputSummary: "prompt: x",
      resolvedWorkflowPath: "/w.yaml",
      models: { reviewerModel: "rev", researcherModel: "rs", developerModel: "dev", plannerModel: null, auditorModel: null, synthModel: null, designerModel: null },
      phaseModels: [
        { phase: "impl", kind: "tier1-skill", skill: "sf-flow-implement", model: "dev", source: "config (representative role)" },
        { phase: "scan", kind: "tier2-agent", agent: "scanner", model: "haiku", source: "YAML agents.<name>.model" },
      ],
    });
    expect(msg).toContain("Tier-1 config (applies to tier-1 skill phases only");
    expect(msg).toContain("impl (tier1-skill, skill sf-flow-implement): dev");
    expect(msg).toContain("scan (tier2-agent, agent scanner): haiku");
    expect(msg).toContain("config does NOT apply to tier-2 agents");
  });
});

describe("summarizePhaseModels", () => {
  const rawPhaseFlow: FlowYaml = {
    name: "raw-flow",
    description: "flow with a raw phase",
    input: "prompt",
    agents: {},
    phases: [{ id: "myphase", raw: "console.log('hello');" }],
  };

  it("classifies a raw phase as 'other' with no model resolution", () => {
    const summary = summarizePhaseModels(rawPhaseFlow, null);
    expect(summary).toHaveLength(1);
    expect(summary[0]).toMatchObject({
      phase: "myphase",
      kind: "other",
      model: null,
    });
  });

  it("renders a raw phase WITHOUT the tier-2 note in buildAutoReadyMessage", () => {
    const summary = summarizePhaseModels(rawPhaseFlow, null);
    const msg = buildAutoReadyMessage({
      workflowName: "raw-flow",
      inputSummary: "prompt: x",
      resolvedWorkflowPath: "/raw.yaml",
      // A non-null models object is required for the per-phase block to render.
      models: {
        reviewerModel: "rev",
        researcherModel: "rs",
        developerModel: "dev",
        plannerModel: null,
        auditorModel: null,
        synthModel: null,
        designerModel: null,
      },
      phaseModels: summary,
    });
    expect(msg).toContain("myphase");
    expect(msg).toContain("other");
    // The tier-2 note must NOT appear for a raw ("other") phase.
    const myPhaseLine = msg.split("\n").find((l) => l.includes("myphase"));
    expect(myPhaseLine).toBeDefined();
    expect(myPhaseLine).not.toContain("config does NOT apply to tier-2 agents");
  });
});
