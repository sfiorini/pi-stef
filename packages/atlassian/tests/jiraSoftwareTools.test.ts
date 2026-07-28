import { describe, expect, it, vi } from "vitest";

import { JiraSoftwareClient } from "../src/jira/JiraSoftwareClient";
import { registerJiraSoftwareTools } from "../src/jira/softwareTools";

class RecordingHttp {
  calls: Array<{ method: string; path: string; body?: unknown; query?: Record<string, unknown> }> = [];
  responses: Array<unknown | Error> = [];

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

  private takeResponse(fallback: unknown = { ok: true }): unknown {
    const value = this.responses.length ? this.responses.shift() : fallback;
    if (value instanceof Error) throw value;
    return value;
  }
}

class FakePi {
  tools: Array<{ name: string; description?: string; promptSnippet?: string; execute: (_id: string, params: any, signal?: AbortSignal) => Promise<any>; parameters?: unknown }> = [];

  registerTool(tool: { name: string; description?: string; promptSnippet?: string; execute: (_id: string, params: any, signal?: AbortSignal) => Promise<any>; parameters?: unknown }): void {
    this.tools.push(tool);
  }
}

describe("JiraSoftwareClient", () => {
  it("maps board, sprint, backlog, rank, and epic reads to verified Jira Software endpoints", async () => {
    const http = new RecordingHttp();
    const client = new JiraSoftwareClient(http as never);

    await client.getAgileBoards({ projectKeyOrId: "ABC", type: "scrum", startAt: 0, maxResults: 20 });
    await client.createBoard({ name: "ABC board", type: "scrum", filterId: 12345 });
    await client.deleteBoard({ boardId: 7 });
    await client.getBoardIssues({ boardId: 7, jql: "statusCategory != Done", maxResults: 10 });
    await client.getSprintsFromBoard({ boardId: 7, state: ["active", "future"] });
    await client.getSprintIssues({ sprintId: 9, fields: ["summary"], maxResults: 5 });
    await client.createSprint({ name: "Sprint 1", originBoardId: 7, startDate: "2026-05-01T00:00:00.000Z" });
    await client.updateSprint({ sprintId: 9, name: "Sprint 1b", state: "active" });
    await client.deleteSprint({ sprintId: 9 });
    await client.moveIssuesToSprint({ sprintId: 9, issues: ["ABC-1", "ABC-2"] });
    await client.getBacklogIssues({ boardId: 7, maxResults: 8 });
    await client.rankBacklogIssues({ issues: ["ABC-2"], rankBeforeIssue: "ABC-1" });
    await client.getEpicIssues({ epicIdOrKey: "ABC-EPIC", maxResults: 3 });

    expect(http.calls).toEqual([
      { method: "GET", path: "/rest/agile/1.0/board", query: { projectKeyOrId: "ABC", type: "scrum", startAt: 0, maxResults: 20 } },
      { method: "POST", path: "/rest/agile/1.0/board", body: { name: "ABC board", type: "scrum", filterId: 12345 }, query: undefined },
      { method: "DELETE", path: "/rest/agile/1.0/board/7", query: undefined },
      { method: "GET", path: "/rest/agile/1.0/board/7/issue", query: { jql: "statusCategory != Done", maxResults: 10 } },
      { method: "GET", path: "/rest/agile/1.0/board/7/sprint", query: { state: ["active", "future"] } },
      { method: "GET", path: "/rest/agile/1.0/sprint/9/issue", query: { fields: ["summary"], maxResults: 5 } },
      { method: "POST", path: "/rest/agile/1.0/sprint", body: { name: "Sprint 1", originBoardId: 7, startDate: "2026-05-01T00:00:00.000Z" }, query: undefined },
      { method: "PUT", path: "/rest/agile/1.0/sprint/9", body: { name: "Sprint 1b", state: "active" }, query: undefined },
      { method: "DELETE", path: "/rest/agile/1.0/sprint/9", query: undefined },
      { method: "POST", path: "/rest/agile/1.0/sprint/9/issue", body: { issues: ["ABC-1", "ABC-2"] }, query: undefined },
      { method: "GET", path: "/rest/agile/1.0/board/7/backlog", query: { maxResults: 8 } },
      { method: "PUT", path: "/rest/agile/1.0/issue/rank", body: { issues: ["ABC-2"], rankBeforeIssue: "ABC-1" }, query: undefined },
      { method: "GET", path: "/rest/agile/1.0/epic/ABC-EPIC/issue", query: { maxResults: 3 } },
    ]);
  });

  it("creates a Jira filter before creating a board when filterId is omitted", async () => {
    const http = new RecordingHttp();
    http.responses.push({ id: "555" });
    const client = new JiraSoftwareClient(http as never);

    await client.createBoard({ name: "ABC board", type: "kanban", filterName: "ABC board filter", filterJql: "project = ABC" });

    expect(http.calls).toEqual([
      {
        method: "POST",
        path: "/rest/api/3/filter",
        body: { name: "ABC board filter", jql: "project = ABC", description: undefined, favourite: undefined },
        query: undefined,
      },
      { method: "POST", path: "/rest/agile/1.0/board", body: { name: "ABC board", type: "kanban", filterId: 555 }, query: undefined },
    ]);
  });

  it("rejects missing filter ids and accepts numeric filter ids from create-filter responses", async () => {
    const badHttp = new RecordingHttp();
    badHttp.responses.push({ id: null });
    await expect(new JiraSoftwareClient(badHttp as never).createBoard({ name: "Bad board", type: "scrum", filterJql: "project = ABC" })).rejects.toThrow("numeric id");

    const numericHttp = new RecordingHttp();
    numericHttp.responses.push({ id: 777 });
    await new JiraSoftwareClient(numericHttp as never).createBoard({ name: "Good board", type: "scrum", filterJql: "project = ABC" });

    expect(numericHttp.calls.at(-1)).toEqual({
      method: "POST",
      path: "/rest/agile/1.0/board",
      body: { name: "Good board", type: "scrum", filterId: 777 },
      query: undefined,
    });
  });

  it("fails jira_update_board without calling an undocumented board update endpoint", async () => {
    const http = new RecordingHttp();
    const client = new JiraSoftwareClient(http as never);

    await expect(client.updateBoard({ boardId: 7, name: "New name" })).rejects.toThrow("unsupported by current Jira Software Cloud REST APIs");
    expect(http.calls).toEqual([]);
  });

  it("links issues to epics using classic, team-managed, and auto fallback modes", async () => {
    const classicHttp = new RecordingHttp();
    await new JiraSoftwareClient(classicHttp as never).linkToEpic({ epicIdOrKey: "ABC-EPIC", issueKeys: ["ABC-1"], mode: "classic" });

    expect(classicHttp.calls).toEqual([
      { method: "POST", path: "/rest/agile/1.0/epic/ABC-EPIC/issue", body: { issues: ["ABC-1"] }, query: undefined },
    ]);

    const teamHttp = new RecordingHttp();
    await new JiraSoftwareClient(teamHttp as never).linkToEpic({ epicIdOrKey: "ABC-EPIC", issueKeys: ["ABC-1"], mode: "team-managed" });

    expect(teamHttp.calls).toEqual([
      { method: "PUT", path: "/rest/api/3/issue/ABC-1", body: { fields: { parent: { key: "ABC-EPIC" } } }, query: undefined },
    ]);

    const autoHttp = new RecordingHttp();
    autoHttp.responses.push(Object.assign(new Error("Classic epic endpoint rejected"), { status: 404 }));
    await new JiraSoftwareClient(autoHttp as never).linkToEpic({ epicIdOrKey: "ABC-EPIC", issueKeys: ["ABC-1"], mode: "auto" });

    expect(autoHttp.calls).toEqual([
      { method: "POST", path: "/rest/agile/1.0/epic/ABC-EPIC/issue", body: { issues: ["ABC-1"] }, query: undefined },
      { method: "PUT", path: "/rest/api/3/issue/ABC-1", body: { fields: { parent: { key: "ABC-EPIC" } } }, query: undefined },
    ]);
  });

  it("does not auto-fallback to parent writes on authorization failures", async () => {
    const http = new RecordingHttp();
    http.responses.push(Object.assign(new Error("Unauthorized"), { status: 401 }));

    await expect(new JiraSoftwareClient(http as never).linkToEpic({ epicIdOrKey: "ABC-EPIC", issueKeys: ["ABC-1"], mode: "auto" })).rejects.toThrow("Unauthorized");
    expect(http.calls).toEqual([
      { method: "POST", path: "/rest/agile/1.0/epic/ABC-EPIC/issue", body: { issues: ["ABC-1"] }, query: undefined },
    ]);
  });

  it("adds issue context to team-managed partial failures", async () => {
    const http = new RecordingHttp();
    http.responses.push({ ok: true }, new Error("No permission"));

    await expect(new JiraSoftwareClient(http as never).linkToEpic({ epicIdOrKey: "ABC-EPIC", issueKeys: ["ABC-1", "ABC-2"], mode: "team-managed" })).rejects.toThrow(
      "ABC-2",
    );
    await expect(new JiraSoftwareClient(Object.assign(new RecordingHttp(), {
      responses: [Object.assign(new Error("Classic rejected"), { status: 404 }), new Error("Fallback rejected")],
    }) as never).linkToEpic({ epicIdOrKey: "ABC-EPIC", issueKeys: ["ABC-1"], mode: "auto" })).rejects.toThrow("Classic rejected");
  });
});

