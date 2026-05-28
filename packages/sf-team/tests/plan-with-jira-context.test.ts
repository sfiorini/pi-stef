import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import { createSfTeamPlan } from "../src/tools/plan";
import { resolveDefaults } from "../src/config/load";
import { slugify } from "../src/plan/slug";
import type { AgentRun, AgentTask, TeamMember } from "../src/runtime/types";
import type { JiraContextResult } from "../src/research/jira-context";
import { validPlanText } from "./helpers/valid-plan";

const APPROVED = `## Summary
ok
## Findings
### P0
- None.
### P1
- None.
### P2
- None.
### P3
- None.
## Verdict
VERDICT: APPROVED`;

const RESEARCHER_BODY = JSON.stringify({
  knownFacts: ["repo uses pnpm"],
  ambiguities: [],
  openQuestions: [],
  external: [],
});

function makeRepo(): { root: string; dispose: () => void } {
  const root = mkdtempSync(path.join(tmpdir(), "ct-jira-plan-"));
  spawnSync("git", ["init", "-q", "-b", "main"], { cwd: root });
  spawnSync("git", ["config", "user.email", "a@b"], { cwd: root });
  spawnSync("git", ["config", "user.name", "tester"], { cwd: root });
  writeFileSync(path.join(root, "README.md"), "x");
  spawnSync("git", ["add", "."], { cwd: root });
  spawnSync("git", ["commit", "-q", "-m", "init"], { cwd: root });
  mkdirSync(path.join(root, "ai_plan"), { recursive: true });
  return { root, dispose: () => rmSync(root, { recursive: true, force: true }) };
}

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

function jiraUsedResult(keys: string[], markdown: string): JiraContextResult {
  return {
    status: "used",
    detectedKeys: keys,
    confluenceUrls: [],
    fetchedCount: keys.length,
    markdown,
  };
}

function jiraSkippedNoKeys(): JiraContextResult {
  return {
    status: "skipped",
    reason: "no Jira keys detected",
    detectedKeys: [],
    confluenceUrls: [],
    fetchedCount: 0,
    markdown: "",
  };
}

function jiraSkippedNoCreds(detectedKey: string): JiraContextResult {
  return {
    status: "skipped",
    reason: "credentials missing: Atlassian credentials not found",
    detectedKeys: [detectedKey],
    confluenceUrls: [],
    fetchedCount: 0,
    markdown: "",
  };
}

function jiraFailed(detectedKey: string): JiraContextResult {
  return {
    status: "failed",
    reason: `walker error for ${detectedKey}: boom`,
    detectedKeys: [detectedKey],
    confluenceUrls: [],
    fetchedCount: 0,
    markdown: "",
  };
}

