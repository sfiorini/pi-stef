import { describe, expect, it, vi } from "vitest";

import { runResearcher } from "../src/research/run";
import type { AgentRun, AgentTask, TeamMember } from "../src/runtime/types";

function fakeRun(text: string): AgentRun {
  return {
    state: "completed",
    pid: 1,
    parentPid: process.pid,
    childPids: [],
    metrics: { startedAtMs: Date.now() },
    exitCode: 0,
    finalText: text,
    events: [],
    eventsCompacted: false,
    eventSummary: { textDeltaCount: 0, thinkingDeltaCount: 0, compactedEventCount: 0 },
    toolCalls: [],
    stderrTail: "",
  };
}

const member: TeamMember = { role: "researcher", model: "claude-opus-4-7" };

/**
 * Regression replay: this is the exact (trimmed) payload Opus produced on
 * the user's first live `sf_team_plan` run that took 17 minutes and was
 * thrown away by the previous strict schema. Three samples from each
 * array are enough to exercise the tagged-object form.
 */
const REAL_REJECTED_PAYLOAD = JSON.stringify({
  knownFacts: [
    { id: "repo.layout", fact: "pnpm workspace at root" },
    { id: "repo.packages", fact: "packages/: agent-workflows, atlassian, base, ..." },
    { id: "repo.staleArtifacts", fact: "Stray package-lock.json files in 4 packages" },
  ],
  ambiguities: [
    { id: "plan.alreadyAuthored", summary: "A milestone-plan.md already exists" },
    { id: "scope.behaviorPreservation", summary: "M3 could surface backwards-incompatible changes" },
  ],
  openQuestions: [
    {
      id: "executionMode",
      kind: "select",
      title: "Execute existing milestone-plan.md or supersede?",
      options: ["Execute as-is", "Revise", "Supersede", "Audit only"],
    },
    {
      id: "readmeTemplateSections",
      kind: "input",
      title: "Required sections for canonical README template?",
    },
  ],
  external: [],
  notes: "A milestone plan already exists for this brief.",
});

