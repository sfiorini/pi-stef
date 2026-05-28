import { describe, expect, it } from "vitest";
import {
  IncompatibleModeError,
  PlanRootCreationError,
  PlanRootResolutionError,
  WorkflowMetadataConflictError,
} from "../src/errors";
import { SfTeamToolError } from "../src/errors";

const commonOpts = {
  toolName: "sf_team_plan",
  kind: "plan-root-resolution",
  description: "could not resolve plan root from the given path",
  resumeHint: "Provide a valid aiPlanPath.",
};

describe("PlanRootResolutionError", () => {
  it("extends SfTeamToolError", () => {
    const err = new PlanRootResolutionError(commonOpts);
    expect(err).toBeInstanceOf(SfTeamToolError);
    expect(err).toBeInstanceOf(Error);
  });

  it("message matches FAILED:/RESUME: envelope", () => {
    const err = new PlanRootResolutionError(commonOpts);
    expect(err.message).toMatch(/^FAILED:/);
    expect(err.message).toContain("RESUME:");
  });

  it("name is PlanRootResolutionError", () => {
    expect(new PlanRootResolutionError(commonOpts).name).toBe("PlanRootResolutionError");
  });
});

describe("PlanRootCreationError", () => {
  it("extends SfTeamToolError", () => {
    const err = new PlanRootCreationError({ ...commonOpts, kind: "plan-root-creation", description: "mkdir failed", resumeHint: "Check permissions." });
    expect(err).toBeInstanceOf(SfTeamToolError);
  });

  it("name is PlanRootCreationError", () => {
    expect(new PlanRootCreationError({ ...commonOpts, kind: "plan-root-creation", description: "mkdir failed", resumeHint: "Check permissions." }).name).toBe("PlanRootCreationError");
  });
});

describe("WorkflowMetadataConflictError", () => {
  it("extends SfTeamToolError", () => {
    const err = new WorkflowMetadataConflictError({ ...commonOpts, kind: "workflow-metadata-conflict", description: "persisted gitMode conflicts with prompt", resumeHint: "Omit gitMode or use the same value." });
    expect(err).toBeInstanceOf(SfTeamToolError);
  });

  it("name is WorkflowMetadataConflictError", () => {
    const err = new WorkflowMetadataConflictError({ ...commonOpts, kind: "workflow-metadata-conflict", description: "persisted gitMode conflicts with prompt", resumeHint: "Omit gitMode or use the same value." });
    expect(err.name).toBe("WorkflowMetadataConflictError");
  });
});

describe("IncompatibleModeError", () => {
  it("extends SfTeamToolError", () => {
    const err = new IncompatibleModeError({ ...commonOpts, kind: "incompatible-mode", description: "useWorktree=true + gitMode=off", resumeHint: "Set gitMode=on or useWorktree=false." });
    expect(err).toBeInstanceOf(SfTeamToolError);
  });

  it("message matches FAILED:/RESUME: envelope", () => {
    const err = new IncompatibleModeError({ ...commonOpts, kind: "incompatible-mode", description: "useWorktree=true + gitMode=off", resumeHint: "Set gitMode=on or useWorktree=false." });
    expect(err.message).toMatch(/^FAILED:/);
    expect(err.message).toContain("RESUME:");
  });

  it("name is IncompatibleModeError", () => {
    const err = new IncompatibleModeError({ ...commonOpts, kind: "incompatible-mode", description: "useWorktree=true + gitMode=off", resumeHint: "Set gitMode=on or useWorktree=false." });
    expect(err.name).toBe("IncompatibleModeError");
  });
});