describe("Jira Software tool registration", () => {
  it("registers all Jira Software Agile tools and documents unsupported board updates", async () => {
    const pi = new FakePi();
    const client = new JiraSoftwareClient(new RecordingHttp() as never);

    registerJiraSoftwareTools(pi as never, { software: client });

    expect(pi.tools.map((tool) => tool.name)).toEqual([
      "jira_get_agile_boards",
      "jira_create_board",
      "jira_update_board",
      "jira_delete_board",
      "jira_get_board_issues",
      "jira_get_sprints_from_board",
      "jira_get_sprint_issues",
      "jira_link_to_epic",
      "jira_create_sprint",
      "jira_update_sprint",
      "jira_delete_sprint",
      "jira_move_issues_to_sprint",
      "jira_get_backlog_issues",
      "jira_rank_backlog_issues",
      "jira_get_epic_issues",
    ]);
    const updateBoard = pi.tools.find((tool) => tool.name === "jira_update_board");
    expect(updateBoard?.description).toContain("unsupported by current Jira Software Cloud REST APIs");
    await expect(updateBoard?.execute("call-1", { boardId: 7, name: "New" })).rejects.toThrow("unsupported");
  });

  it("forwards registered Agile tool execution to the Jira Software client", async () => {
    const pi = new FakePi();
    const software = { getAgileBoards: vi.fn(async () => ({ values: [] })) };

    registerJiraSoftwareTools(pi as never, { software: software as never });
    const tool = pi.tools.find((item) => item.name === "jira_get_agile_boards");

    await expect(tool?.execute("call-1", { projectKeyOrId: "ABC" })).resolves.toMatchObject({ details: { values: [] } });
    expect(software.getAgileBoards).toHaveBeenCalledWith({ projectKeyOrId: "ABC", signal: undefined });
  });

  it("returns a string success message when a void Agile tool receives a 204/undefined response", async () => {
    const pi = new FakePi();
    const http = new RecordingHttp();
    http.responses.push(undefined);
    const client = new JiraSoftwareClient(http as never);

    registerJiraSoftwareTools(pi as never, { software: client });
    const tool = pi.tools.find((item) => item.name === "jira_delete_board")!;

    const result = await tool.execute("call-204", { boardId: 7 });

    expect(typeof result.content[0].text).toBe("string");
    expect(result.content[0].text).toContain("jira_delete_board succeeded");
    expect(result.content[0].text).toContain("7");
    expect(result.details).toBeUndefined();
  });
});
