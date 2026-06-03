import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";

import { JiraSoftwareClient } from "./JiraSoftwareClient";

export interface JiraSoftwareToolDeps {
  software?: JiraSoftwareClient;
}

const stringArray = Type.Array(Type.String());
const boardType = Type.Union([Type.Literal("scrum"), Type.Literal("kanban"), Type.Literal("simple")]);
const sprintState = Type.Union([Type.Literal("future"), Type.Literal("active"), Type.Literal("closed")]);
const epicLinkMode = Type.Union([Type.Literal("classic"), Type.Literal("team-managed"), Type.Literal("auto")]);

export function registerJiraSoftwareTools(pi: ExtensionAPI, deps: JiraSoftwareToolDeps = {}): void {
  const software = deps.software ?? new JiraSoftwareClient();

  register(pi, "jira_get_agile_boards", "List Jira Software Agile boards.", Type.Object({
    startAt: Type.Optional(Type.Integer({ minimum: 0 })),
    maxResults: Type.Optional(Type.Integer({ minimum: 1 })),
    type: Type.Optional(boardType),
    name: Type.Optional(Type.String()),
    projectKeyOrId: Type.Optional(Type.String()),
    accountIdLocation: Type.Optional(Type.String()),
    projectLocation: Type.Optional(Type.String()),
    includePrivate: Type.Optional(Type.Boolean()),
    negateLocationFiltering: Type.Optional(Type.Boolean()),
    orderBy: Type.Optional(Type.String()),
  }), (params, signal) => software.getAgileBoards({ ...params, signal }));

  register(pi, "jira_create_board", "Create a Jira Software board. When filterId is omitted, this tool creates a Jira filter first using /rest/api/3/filter.", Type.Object({
    name: Type.String(),
    type: Type.Union([Type.Literal("scrum"), Type.Literal("kanban")]),
    filterId: Type.Optional(Type.Integer()),
    filterName: Type.Optional(Type.String()),
    filterJql: Type.Optional(Type.String()),
    filterDescription: Type.Optional(Type.String()),
    filterFavourite: Type.Optional(Type.Boolean()),
  }), (params, signal) => software.createBoard({ ...params, signal }));

  register(pi, "jira_update_board", "unsupported by current Jira Software Cloud REST APIs: board configuration can be read but no documented board name/filter update endpoint exists.", Type.Object({
    boardId: Type.Integer(),
    name: Type.Optional(Type.String()),
    filterId: Type.Optional(Type.Integer()),
  }), (params, signal) => software.updateBoard({ ...params, signal }));

  register(pi, "jira_delete_board", "Delete a Jira Software board.", Type.Object({
    boardId: Type.Integer(),
  }), (params, signal) => software.deleteBoard({ ...params, signal }));

  register(pi, "jira_get_board_issues", "Get issues from a Jira Software board.", Type.Object({
    boardId: Type.Integer(),
    startAt: Type.Optional(Type.Integer({ minimum: 0 })),
    maxResults: Type.Optional(Type.Integer({ minimum: 1 })),
    jql: Type.Optional(Type.String()),
    fields: Type.Optional(stringArray),
    expand: Type.Optional(stringArray),
  }), (params, signal) => software.getBoardIssues({ ...params, signal }));

  register(pi, "jira_get_sprints_from_board", "Get sprints from a Jira Software board.", Type.Object({
    boardId: Type.Integer(),
    startAt: Type.Optional(Type.Integer({ minimum: 0 })),
    maxResults: Type.Optional(Type.Integer({ minimum: 1 })),
    state: Type.Optional(Type.Array(sprintState)),
  }), (params, signal) => software.getSprintsFromBoard({ ...params, signal }));

  register(pi, "jira_get_sprint_issues", "Get issues in a Jira Software sprint.", Type.Object({
    sprintId: Type.Integer(),
    startAt: Type.Optional(Type.Integer({ minimum: 0 })),
    maxResults: Type.Optional(Type.Integer({ minimum: 1 })),
    jql: Type.Optional(Type.String()),
    fields: Type.Optional(stringArray),
    expand: Type.Optional(stringArray),
  }), (params, signal) => software.getSprintIssues({ ...params, signal }));

  register(pi, "jira_link_to_epic", "Link issues to an epic. classic mode uses the Agile epic endpoint; team-managed mode updates fields.parent.key; auto tries classic then falls back.", Type.Object({
    epicIdOrKey: Type.String(),
    issueKeys: stringArray,
    mode: Type.Optional(epicLinkMode),
  }), (params, signal) => software.linkToEpic({ ...params, signal }));

  register(pi, "jira_create_sprint", "Create a Jira Software sprint.", Type.Object({
    name: Type.String(),
    originBoardId: Type.Integer(),
    startDate: Type.Optional(Type.String()),
    endDate: Type.Optional(Type.String()),
    goal: Type.Optional(Type.String()),
  }), (params, signal) => software.createSprint({ ...params, signal }));

  register(pi, "jira_update_sprint", "Update a Jira Software sprint.", Type.Object({
    sprintId: Type.Integer(),
    name: Type.Optional(Type.String()),
    state: Type.Optional(sprintState),
    startDate: Type.Optional(Type.String()),
    endDate: Type.Optional(Type.String()),
    completeDate: Type.Optional(Type.String()),
    originBoardId: Type.Optional(Type.Integer()),
    goal: Type.Optional(Type.String()),
  }), (params, signal) => software.updateSprint({ ...params, signal }));

  register(pi, "jira_delete_sprint", "Delete a Jira Software sprint.", Type.Object({
    sprintId: Type.Integer(),
  }), (params, signal) => software.deleteSprint({ ...params, signal }));

  register(pi, "jira_move_issues_to_sprint", "Move Jira issues to a sprint.", Type.Object({
    sprintId: Type.Integer(),
    issues: stringArray,
    rankBeforeIssue: Type.Optional(Type.String()),
    rankAfterIssue: Type.Optional(Type.String()),
  }), (params, signal) => software.moveIssuesToSprint({ ...params, signal }));

  register(pi, "jira_get_backlog_issues", "Get backlog issues for a Jira Software board.", Type.Object({
    boardId: Type.Integer(),
    startAt: Type.Optional(Type.Integer({ minimum: 0 })),
    maxResults: Type.Optional(Type.Integer({ minimum: 1 })),
    jql: Type.Optional(Type.String()),
    fields: Type.Optional(stringArray),
    expand: Type.Optional(stringArray),
  }), (params, signal) => software.getBacklogIssues({ ...params, signal }));

  register(pi, "jira_rank_backlog_issues", "Rank Jira Software backlog issues.", Type.Object({
    issues: stringArray,
    rankBeforeIssue: Type.Optional(Type.String()),
    rankAfterIssue: Type.Optional(Type.String()),
    rankCustomFieldId: Type.Optional(Type.Integer()),
  }), (params, signal) => software.rankBacklogIssues({ ...params, signal }));

  register(pi, "jira_get_epic_issues", "Get issues assigned to a Jira Software epic.", Type.Object({
    epicIdOrKey: Type.String(),
    startAt: Type.Optional(Type.Integer({ minimum: 0 })),
    maxResults: Type.Optional(Type.Integer({ minimum: 1 })),
    jql: Type.Optional(Type.String()),
    fields: Type.Optional(stringArray),
    expand: Type.Optional(stringArray),
  }), (params, signal) => software.getEpicIssues({ ...params, signal }));
}

type ExecuteFn = (params: any, signal?: AbortSignal) => Promise<unknown>;

function register(pi: ExtensionAPI, name: string, description: string, parameters: unknown, execute: ExecuteFn): void {
  pi.registerTool({
    name,
    label: name,
    description,
    promptSnippet: name === "jira_update_board" ? "Do not use jira_update_board to update boards; Jira Cloud has no documented board update endpoint." : undefined,
    parameters: parameters as never,
    async execute(_toolCallId, params, signal) {
      const result = await execute(params, signal);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        details: result,
      };
    },
  });
}
