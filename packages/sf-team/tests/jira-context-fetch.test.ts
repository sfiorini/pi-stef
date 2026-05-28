import { describe, expect, it, vi } from "vitest";

import type { StoryContext } from "@pi-stef/atlassian";

import { fetchJiraContext } from "../src/research/jira-context";

function fakeStoryContext(key: string): StoryContext {
  return {
    issue: {
      key,
      summary: `Stub summary for ${key}`,
      status: "Open",
      type: "Story",
      assignee: undefined,
      reporter: undefined,
      labels: [],
      components: [],
      links: [],
      remoteLinks: [],
      comments: [],
      description: "",
      acceptanceCriteria: "",
      customFields: {},
      parentKey: undefined,
      subtaskKeys: [],
      linkedKeys: [],
    } as unknown as StoryContext["issue"],
    jiraIssues: [],
    parentIssue: undefined,
    subtaskIssues: [],
    linkedIssueContexts: [],
    confluencePages: [],
    figmaContexts: [],
    designLinks: [],
    externalUrls: [],
    relatedJiraKeys: [],
    inaccessibleLinks: [],
  };
}

describe("fetchJiraContext", () => {
  it("returns status=used with concatenated markdown when keys are detected and walker succeeds", async () => {
    const buildStoryContext = vi.fn(async (opts: { key: string }) => fakeStoryContext(opts.key));
    const renderStoryContextMarkdown = vi.fn((ctx: StoryContext) => `# ${ctx.issue.key}\nrendered`);
    const auth = { getConfig: () => ({ baseUrl: "x", email: "y", apiToken: "z" }) };

    const result = await fetchJiraContext(
      { title: "Fix ABC-123", brief: "see ABC-123 and JRA-1" },
      { auth, buildStoryContext, renderStoryContextMarkdown },
    );

    expect(result.status).toBe("used");
    expect(result.detectedKeys).toEqual(["ABC-123", "JRA-1"]);
    expect(result.fetchedCount).toBe(2);
    expect(result.markdown).toContain("# ABC-123");
    expect(result.markdown).toContain("# JRA-1");
    // Markdown does NOT include the "## Atlassian Ticket Context" wrapper heading;
    // composeEnrichedBrief is the single owner of that heading.
    expect(result.markdown).not.toContain("## Atlassian Ticket Context");
    expect(buildStoryContext).toHaveBeenCalledTimes(2);
  });

  it("returns status=skipped with credentials-missing reason when auth.getConfig throws", async () => {
    const auth = {
      getConfig: () => {
        throw new Error("Atlassian credentials not found");
      },
    };
    const buildStoryContext = vi.fn();

    const result = await fetchJiraContext(
      { title: "Fix ABC-123", brief: "" },
      { auth, buildStoryContext },
    );

    expect(result.status).toBe("skipped");
    expect(result.reason).toMatch(/credentials missing/i);
    expect(result.detectedKeys).toEqual(["ABC-123"]);
    expect(result.markdown).toBe("");
    expect(buildStoryContext).not.toHaveBeenCalled();
  });

  it("returns status=failed with walker reason when buildStoryContext throws", async () => {
    const auth = { getConfig: () => ({ baseUrl: "x", email: "y", apiToken: "z" }) };
    const buildStoryContext = vi.fn(async () => {
      throw new Error("Jira API rejected the request");
    });
    const renderStoryContextMarkdown = vi.fn();

    const result = await fetchJiraContext(
      { title: "Fix ABC-123", brief: "" },
      { auth, buildStoryContext, renderStoryContextMarkdown },
    );

    expect(result.status).toBe("failed");
    expect(result.reason).toMatch(/walker error for ABC-123/i);
    expect(result.detectedKeys).toEqual(["ABC-123"]);
    expect(result.markdown).toBe("");
  });

  it("returns status=skipped with no-keys reason when only Confluence URLs are present", async () => {
    const auth = { getConfig: () => ({ baseUrl: "x", email: "y", apiToken: "z" }) };
    const buildStoryContext = vi.fn();

    const result = await fetchJiraContext(
      {
        title: "Background research",
        brief: "see https://acme.atlassian.net/wiki/spaces/ENG/pages/12345/Title",
      },
      { auth, buildStoryContext },
    );

    expect(result.status).toBe("skipped");
    expect(result.reason).toMatch(/no jira keys/i);
    expect(result.detectedKeys).toEqual([]);
    expect(result.confluenceUrls).toEqual([
      "https://acme.atlassian.net/wiki/spaces/ENG/pages/12345/Title",
    ]);
    expect(buildStoryContext).not.toHaveBeenCalled();
  });

  it("invokes the walker once per detected key in detection order", async () => {
    const auth = { getConfig: () => ({ baseUrl: "x", email: "y", apiToken: "z" }) };
    const buildStoryContext = vi.fn(async (opts: { key: string }) => fakeStoryContext(opts.key));
    const renderStoryContextMarkdown = vi.fn((ctx: StoryContext) => `# ${ctx.issue.key}`);

    const result = await fetchJiraContext(
      { title: "PROJ-9 first, then ABC-123", brief: "more JRA-1 details" },
      { auth, buildStoryContext, renderStoryContextMarkdown },
    );

    expect(result.fetchedCount).toBe(3);
    const calledKeys = buildStoryContext.mock.calls.map((c) => (c[0] as { key: string }).key);
    expect(calledKeys).toEqual(["PROJ-9", "ABC-123", "JRA-1"]);
  });

  it("forwards the input.signal into each buildStoryContext call", async () => {
    const auth = { getConfig: () => ({ baseUrl: "x", email: "y", apiToken: "z" }) };
    const controller = new AbortController();
    const buildStoryContext = vi.fn(async (opts: { key: string; signal?: AbortSignal }) => {
      expect(opts.signal).toBe(controller.signal);
      return fakeStoryContext(opts.key);
    });
    const renderStoryContextMarkdown = vi.fn(() => "rendered");

    await fetchJiraContext(
      { title: "ABC-123", brief: "", signal: controller.signal },
      { auth, buildStoryContext, renderStoryContextMarkdown },
    );

    expect(buildStoryContext).toHaveBeenCalledOnce();
  });
});
