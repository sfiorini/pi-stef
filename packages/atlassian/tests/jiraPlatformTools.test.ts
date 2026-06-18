import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { adfToPlainText, plainTextToAdf } from "../src/text/adf";
import { getJiraIssueContext, renderJiraIssueMarkdown } from "../src/jira/JiraContext";
import { JiraPlatformClient } from "../src/jira/JiraPlatformClient";
import { registerJiraPlatformTools } from "../src/jira/tools";
import { ConfluenceClient } from "../src/confluence/ConfluenceClient";

class RecordingHttp {
  calls: Array<{ method: string; path: string; body?: unknown; query?: Record<string, unknown> }> = [];
  responses: unknown[] = [];
  buffers: Uint8Array[] = [];

  async get<T>(path: string, options: { query?: Record<string, unknown> } = {}): Promise<T> {
    this.calls.push({ method: "GET", path, query: options.query });
    return this.takeResponse() as T;
  }

  async post<T>(path: string, body?: unknown, options: { query?: Record<string, unknown> } = {}): Promise<T> {
    this.calls.push({ method: "POST", path, body, query: options.query });
    return this.takeResponse() as T;
  }

  async put<T>(path: string, body?: unknown, options: { query?: Record<string, unknown> } = {}): Promise<T> {
    this.calls.push({ method: "PUT", path, body, query: options.query });
    return this.takeResponse() as T;
  }

  async delete<T>(path: string, options: { query?: Record<string, unknown> } = {}): Promise<T> {
    this.calls.push({ method: "DELETE", path, query: options.query });
    return this.takeResponse(undefined) as T;
  }

  async getBuffer(path: string): Promise<ArrayBuffer> {
    this.calls.push({ method: "GET_BUFFER", path });
    const value = this.buffers.shift() ?? new Uint8Array();
    const copy = new Uint8Array(value.byteLength);
    copy.set(value);
    return copy.buffer;
  }

  private takeResponse(fallback: unknown = { ok: true }): unknown {
    return this.responses.length ? this.responses.shift() : fallback;
  }
}

class FakePi {
  tools: Array<{ name: string; execute: (_id: string, params: any, signal?: AbortSignal) => Promise<any>; parameters?: unknown }> = [];

  registerTool(tool: { name: string; execute: (_id: string, params: any, signal?: AbortSignal) => Promise<any>; parameters?: unknown }): void {
    this.tools.push(tool);
  }
}

describe("ADF helpers", () => {
  it("converts plain text to Jira ADF and extracts readable text from ADF", () => {
    const adf = plainTextToAdf("Hello\n\nWorld");

    expect(adf).toEqual({
      type: "doc",
      version: 1,
      content: [
        { type: "paragraph", content: [{ type: "text", text: "Hello" }] },
        { type: "paragraph", content: [{ type: "text", text: "World" }] },
      ],
    });
    expect(adfToPlainText({ type: "doc", content: [{ type: "inlineCard", attrs: { url: "https://figma.com/file/abc" } }] })).toBe("https://figma.com/file/abc");
  });
});