describe("sf_team_plan with Atlassian Jira context", () => {
  it("(1) auto policy + Jira key: fetches context, skips researcher, planner brief carries the new section", async () => {
    const { root, dispose } = makeRepo();
    try {
      const captured: { member: TeamMember; task: AgentTask }[] = [];
      const spawnAgent = vi.fn(async (member: TeamMember, task: AgentTask) => {
        captured.push({ member, task });
        if (member.role === "planner") return fakeRun(validPlanText("with-jira"));
        return fakeRun(APPROVED);
      });
      const fetchJiraContext = vi.fn(
        async () => jiraUsedResult(["ABC-123"], "# ABC-123\nRendered ticket details."),
      );
      const runReviewLoop = (await import("../src/review/loop")).runReviewLoop;
      const tool = createSfTeamPlan({
        spawnAgent: spawnAgent as never,
        runReviewLoop,
        fetchJiraContext: fetchJiraContext as never,
      });
      const result = await tool(
        { title: "Fix ABC-123", brief: "Acceptance Criteria:\n- [ ] Resolve ABC-123." },
        { repoRoot: root, configDefaults: resolveDefaults({ performance: { researcher: "auto" } } as never) },
      );

      expect(fetchJiraContext).toHaveBeenCalledTimes(1);
      // Researcher subprocess NOT spawned.
      expect(captured.some((c) => c.member.role === "researcher")).toBe(false);
      // Planner brief contains the Atlassian Ticket Context section.
      const plannerCall = captured.find((c) => c.member.role === "planner")!;
      expect(plannerCall.task.task).toContain("## Atlassian Ticket Context");
      expect(plannerCall.task.task).toContain("Rendered ticket details.");
      // Researcher decision reflects the Jira-context skip reason.
      expect(result.researcherDecision).toMatchObject({ policy: "auto", action: "skipped" });
      expect(result.researcherDecision.reason).toMatch(/jira context/i);
      // jiraContext is exposed on the result.
      expect(result.jiraContext).toBeDefined();
      expect(result.jiraContext?.status).toBe("used");
      expect(result.jiraContext?.detectedKeys).toEqual(["ABC-123"]);
      // Transcript records the Jira fetch.
      const transcriptDir = path.join(root, "ai_plan", slugify("Fix ABC-123"), "transcript", "planning");
      const jiraEntry = readdirSync(transcriptDir).find((n) => n.includes("system-jira-context"));
      expect(jiraEntry).toBeDefined();
      expect(jiraEntry).toMatch(/USED/);
    } finally {
      dispose();
    }
  });

  it("(2) always policy + Jira key: fetches AND runs researcher, planner brief carries both sections", async () => {
    const { root, dispose } = makeRepo();
    try {
      const captured: { member: TeamMember; task: AgentTask }[] = [];
      const spawnAgent = vi.fn(async (member: TeamMember, task: AgentTask) => {
        captured.push({ member, task });
        if (member.role === "researcher") return fakeRun(RESEARCHER_BODY);
        if (member.role === "planner") return fakeRun(validPlanText("always"));
        return fakeRun(APPROVED);
      });
      const fetchJiraContext = vi.fn(
        async () => jiraUsedResult(["ABC-123"], "# ABC-123\nRendered."),
      );
      const runReviewLoop = (await import("../src/review/loop")).runReviewLoop;
      const tool = createSfTeamPlan({
        spawnAgent: spawnAgent as never,
        runReviewLoop,
        fetchJiraContext: fetchJiraContext as never,
      });
      await tool(
        { title: "Fix ABC-123", brief: "Acceptance Criteria:\n- [ ] Resolve ABC-123." },
        { repoRoot: root, configDefaults: resolveDefaults({ performance: { researcher: "always" } } as never) },
      );

      expect(fetchJiraContext).toHaveBeenCalledTimes(1);
      // Researcher DID run.
      expect(captured.some((c) => c.member.role === "researcher")).toBe(true);
      const researcherCall = captured.find((c) => c.member.role === "researcher")!;
      expect(researcherCall.task.task).toContain("## Atlassian Ticket Context");
      expect(researcherCall.task.task).toContain("# ABC-123");
      expect(researcherCall.task.task).toContain("Rendered.");
      expect(researcherCall.task.task).toMatch(/already fetched by the orchestrator/i);
      expect(researcherCall.task.task).toMatch(/do not fetch jira|do not fetch atlassian/i);
      expect(researcherCall.task.task).not.toMatch(/jira:ABC-123[\s\S]*no fetcher configured/);
      // Planner brief contains BOTH sections.
      const plannerCall = captured.find((c) => c.member.role === "planner")!;
      expect(plannerCall.task.task).toContain("## Atlassian Ticket Context");
      expect(plannerCall.task.task).toContain("## Researcher findings");
    } finally {
      dispose();
    }
  });

  it("title-only Jira key: researcher receives fetched Atlassian context", async () => {
    const { root, dispose } = makeRepo();
    try {
      const captured: { member: TeamMember; task: AgentTask }[] = [];
      const spawnAgent = vi.fn(async (member: TeamMember, task: AgentTask) => {
        captured.push({ member, task });
        if (member.role === "researcher") return fakeRun(RESEARCHER_BODY);
        if (member.role === "planner") return fakeRun(validPlanText("title-only"));
        return fakeRun(APPROVED);
      });
      const fetchJiraContext = vi.fn(
        async () => jiraUsedResult(["ABC-123"], "# ABC-123\nFull ticket context."),
      );
      const runReviewLoop = (await import("../src/review/loop")).runReviewLoop;
      const tool = createSfTeamPlan({
        spawnAgent: spawnAgent as never,
        runReviewLoop,
        fetchJiraContext: fetchJiraContext as never,
      });
      await tool(
        { title: "ABC-123" },
        { repoRoot: root, configDefaults: resolveDefaults({ performance: { researcher: "always" } } as never) },
      );

      expect(fetchJiraContext).toHaveBeenCalledTimes(1);
      const researcherCall = captured.find((c) => c.member.role === "researcher")!;
      expect(researcherCall.task.task).toContain("## Atlassian Ticket Context");
      expect(researcherCall.task.task).toContain("Full ticket context.");
      expect(researcherCall.task.task).not.toMatch(/jira:ABC-123[\s\S]*no fetcher configured/);
    } finally {
      dispose();
    }
  });

  it("successful Jira context suppresses duplicate resolved Jira external context", async () => {
    const { root, dispose } = makeRepo();
    try {
      const captured: { member: TeamMember; task: AgentTask }[] = [];
      const spawnAgent = vi.fn(async (member: TeamMember, task: AgentTask) => {
        captured.push({ member, task });
        if (member.role === "researcher") return fakeRun(RESEARCHER_BODY);
        if (member.role === "planner") return fakeRun(validPlanText("dedup"));
        return fakeRun(APPROVED);
      });
      const fetchJiraContext = vi.fn(
        async () => jiraUsedResult(["ABC-123"], "# ABC-123\nAuthoritative Jira context."),
      );
      const externalFetcher = vi.fn(async () => ({
        title: "rough jira",
        content: "ROUGH DUPLICATE JIRA CONTEXT",
      }));
      const runReviewLoop = (await import("../src/review/loop")).runReviewLoop;
      const tool = createSfTeamPlan({
        spawnAgent: spawnAgent as never,
        runReviewLoop,
        fetchJiraContext: fetchJiraContext as never,
      });
      await tool(
        { title: "Fix ABC-123", brief: "Resolve ABC-123", externalFetcher },
        { repoRoot: root, configDefaults: resolveDefaults({ performance: { researcher: "always" } } as never) },
      );

      const researcherCall = captured.find((c) => c.member.role === "researcher")!;
      const plannerCall = captured.find((c) => c.member.role === "planner")!;
      expect(researcherCall.task.task).toContain("Authoritative Jira context.");
      expect(researcherCall.task.task).not.toContain("ROUGH DUPLICATE JIRA CONTEXT");
      expect(plannerCall.task.task).not.toContain("ROUGH DUPLICATE JIRA CONTEXT");
    } finally {
      dispose();
    }
  });

  it("successful Jira context treats an equivalent browse URL as covered before researcher Q&A", async () => {
    const { root, dispose } = makeRepo();
    try {
      const captured: { member: TeamMember; task: AgentTask }[] = [];
      const spawnAgent = vi.fn(async (member: TeamMember, task: AgentTask) => {
        captured.push({ member, task });
        if (member.role === "researcher") return fakeRun(RESEARCHER_BODY);
        if (member.role === "planner") return fakeRun(validPlanText("jira-url-covered"));
        return fakeRun(APPROVED);
      });
      const fetchJiraContext = vi.fn(
        async () => jiraUsedResult(["DIGENG-17720"], "# DIGENG-17720\nAuthoritative Jira context."),
      );
      const runReviewLoop = (await import("../src/review/loop")).runReviewLoop;
      const tool = createSfTeamPlan({
        spawnAgent: spawnAgent as never,
        runReviewLoop,
        fetchJiraContext: fetchJiraContext as never,
      });
      await tool(
        {
          title: "Smoke test Jira URL coverage DIGENG-17720",
          brief: "Smoke test only. Do not implement code. Do not commit. We are testing whether sf_team_auto treats a full Jira browse URL as already covered by Jira context after fetching the same ticket: https://firsthorizon.atlassian.net/browse/DIGENG-17720",
        },
        { repoRoot: root, configDefaults: resolveDefaults({ performance: { researcher: "always" } } as never) },
      );

      expect(fetchJiraContext).toHaveBeenCalledTimes(1);
      const researcherCall = captured.find((c) => c.member.role === "researcher")!;
      expect(researcherCall.task.task).toContain("## Atlassian Ticket Context");
      expect(researcherCall.task.task).toContain("Authoritative Jira context.");
      expect(researcherCall.task.task).not.toMatch(
        /url:https:\/\/firsthorizon\.atlassian\.net\/browse\/DIGENG-17720/,
      );
      expect(researcherCall.task.task).not.toMatch(
        /https:\/\/firsthorizon\.atlassian\.net\/browse\/DIGENG-17720[\s\S]*no fetcher configured/,
      );
    } finally {
      dispose();
    }
  });

  it("successful Jira context treats linked Figma context as covered before researcher Q&A", async () => {
    const { root, dispose } = makeRepo();
    try {
      const captured: { member: TeamMember; task: AgentTask }[] = [];
      const spawnAgent = vi.fn(async (member: TeamMember, task: AgentTask) => {
        captured.push({ member, task });
        if (member.role === "researcher") return fakeRun(RESEARCHER_BODY);
        if (member.role === "planner") return fakeRun(validPlanText("figma-url-covered"));
        return fakeRun(APPROVED);
      });
      const fullFigmaUrl =
        "https://www.figma.com/design/MbfKx4yschBFbwMFpA2Wx8/%F0%9F%91%A4-Profile-Management?node-id=19104-84380&t=sgFm3siYfLJMdiFI-0";
      const promptFigmaUrl =
        "https://www.figma.com/design/MbfKx4yschBFbwMFpA2Wx8/Profile-Management?node-id=19104-84380";
      const fetchJiraContext = vi.fn(
        async () => jiraUsedResult(
          ["DIGENG-16202"],
          [
            "# DIGENG-16202",
            "Authoritative Jira context.",
            "",
            "## Figma Links",
            `- ${fullFigmaUrl}`,
            "",
            "## Linked Figma Context",
            "",
            `### ${fullFigmaUrl}`,
            "",
            "# Figma Overview: Drawer/Account Alerts",
            "",
            "- File key: MbfKx4yschBFbwMFpA2Wx8",
            "- Node ID: 19104:84380",
          ].join("\n"),
        ),
      );
      const runReviewLoop = (await import("../src/review/loop")).runReviewLoop;
      const tool = createSfTeamPlan({
        spawnAgent: spawnAgent as never,
        runReviewLoop,
        fetchJiraContext: fetchJiraContext as never,
      });
      await tool(
        {
          title: "Profile updates DIGENG-16202",
          brief: `Use the linked Figma frame ${promptFigmaUrl}.`,
        },
        { repoRoot: root, configDefaults: resolveDefaults({ performance: { researcher: "always" } } as never) },
      );

      expect(fetchJiraContext).toHaveBeenCalledTimes(1);
      const researcherCall = captured.find((c) => c.member.role === "researcher")!;
      expect(researcherCall.task.task).toContain("## Atlassian Ticket Context");
      expect(researcherCall.task.task).toContain("Figma Overview: Drawer/Account Alerts");
      expect(researcherCall.task.task).not.toMatch(/url:https:\/\/www\.figma\.com\/design\/MbfKx4yschBFbwMFpA2Wx8/);
      expect(researcherCall.task.task).not.toMatch(/figma\.com[\s\S]*no fetcher configured/);
    } finally {
      dispose();
    }
  });

  it("keeps non-Jira URLs unresolved when an equivalent Jira browse URL is covered", async () => {
    const { root, dispose } = makeRepo();
    try {
      const captured: { member: TeamMember; task: AgentTask }[] = [];
      const spawnAgent = vi.fn(async (member: TeamMember, task: AgentTask) => {
        captured.push({ member, task });
        if (member.role === "researcher") return fakeRun(RESEARCHER_BODY);
        if (member.role === "planner") return fakeRun(validPlanText("non-jira-url"));
        return fakeRun(APPROVED);
      });
      const fetchJiraContext = vi.fn(
        async () => jiraUsedResult(["DIGENG-17720"], "# DIGENG-17720\nAuthoritative Jira context."),
      );
      const runReviewLoop = (await import("../src/review/loop")).runReviewLoop;
      const tool = createSfTeamPlan({
        spawnAgent: spawnAgent as never,
        runReviewLoop,
        fetchJiraContext: fetchJiraContext as never,
      });
      await tool(
        {
          title: "Smoke test Jira URL coverage DIGENG-17720",
          brief: "Compare the covered ticket https://firsthorizon.atlassian.net/browse/DIGENG-17720 against the external spec https://example.com/spec.",
        },
        { repoRoot: root, configDefaults: resolveDefaults({ performance: { researcher: "always" } } as never) },
      );

      const researcherCall = captured.find((c) => c.member.role === "researcher")!;
      expect(researcherCall.task.task).not.toMatch(
        /url:https:\/\/firsthorizon\.atlassian\.net\/browse\/DIGENG-17720/,
      );
      expect(researcherCall.task.task).toMatch(/url:https:\/\/example\.com\/spec[\s\S]*no fetcher configured/);
    } finally {
      dispose();
    }
  });

  it("keeps Confluence URLs unresolved even when Jira context covers a ticket key", async () => {
    const { root, dispose } = makeRepo();
    try {
      const captured: { member: TeamMember; task: AgentTask }[] = [];
      const spawnAgent = vi.fn(async (member: TeamMember, task: AgentTask) => {
        captured.push({ member, task });
        if (member.role === "researcher") return fakeRun(RESEARCHER_BODY);
        if (member.role === "planner") return fakeRun(validPlanText("confluence-url"));
        return fakeRun(APPROVED);
      });
      const fetchJiraContext = vi.fn(
        async () => jiraUsedResult(["ABC-123"], "# ABC-123\nAuthoritative Jira context."),
      );
      const runReviewLoop = (await import("../src/review/loop")).runReviewLoop;
      const tool = createSfTeamPlan({
        spawnAgent: spawnAgent as never,
        runReviewLoop,
        fetchJiraContext: fetchJiraContext as never,
      });
      await tool(
        {
          title: "Fix ABC-123",
          brief: "Review ABC-123 and https://firsthorizon.atlassian.net/wiki/spaces/ENG/pages/12345/Spec.",
        },
        { repoRoot: root, configDefaults: resolveDefaults({ performance: { researcher: "always" } } as never) },
      );

      const researcherCall = captured.find((c) => c.member.role === "researcher")!;
      expect(researcherCall.task.task).not.toMatch(/jira:ABC-123[\s\S]*no fetcher configured/);
      expect(researcherCall.task.task).toMatch(
        /confluence:https:\/\/firsthorizon\.atlassian\.net\/wiki\/spaces\/ENG\/pages\/12345\/Spec[\s\S]*no fetcher configured/,
      );
    } finally {
      dispose();
    }
  });

  it("(3) never policy + Jira key: fetches Jira context, no researcher", async () => {
    const { root, dispose } = makeRepo();
    try {
      const captured: { member: TeamMember; task: AgentTask }[] = [];
      const spawnAgent = vi.fn(async (member: TeamMember, task: AgentTask) => {
        captured.push({ member, task });
        if (member.role === "planner") return fakeRun(validPlanText("never"));
        return fakeRun(APPROVED);
      });
      const fetchJiraContext = vi.fn(
        async () => jiraUsedResult(["ABC-123"], "# ABC-123\nRendered."),
      );
      const runReviewLoop = (await import("../src/review/loop")).runReviewLoop;
      const tool = createSfTeamPlan({
        spawnAgent: spawnAgent as never,
        runReviewLoop,
        fetchJiraContext: fetchJiraContext as never,
      });
      await tool(
        { title: "Fix ABC-123", brief: "Acceptance Criteria:\n- [ ] Resolve ABC-123." },
        { repoRoot: root, configDefaults: resolveDefaults({ performance: { researcher: "never" } } as never) },
      );

      expect(fetchJiraContext).toHaveBeenCalledTimes(1);
      expect(captured.some((c) => c.member.role === "researcher")).toBe(false);
      const plannerCall = captured.find((c) => c.member.role === "planner")!;
      expect(plannerCall.task.task).toContain("## Atlassian Ticket Context");
    } finally {
      dispose();
    }
  });

  it("(4) no Jira key in brief: existing behavior preserved, no Jira section, transcript records SKIPPED with no-keys reason", async () => {
    const { root, dispose } = makeRepo();
    try {
      const captured: { member: TeamMember; task: AgentTask }[] = [];
      const spawnAgent = vi.fn(async (member: TeamMember, task: AgentTask) => {
        captured.push({ member, task });
        if (member.role === "planner") return fakeRun(validPlanText("no-jira"));
        return fakeRun(APPROVED);
      });
      const fetchJiraContext = vi.fn(async () => jiraSkippedNoKeys());
      const runReviewLoop = (await import("../src/review/loop")).runReviewLoop;
      const tool = createSfTeamPlan({
        spawnAgent: spawnAgent as never,
        runReviewLoop,
        fetchJiraContext: fetchJiraContext as never,
      });
      await tool(
        { title: "Self Contained", brief: "Acceptance Criteria:\n- [ ] Add the flag.\n\nUse brief as-is." },
        { repoRoot: root, configDefaults: resolveDefaults({ performance: { researcher: "auto" } } as never) },
      );

      expect(fetchJiraContext).toHaveBeenCalledTimes(1);
      const plannerCall = captured.find((c) => c.member.role === "planner")!;
      expect(plannerCall.task.task).not.toContain("## Atlassian Ticket Context");
      const transcriptDir = path.join(root, "ai_plan", slugify("Self Contained"), "transcript", "planning");
      const jiraEntry = readdirSync(transcriptDir).find((n) => n.includes("system-jira-context"));
      expect(jiraEntry).toBeDefined();
      expect(jiraEntry).toMatch(/SKIPPED/);
    } finally {
      dispose();
    }
  });

  it("(5) credentials missing: transcript records SKIPPED, falls through to existing researcher decision, no Jira section in brief", async () => {
    const { root, dispose } = makeRepo();
    try {
      const captured: { member: TeamMember; task: AgentTask }[] = [];
      const spawnAgent = vi.fn(async (member: TeamMember, task: AgentTask) => {
        captured.push({ member, task });
        if (member.role === "researcher") return fakeRun(RESEARCHER_BODY);
        if (member.role === "planner") return fakeRun(validPlanText("no-creds"));
        return fakeRun(APPROVED);
      });
      const fetchJiraContext = vi.fn(async () => jiraSkippedNoCreds("ABC-123"));
      const runReviewLoop = (await import("../src/review/loop")).runReviewLoop;
      const tool = createSfTeamPlan({
        spawnAgent: spawnAgent as never,
        runReviewLoop,
        fetchJiraContext: fetchJiraContext as never,
      });
      const result = await tool(
        { title: "Fix ABC-123", brief: "Resolve ABC-123" },
        { repoRoot: root, configDefaults: resolveDefaults({ performance: { researcher: "auto" } } as never) },
      );

      expect(fetchJiraContext).toHaveBeenCalledTimes(1);
      // Researcher policy fell back to its normal decision (auto + ABC-123 ref → used).
      const researcherCall = captured.find((c) => c.member.role === "researcher")!;
      expect(researcherCall.task.task).not.toContain("## Atlassian Ticket Context");
      const plannerCall = captured.find((c) => c.member.role === "planner")!;
      expect(plannerCall.task.task).not.toContain("## Atlassian Ticket Context");
      // Transcript records SKIPPED with credentials reason.
      const transcriptDir = path.join(root, "ai_plan", slugify("Fix ABC-123"), "transcript", "planning");
      const jiraEntry = readdirSync(transcriptDir).find((n) => n.includes("system-jira-context"));
      expect(jiraEntry).toBeDefined();
      expect(jiraEntry).toMatch(/SKIPPED/);
      const body = readFileSync(path.join(transcriptDir, jiraEntry!), "utf8");
      expect(body).toMatch(/credentials missing/i);
      // jiraContext on result reflects the skipped status.
      expect(result.jiraContext?.status).toBe("skipped");
    } finally {
      dispose();
    }
  });

  it("failed Jira fetch falls back without injecting Atlassian context into researcher task", async () => {
    const { root, dispose } = makeRepo();
    try {
      const captured: { member: TeamMember; task: AgentTask }[] = [];
      const spawnAgent = vi.fn(async (member: TeamMember, task: AgentTask) => {
        captured.push({ member, task });
        if (member.role === "researcher") return fakeRun(RESEARCHER_BODY);
        if (member.role === "planner") return fakeRun(validPlanText("jira-failed"));
        return fakeRun(APPROVED);
      });
      const fetchJiraContext = vi.fn(async () => jiraFailed("ABC-123"));
      const runReviewLoop = (await import("../src/review/loop")).runReviewLoop;
      const tool = createSfTeamPlan({
        spawnAgent: spawnAgent as never,
        runReviewLoop,
        fetchJiraContext: fetchJiraContext as never,
      });
      const result = await tool(
        { title: "Fix ABC-123", brief: "Resolve ABC-123" },
        { repoRoot: root, configDefaults: resolveDefaults({ performance: { researcher: "auto" } } as never) },
      );

      expect(result.jiraContext?.status).toBe("failed");
      const researcherCall = captured.find((c) => c.member.role === "researcher")!;
      expect(researcherCall.task.task).not.toContain("## Atlassian Ticket Context");
    } finally {
      dispose();
    }
  });

  it("with analysisOverride provided: fetchJiraContext is NOT called and jiraContext is undefined on result", async () => {
    const { root, dispose } = makeRepo();
    try {
      const spawnAgent = vi.fn(async (member: TeamMember) => {
        if (member.role === "planner") return fakeRun(validPlanText("override"));
        return fakeRun(APPROVED);
      });
      const fetchJiraContext = vi.fn(async () => jiraSkippedNoKeys());
      const runReviewLoop = (await import("../src/review/loop")).runReviewLoop;
      const tool = createSfTeamPlan({
        spawnAgent: spawnAgent as never,
        runReviewLoop,
        fetchJiraContext: fetchJiraContext as never,
      });
      const result = await tool(
        { title: "Override path", analysisOverride: null, answersOverride: {} },
        { repoRoot: root },
      );

      expect(fetchJiraContext).not.toHaveBeenCalled();
      expect(result.jiraContext).toBeUndefined();
    } finally {
      dispose();
    }
  });
});