describe("regression: Opus's tagged-object knownFacts/ambiguities now validates", () => {
  it("the exact-shape payload from the user's first-run rejection now produces a non-null analysis", async () => {
    const spawn = vi.fn(async (_m: TeamMember, _t: AgentTask) => fakeRun(REAL_REJECTED_PAYLOAD));
    const result = await runResearcher({
      prompt: "Perform a codebase and documentation cleanup.",
      externalContext: { resolved: [], unresolved: [] },
      researcher: member,
      spawn,
    });
    expect(result).not.toBeNull();
    expect(spawn).toHaveBeenCalledTimes(1); // first attempt validates; no retry needed
    // Tagged objects are normalized to "id: text" strings for downstream consumers.
    expect(result!.knownFacts).toContain("repo.layout: pnpm workspace at root");
    expect(result!.knownFacts).toContain("repo.staleArtifacts: Stray package-lock.json files in 4 packages");
    expect(result!.ambiguities).toContain("plan.alreadyAuthored: A milestone-plan.md already exists");
    // openQuestions structure preserved exactly.
    expect(result!.openQuestions).toHaveLength(2);
    expect(result!.openQuestions[0].kind).toBe("select");
    expect(result!.openQuestions[1].kind).toBe("input");
  });

  it("plain-string form still works (backwards compat)", async () => {
    const plainPayload = JSON.stringify({
      knownFacts: ["plain fact"],
      ambiguities: ["plain ambiguity"],
      openQuestions: [{ id: "q1", kind: "input", title: "Plain?" }],
      external: [],
    });
    const spawn = vi.fn(async () => fakeRun(plainPayload));
    const result = await runResearcher({
      prompt: "x",
      externalContext: { resolved: [], unresolved: [] },
      researcher: member,
      spawn,
    });
    expect(result).not.toBeNull();
    expect(result!.knownFacts).toEqual(["plain fact"]);
    expect(result!.ambiguities).toEqual(["plain ambiguity"]);
  });

  it("payload with extra root field 'confidence' is tolerated (no longer rejects)", async () => {
    const withExtra = JSON.stringify({
      knownFacts: [],
      ambiguities: [],
      openQuestions: [],
      external: [],
      confidence: 0.95,
    });
    const spawn = vi.fn(async () => fakeRun(withExtra));
    const result = await runResearcher({
      prompt: "x",
      externalContext: { resolved: [], unresolved: [] },
      researcher: member,
      spawn,
    });
    expect(result).not.toBeNull();
  });

  it("regression: ambiguities with 'ambiguity' field name (instead of 'summary') still validates and normalizes", async () => {
    // This is the EXACT shape Opus produced on the second live run that
    // the previous schema-loosening did NOT cover (it only allowed `summary`,
    // not `ambiguity`). New schema accepts any object; normalizer extracts
    // whichever string field is present.
    const realPayload = JSON.stringify({
      knownFacts: [
        { id: "monorepo-layout", fact: "pnpm workspace with apps/* and packages/*" },
        { id: "packages-list", fact: "9 packages" },
      ],
      ambiguities: [
        { id: "scope-of-cleanup", ambiguity: "User does not specify aggressiveness threshold." },
        { id: "shell-scripts-fate", ambiguity: "Whether to remove install-*.sh entirely." },
      ],
      openQuestions: [{ id: "q1", kind: "input", title: "Aggressiveness?" }],
      external: [],
      notes: "concrete cleanup candidates: ...",
    });
    const spawn = vi.fn(async () => fakeRun(realPayload));
    const result = await runResearcher({
      prompt: "x",
      externalContext: { resolved: [], unresolved: [] },
      researcher: member,
      spawn,
    });
    expect(result).not.toBeNull();
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(result!.knownFacts).toContain("monorepo-layout: pnpm workspace with apps/* and packages/*");
    // ambiguity field name extracted correctly:
    expect(result!.ambiguities).toContain("scope-of-cleanup: User does not specify aggressiveness threshold.");
    expect(result!.ambiguities).toContain("shell-scripts-fate: Whether to remove install-*.sh entirely.");
  });

  it("body-field probe order: summary wins over fact when both present", async () => {
    const payload = JSON.stringify({
      knownFacts: [{ id: "x", fact: "fact text", summary: "summary text" }],
      ambiguities: [],
      openQuestions: [],
      external: [],
    });
    const spawn = vi.fn(async () => fakeRun(payload));
    const result = await runResearcher({
      prompt: "x",
      externalContext: { resolved: [], unresolved: [] },
      researcher: member,
      spawn,
    });
    expect(result!.knownFacts).toEqual(["x: summary text"]);
  });

  it("secondary catch-all: any non-id/kind/title/url string property is used", async () => {
    const payload = JSON.stringify({
      knownFacts: [{ id: "weird", thingamajig: "some value", count: 42 }],
      ambiguities: [],
      openQuestions: [],
      external: [],
    });
    const spawn = vi.fn(async () => fakeRun(payload));
    const result = await runResearcher({
      prompt: "x",
      externalContext: { resolved: [], unresolved: [] },
      researcher: member,
      spawn,
    });
    expect(result).not.toBeNull();
    expect(result!.knownFacts[0]).toContain("weird:");
    expect(result!.knownFacts[0]).toContain("some value");
  });

  it("final JSON-stringify fallback: object with only non-string fields produces a JSON-encoded string", async () => {
    const payload = JSON.stringify({
      knownFacts: [{ id: "numeric", count: 42, ratio: 0.5 }, { id: "empty" }, {}],
      ambiguities: [],
      openQuestions: [],
      external: [],
    });
    const spawn = vi.fn(async () => fakeRun(payload));
    const result = await runResearcher({
      prompt: "x",
      externalContext: { resolved: [], unresolved: [] },
      researcher: member,
      spawn,
    });
    expect(result).not.toBeNull();
    // For an object with no string body field, normalize falls through to JSON.stringify.
    // Each item still produces a non-empty string; the planner brief just sees the raw shape.
    expect(result!.knownFacts).toHaveLength(3);
    expect(result!.knownFacts[0]).toContain("numeric:");
    expect(result!.knownFacts[0]).toMatch(/\{.*count.*\}/); // includes the JSON-stringified body
    expect(result!.knownFacts[1]).toBe("empty: {\"id\":\"empty\"}");
    expect(result!.knownFacts[2]).toBe("{}"); // bare empty object
  });
});