describe("JiraPlatformClient", () => {
  it("maps core issue/project/search operations to verified Jira REST v3 endpoints", async () => {
    const http = new RecordingHttp();
    const client = new JiraPlatformClient(http as never);

    await client.listProjects({ query: "app", startAt: 10, maxResults: 50 });
    await client.searchIssues({ jql: "project = ABC", fields: ["summary", "status"], maxResults: 25, nextPageToken: "next" });
    await client.createIssue({ projectKey: "ABC", issueTypeName: "Task", summary: "Build it", description: "Line one" });
    await client.updateIssue({ issueIdOrKey: "ABC-1", summary: "Updated", description: "New text", notifyUsers: false });
    await client.deleteIssue({ issueIdOrKey: "ABC-1", deleteSubtasks: true });
    await client.getIssue({ issueIdOrKey: "ABC-1", fields: ["summary"], expand: ["names", "renderedFields"] });

    expect(http.calls).toEqual([
      { method: "GET", path: "/rest/api/3/project/search", query: { query: "app", startAt: 10, maxResults: 50 } },
      {
        method: "POST",
        path: "/rest/api/3/search/jql",
        body: { jql: "project = ABC", fields: ["summary", "status"], maxResults: 25, nextPageToken: "next" },
        query: undefined,
      },
      {
        method: "POST",
        path: "/rest/api/3/issue",
        body: {
          fields: {
            project: { key: "ABC" },
            issuetype: { name: "Task" },
            summary: "Build it",
            description: plainTextToAdf("Line one"),
          },
        },
        query: undefined,
      },
      {
        method: "PUT",
        path: "/rest/api/3/issue/ABC-1",
        body: { fields: { summary: "Updated", description: plainTextToAdf("New text") } },
        query: { notifyUsers: false },
      },
      { method: "DELETE", path: "/rest/api/3/issue/ABC-1", query: { deleteSubtasks: true } },
      { method: "GET", path: "/rest/api/3/issue/ABC-1", query: { fields: ["summary"], expand: ["names", "renderedFields"] } },
    ]);
  });

  it("maps transitions, comments, worklogs, links, versions, fields, users, and batch helpers", async () => {
    const http = new RecordingHttp();
    const client = new JiraPlatformClient(http as never);

    await client.getTransitions({ issueIdOrKey: "ABC-1" });
    await client.transitionIssue({ issueIdOrKey: "ABC-1", transitionId: "31", comment: "Done" });
    await client.addComment({ issueIdOrKey: "ABC-1", body: "Looks good" });
    await client.getWorklog({ issueIdOrKey: "ABC-1", startAt: 0, maxResults: 5 });
    await client.addWorklog({ issueIdOrKey: "ABC-1", timeSpent: "1h", started: "2026-05-04T09:30:00.000+0000", comment: "Work" });
    await client.getIssueLinkTypes();
    await client.createIssueLink({ typeName: "Blocks", inwardIssueKey: "ABC-1", outwardIssueKey: "ABC-2", comment: "Blocked" });
    await client.removeIssueLink({ linkId: "10001" });
    await client.getProjectVersions({ projectIdOrKey: "ABC", expand: "operations" });
    await client.createVersion({ projectId: 10000, name: "1.0.0" });
    await client.getProjectIssues({ projectIdOrKey: "ABC", fields: ["summary"], maxResults: 10 });
    await client.searchFields({ query: "Acceptance", type: "custom", orderBy: "name" });
    await client.getUserProfile({ accountId: "abc123" });
    await client.batchGetChangelogs({ issueIdsOrKeys: ["ABC-1"], fieldIds: ["status"], maxResults: 20, nextPageToken: "page2" });
    await client.batchCreateIssues({ issues: [{ projectKey: "ABC", issueTypeName: "Bug", summary: "Bug", description: "Broken" }] });
    await client.batchCreateVersions({ versions: [{ projectId: 10000, name: "1.0.1" }, { projectId: 10000, name: "1.0.2" }] });

    expect(http.calls).toEqual([
      { method: "GET", path: "/rest/api/3/issue/ABC-1/transitions", query: undefined },
      {
        method: "POST",
        path: "/rest/api/3/issue/ABC-1/transitions",
        body: { transition: { id: "31" }, update: { comment: [{ add: { body: plainTextToAdf("Done") } }] } },
        query: undefined,
      },
      { method: "POST", path: "/rest/api/3/issue/ABC-1/comment", body: { body: plainTextToAdf("Looks good") }, query: undefined },
      { method: "GET", path: "/rest/api/3/issue/ABC-1/worklog", query: { startAt: 0, maxResults: 5 } },
      {
        method: "POST",
        path: "/rest/api/3/issue/ABC-1/worklog",
        body: { timeSpent: "1h", started: "2026-05-04T09:30:00.000+0000", comment: plainTextToAdf("Work") },
        query: undefined,
      },
      { method: "GET", path: "/rest/api/3/issueLinkType", query: undefined },
      {
        method: "POST",
        path: "/rest/api/3/issueLink",
        body: {
          type: { name: "Blocks" },
          inwardIssue: { key: "ABC-1" },
          outwardIssue: { key: "ABC-2" },
          comment: { body: plainTextToAdf("Blocked") },
        },
        query: undefined,
      },
      { method: "DELETE", path: "/rest/api/3/issueLink/10001", query: undefined },
      { method: "GET", path: "/rest/api/3/project/ABC/versions", query: { expand: "operations" } },
      { method: "POST", path: "/rest/api/3/version", body: { projectId: 10000, name: "1.0.0" }, query: undefined },
      {
        method: "POST",
        path: "/rest/api/3/search/jql",
        body: { jql: 'project = "ABC"', fields: ["summary"], maxResults: 10 },
        query: undefined,
      },
      { method: "GET", path: "/rest/api/3/field/search", query: { query: "Acceptance", type: "custom", orderBy: "name" } },
      { method: "GET", path: "/rest/api/3/user", query: { accountId: "abc123" } },
      {
        method: "POST",
        path: "/rest/api/3/changelog/bulkfetch",
        body: { issueIdsOrKeys: ["ABC-1"], fieldIds: ["status"], maxResults: 20, nextPageToken: "page2" },
        query: undefined,
      },
      {
        method: "POST",
        path: "/rest/api/3/issue/bulk",
        body: { issueUpdates: [{ fields: { project: { key: "ABC" }, issuetype: { name: "Bug" }, summary: "Bug", description: plainTextToAdf("Broken") } }] },
        query: undefined,
      },
      { method: "POST", path: "/rest/api/3/version", body: { projectId: 10000, name: "1.0.1" }, query: undefined },
      { method: "POST", path: "/rest/api/3/version", body: { projectId: 10000, name: "1.0.2" }, query: undefined },
    ]);
  });

  it("validates Jira worklog started timestamps at the tool boundary", async () => {
    const client = new JiraPlatformClient(new RecordingHttp() as never);
    await expect(client.addWorklog({ issueIdOrKey: "ABC-1", timeSpent: "1h", started: "2026-05-04T09:30:00Z" })).rejects.toThrow(
      "YYYY-MM-DDTHH:mm:ss.SSSZ",
    );
  });

  it("downloads issue attachments into a package-local safe output tree with collision suffixes", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "atlassian-attachments-"));
    const http = new RecordingHttp();
    http.responses.push({
      fields: {
        attachment: [
          { id: "10", filename: "design/spec?.png", mimeType: "image/png", size: 3 },
          { id: "11", filename: "design/spec?.png", mimeType: "image/png", size: 4 },
        ],
      },
    });
    http.buffers.push(new TextEncoder().encode("one"), new TextEncoder().encode("two"));
    const client = new JiraPlatformClient(http as never);

    try {
      const result = await client.downloadAttachments({ issueIdOrKey: "ABC-1", outputDir });

      expect(result.attachments.map((attachment) => attachment.filename)).toEqual(["design_spec_.png", "design_spec_-2.png"]);
      expect(result.attachments.every((attachment) => attachment.outputPath.startsWith(outputDir))).toBe(true);
      await expect(readFile(result.attachments[0]!.outputPath, "utf8")).resolves.toBe("one");
      await expect(readFile(result.attachments[1]!.outputPath, "utf8")).resolves.toBe("two");
      expect(http.calls).toEqual([
        { method: "GET", path: "/rest/api/3/issue/ABC-1", query: { fields: ["attachment"] } },
        { method: "GET_BUFFER", path: "/rest/api/3/attachment/content/10" },
        { method: "GET_BUFFER", path: "/rest/api/3/attachment/content/11" },
      ]);
    } finally {
      await rm(outputDir, { recursive: true, force: true });
    }
  });
});

describe("Jira context helpers", () => {
  it("renders compact Jira issue context from v3 issue and comments responses", async () => {
    const client = {
      baseUrl: "https://acme.atlassian.net",
      getIssue: vi.fn(async () => ({
        id: "10001",
        key: "ABC-1",
        fields: {
          summary: "Build context",
          description: plainTextToAdf("Implement with ABC-2 and https://figma.com/file/abc"),
          issuetype: { name: "Story" },
          status: { name: "In Progress" },
          priority: { name: "High" },
          assignee: { displayName: "Ada Lovelace" },
          reporter: { displayName: "Grace Hopper" },
          labels: ["agent"],
          components: [{ name: "Platform" }],
          fixVersions: [{ name: "1.0" }],
          customfield_10000: plainTextToAdf("Acceptance line"),
        },
        names: { customfield_10000: "Acceptance Criteria" },
      })),
      getComments: vi.fn(async () => ({ comments: [{ id: "1", author: { displayName: "Alan" }, created: "2026-05-04", body: plainTextToAdf("See https://acme.atlassian.net/wiki/spaces/ENG/pages/123/Spec") }] })),
    };

    const issue = await getJiraIssueContext({ key: "ABC-1", maxComments: 2 }, client as never);

    expect(issue).toMatchObject({
      key: "ABC-1",
      url: "https://acme.atlassian.net/browse/ABC-1",
      summary: "Build context",
      issueType: "Story",
      status: "In Progress",
      acceptanceCriteria: ["Acceptance line"],
      links: {
        figmaUrls: ["https://figma.com/file/abc"],
        confluenceUrls: ["https://acme.atlassian.net/wiki/spaces/ENG/pages/123/Spec"],
        jiraKeys: ["ABC-1", "ABC-2"],
      },
    });
    expect(renderJiraIssueMarkdown(issue)).toContain("## Acceptance Criteria");
    expect(renderJiraIssueMarkdown(issue)).toContain("## Recent Comments");
  });
});

describe("Jira platform tool registration", () => {
  it("registers all Jira Platform tools plus jira_issue compatibility", async () => {
    const pi = new FakePi();
    const client = new JiraPlatformClient(new RecordingHttp() as never);

    registerJiraPlatformTools(pi as never, { jira: client });

    expect(pi.tools.map((tool) => tool.name)).toEqual([
      "jira_list_projects",
      "jira_search_issues",
      "jira_create_issue",
      "jira_update_issue",
      "jira_delete_issue",
      "jira_get_issue",
      "jira_get_transitions",
      "jira_transition_issue",
      "jira_add_comment",
      "jira_get_worklog",
      "jira_add_worklog",
      "jira_get_issue_link_types",
      "jira_create_issue_link",
      "jira_get_project_versions",
      "jira_create_version",
      "jira_get_project_issues",
      "jira_search_fields",
      "jira_batch_get_changelogs",
      "jira_get_user_profile",
      "jira_download_attachments",
      "jira_batch_create_issues",
      "jira_remove_issue_link",
      "jira_batch_create_versions",
      "jira_issue",
      "story_context",
    ]);
  });

  it("forwards registered tool execution to the Jira client", async () => {
    const pi = new FakePi();
    const jira = { listProjects: vi.fn(async () => ({ values: [] })) };

    registerJiraPlatformTools(pi as never, { jira: jira as never });
    const tool = pi.tools.find((item) => item.name === "jira_list_projects");

    await expect(tool?.execute("call-1", { query: "abc" })).resolves.toMatchObject({ details: { values: [] } });
    expect(jira.listProjects).toHaveBeenCalledWith({ query: "abc", signal: undefined });
  });

  it("jira_issue with includeContext=true does not throw when context options are omitted", async () => {
    const pi = new FakePi();
    const http = new RecordingHttp();
    http.responses.push({ id: "10001", key: "ABC-1", fields: { summary: "Test issue", issuetype: { name: "Story" }, status: { name: "Open" }, description: null, priority: null, assignee: null, reporter: null, labels: [], components: [], fixVersions: [] }, names: {} });
    http.responses.push({ issueLinkTypes: [] });
    http.responses.push({ comments: [] });
    const jira = new JiraPlatformClient(http as never);
    const confluence = new ConfluenceClient(new RecordingHttp() as never);

    registerJiraPlatformTools(pi as never, { jira, confluence });
    const tool = pi.tools.find((item) => item.name === "jira_issue");

    const result = await tool?.execute("call-ctx", { key: "ABC-1", includeContext: true });
    expect(result).toBeDefined();
    expect(result!.content[0].text).toContain("Test issue");
  });

  it("jira_get_issue with includeContext=true does not throw when context options are omitted", async () => {
    const pi = new FakePi();
    const http = new RecordingHttp();
    http.responses.push({ id: "10001", key: "ABC-1", fields: { summary: "Test issue", issuetype: { name: "Story" }, status: { name: "Open" }, description: null, priority: null, assignee: null, reporter: null, labels: [], components: [], fixVersions: [] }, names: {} });
    http.responses.push({ issueLinkTypes: [] });
    http.responses.push({ comments: [] });
    const jira = new JiraPlatformClient(http as never);
    const confluence = new ConfluenceClient(new RecordingHttp() as never);

    registerJiraPlatformTools(pi as never, { jira, confluence });
    const tool = pi.tools.find((item) => item.name === "jira_get_issue");

    const result = await tool?.execute("call-ctx-2", { issueIdOrKey: "ABC-1", includeContext: true });
    expect(result).toBeDefined();
    expect(result!.content[0].text).toContain("Test issue");
  });
});
