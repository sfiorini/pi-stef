import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";

import { ConfluenceClient } from "../confluence/ConfluenceClient";
import { buildStoryContext, renderStoryContextMarkdown } from "../context/AtlassianContextWalker";
import { getJiraIssueContext, renderJiraIssueMarkdown } from "./JiraContext";
import { JiraPlatformClient } from "./JiraPlatformClient";

export interface JiraPlatformToolDeps {
  jira?: JiraPlatformClient;
  confluence?: ConfluenceClient;
}

const stringArray = Type.Array(Type.String());
const anyRecord = Type.Record(Type.String(), Type.Any());
const contextOptions = {
  includeContext: Type.Optional(Type.Boolean()),
  includeComments: Type.Optional(Type.Boolean()),
  includeConfluence: Type.Optional(Type.Boolean()),
  includeJiraLinks: Type.Optional(Type.Boolean()),
  includeParent: Type.Optional(Type.Boolean()),
  includeSubtasks: Type.Optional(Type.Boolean()),
  includeLinkedIssues: Type.Optional(Type.Boolean()),
  includeRemoteLinks: Type.Optional(Type.Boolean()),
  includeExternalUrls: Type.Optional(Type.Boolean()),
  includeConfluenceChildren: Type.Optional(Type.Boolean()),
  includeFigmaContext: Type.Optional(Type.Boolean()),
  maxComments: Type.Optional(Type.Integer({ minimum: 0 })),
  maxDepth: Type.Optional(Type.Integer({ minimum: 0 })),
  maxConfluencePages: Type.Optional(Type.Integer({ minimum: 0 })),
  maxJiraIssues: Type.Optional(Type.Integer({ minimum: 1 })),
  maxExternalUrls: Type.Optional(Type.Integer({ minimum: 0 })),
  maxChildPages: Type.Optional(Type.Integer({ minimum: 0 })),
  maxFigmaLinks: Type.Optional(Type.Integer({ minimum: 0 })),
  figmaMode: Type.Optional(Type.Union([Type.Literal("overview"), Type.Literal("screen")])),
  figmaMaxScreens: Type.Optional(Type.Integer({ minimum: 0 })),
  figmaMaxDepth: Type.Optional(Type.Integer({ minimum: 0 })),
};

export function registerJiraPlatformTools(pi: ExtensionAPI, deps: JiraPlatformToolDeps = {}): void {
  const jira = deps.jira ?? new JiraPlatformClient();
  const confluence = deps.confluence ?? new ConfluenceClient();

  register(pi, "jira_list_projects", "List Jira projects using REST v3 project search.", Type.Object({
    startAt: Type.Optional(Type.Integer({ minimum: 0 })),
    maxResults: Type.Optional(Type.Integer({ minimum: 1 })),
    orderBy: Type.Optional(Type.String()),
    query: Type.Optional(Type.String()),
    typeKey: Type.Optional(Type.String()),
    categoryId: Type.Optional(Type.Integer()),
    action: Type.Optional(Type.String()),
  }), (params, signal) => jira.listProjects({ ...params, signal }));

  register(pi, "jira_search_issues", "Search Jira issues using enhanced JQL search at /rest/api/3/search/jql with nextPageToken pagination.", Type.Object({
    jql: Type.String(),
    fields: Type.Optional(stringArray),
    expand: Type.Optional(stringArray),
    properties: Type.Optional(stringArray),
    maxResults: Type.Optional(Type.Integer({ minimum: 1 })),
    nextPageToken: Type.Optional(Type.String()),
    fieldsByKeys: Type.Optional(Type.Boolean()),
    reconcileIssues: Type.Optional(Type.Array(Type.Integer())),
  }), (params, signal) => jira.searchIssues({ ...params, signal }));

  register(pi, "jira_create_issue", "Create a Jira issue. Plain-text description is converted to Atlassian Document Format.", Type.Object({
    projectKey: Type.Optional(Type.String()),
    projectId: Type.Optional(Type.Union([Type.String(), Type.Integer()])),
    issueTypeName: Type.Optional(Type.String()),
    issueTypeId: Type.Optional(Type.String()),
    summary: Type.String(),
    description: Type.Optional(Type.Any()),
    fields: Type.Optional(anyRecord),
    update: Type.Optional(anyRecord),
  }), (params, signal) => jira.createIssue({ ...params, signal }));

  register(pi, "jira_update_issue", "Update a Jira issue. Plain-text description is converted to Atlassian Document Format.", Type.Object({
    issueIdOrKey: Type.String(),
    summary: Type.Optional(Type.String()),
    description: Type.Optional(Type.Any()),
    fields: Type.Optional(anyRecord),
    update: Type.Optional(anyRecord),
    notifyUsers: Type.Optional(Type.Boolean()),
    overrideScreenSecurity: Type.Optional(Type.Boolean()),
    overrideEditableFlag: Type.Optional(Type.Boolean()),
  }), (params, signal) => jira.updateIssue({ ...params, signal }));

  register(pi, "jira_delete_issue", "Delete a Jira issue.", Type.Object({
    issueIdOrKey: Type.String(),
    deleteSubtasks: Type.Optional(Type.Boolean()),
  }), (params, signal) => jira.deleteIssue({ ...params, signal }));

  pi.registerTool({
    name: "jira_get_issue",
    label: "jira_get_issue",
    description: "Get a Jira issue by key or ID. Set includeContext=true to return bounded linked Jira/Confluence context.",
    parameters: Type.Object({
    issueIdOrKey: Type.String(),
    fields: Type.Optional(stringArray),
    expand: Type.Optional(stringArray),
    properties: Type.Optional(stringArray),
    fieldsByKeys: Type.Optional(Type.Boolean()),
    updateHistory: Type.Optional(Type.Boolean()),
      ...contextOptions,
    }),
    async execute(_toolCallId, params, signal): Promise<any> {
      if (params.includeContext) {
        const context = await buildStoryContext({ ...pickContextOptions(params), key: params.issueIdOrKey, signal }, { jira, confluence });
        return { content: [{ type: "text", text: renderStoryContextMarkdown(context) }], details: context };
      }
      const { includeContext, includeComments, includeConfluence, includeJiraLinks, includeParent, includeSubtasks, includeLinkedIssues, includeRemoteLinks, includeExternalUrls, includeConfluenceChildren, includeFigmaContext, maxComments, maxDepth, maxConfluencePages, maxJiraIssues, maxExternalUrls, maxChildPages, maxFigmaLinks, figmaMode, figmaMaxScreens, figmaMaxDepth, ...rawParams } = params;
      const result = await jira.getIssue({ ...rawParams, signal });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], details: result };
    },
  });

  register(pi, "jira_get_transitions", "Get available transitions for a Jira issue.", Type.Object({
    issueIdOrKey: Type.String(),
    transitionId: Type.Optional(Type.String()),
    includeUnavailableTransitions: Type.Optional(Type.Boolean()),
    skipRemoteOnlyCondition: Type.Optional(Type.Boolean()),
  }), (params, signal) => jira.getTransitions({ ...params, signal }));

  register(pi, "jira_transition_issue", "Transition a Jira issue. Optional plain-text comment is converted to Atlassian Document Format.", Type.Object({
    issueIdOrKey: Type.String(),
    transitionId: Type.String(),
    fields: Type.Optional(anyRecord),
    update: Type.Optional(anyRecord),
    historyMetadata: Type.Optional(anyRecord),
    comment: Type.Optional(Type.Any()),
  }), (params, signal) => jira.transitionIssue({ ...params, signal }));

  register(pi, "jira_add_comment", "Add a Jira issue comment. Plain text is converted to Atlassian Document Format.", Type.Object({
    issueIdOrKey: Type.String(),
    body: Type.Any(),
    visibility: Type.Optional(anyRecord),
    properties: Type.Optional(Type.Array(Type.Any())),
  }), (params, signal) => jira.addComment({ ...params, signal }));

  register(pi, "jira_get_worklog", "Get worklogs for a Jira issue.", Type.Object({
    issueIdOrKey: Type.String(),
    startAt: Type.Optional(Type.Integer({ minimum: 0 })),
    maxResults: Type.Optional(Type.Integer({ minimum: 1 })),
    startedAfter: Type.Optional(Type.Integer()),
    startedBefore: Type.Optional(Type.Integer()),
    expand: Type.Optional(stringArray),
  }), (params, signal) => jira.getWorklog({ ...params, signal }));

  register(pi, "jira_add_worklog", "Add a Jira worklog. started must look like 2026-05-04T09:30:00.000+0000.", Type.Object({
    issueIdOrKey: Type.String(),
    timeSpent: Type.Optional(Type.String()),
    timeSpentSeconds: Type.Optional(Type.Integer({ minimum: 0 })),
    started: Type.String(),
    comment: Type.Optional(Type.Any()),
    adjustEstimate: Type.Optional(Type.String()),
    newEstimate: Type.Optional(Type.String()),
    reduceBy: Type.Optional(Type.String()),
  }), (params, signal) => jira.addWorklog({ ...params, signal }));

  register(pi, "jira_get_issue_link_types", "Get Jira issue link types.", Type.Object({}), (_params, signal) => jira.getIssueLinkTypes({ signal }));

  register(pi, "jira_create_issue_link", "Create a Jira issue link.", Type.Object({
    typeName: Type.Optional(Type.String()),
    typeId: Type.Optional(Type.String()),
    inwardIssueKey: Type.String(),
    outwardIssueKey: Type.String(),
    comment: Type.Optional(Type.Any()),
  }), (params, signal) => jira.createIssueLink({ ...params, signal }));

  register(pi, "jira_get_project_versions", "Get project versions.", Type.Object({
    projectIdOrKey: Type.String(),
    expand: Type.Optional(Type.String()),
  }), (params, signal) => jira.getProjectVersions({ ...params, signal }));

  register(pi, "jira_create_version", "Create a project version.", Type.Object({
    projectId: Type.Optional(Type.Integer()),
    project: Type.Optional(Type.String()),
    name: Type.String(),
    description: Type.Optional(Type.String()),
    archived: Type.Optional(Type.Boolean()),
    released: Type.Optional(Type.Boolean()),
    releaseDate: Type.Optional(Type.String()),
    startDate: Type.Optional(Type.String()),
  }), (params, signal) => jira.createVersion({ ...params, signal }));

  register(pi, "jira_get_project_issues", "Search issues in a project using enhanced JQL search.", Type.Object({
    projectIdOrKey: Type.String(),
    fields: Type.Optional(stringArray),
    maxResults: Type.Optional(Type.Integer({ minimum: 1 })),
    nextPageToken: Type.Optional(Type.String()),
  }), (params, signal) => jira.getProjectIssues({ ...params, signal }));

  register(pi, "jira_search_fields", "Search Jira fields.", Type.Object({
    startAt: Type.Optional(Type.Integer({ minimum: 0 })),
    maxResults: Type.Optional(Type.Integer({ minimum: 1 })),
    type: Type.Optional(Type.String()),
    id: Type.Optional(stringArray),
    query: Type.Optional(Type.String()),
    orderBy: Type.Optional(Type.String()),
    expand: Type.Optional(stringArray),
  }), (params, signal) => jira.searchFields({ ...params, signal }));

  register(pi, "jira_batch_get_changelogs", "Bulk fetch changelogs for Jira issues using /rest/api/3/changelog/bulkfetch.", Type.Object({
    issueIdsOrKeys: stringArray,
    fieldIds: Type.Optional(stringArray),
    maxResults: Type.Optional(Type.Integer({ minimum: 1 })),
    nextPageToken: Type.Optional(Type.String()),
  }), (params, signal) => jira.batchGetChangelogs({ ...params, signal }));

  register(pi, "jira_get_user_profile", "Get a Jira user profile.", Type.Object({
    accountId: Type.Optional(Type.String()),
    username: Type.Optional(Type.String()),
    key: Type.Optional(Type.String()),
    expand: Type.Optional(Type.String()),
  }), (params, signal) => jira.getUserProfile({ ...params, signal }));

  register(pi, "jira_download_attachments", "Download Jira issue attachments to a package-local runtime directory by default.", Type.Object({
    issueIdOrKey: Type.Optional(Type.String()),
    attachmentIds: Type.Optional(stringArray),
    outputDir: Type.Optional(Type.String()),
  }), (params, signal) => jira.downloadAttachments({ ...params, signal }));

  register(pi, "jira_batch_create_issues", "Create multiple Jira issues. Plain-text descriptions are converted to Atlassian Document Format.", Type.Object({
    issues: Type.Array(Type.Object({
      projectKey: Type.Optional(Type.String()),
      projectId: Type.Optional(Type.Union([Type.String(), Type.Integer()])),
      issueTypeName: Type.Optional(Type.String()),
      issueTypeId: Type.Optional(Type.String()),
      summary: Type.String(),
      description: Type.Optional(Type.Any()),
      fields: Type.Optional(anyRecord),
      update: Type.Optional(anyRecord),
    })),
  }), (params, signal) => jira.batchCreateIssues({ ...params, signal }));

  register(pi, "jira_remove_issue_link", "Remove a Jira issue link.", Type.Object({
    linkId: Type.String(),
  }), (params, signal) => jira.removeIssueLink({ ...params, signal }));

  register(pi, "jira_batch_create_versions", "Create multiple project versions by calling the verified create-version endpoint for each item.", Type.Object({
    versions: Type.Array(Type.Object({
      projectId: Type.Optional(Type.Integer()),
      project: Type.Optional(Type.String()),
      name: Type.String(),
      description: Type.Optional(Type.String()),
      archived: Type.Optional(Type.Boolean()),
      released: Type.Optional(Type.Boolean()),
      releaseDate: Type.Optional(Type.String()),
      startDate: Type.Optional(Type.String()),
    })),
  }), (params, signal) => jira.batchCreateVersions({ ...params, signal }));

  pi.registerTool({
    name: "jira_issue",
    label: "Jira Issue",
    description: "Fetch compact Jira issue context including description, acceptance criteria, comments, and links.",
    promptSnippet: "Read Jira user-story context and extract acceptance criteria, linked designs, Confluence pages, and related issues.",
    promptGuidelines: [
      "Use jira_issue when the user provides a Jira key or asks for user-story details.",
      "Look for Figma and Confluence links in jira_issue results before implementation planning.",
    ],
    parameters: Type.Object({
      key: Type.String(),
      includeContext: Type.Optional(Type.Boolean()),
      includeComments: Type.Optional(Type.Boolean()),
      maxComments: Type.Optional(Type.Integer({ minimum: 0 })),
      includeConfluence: Type.Optional(Type.Boolean()),
      includeJiraLinks: Type.Optional(Type.Boolean()),
      includeParent: Type.Optional(Type.Boolean()),
      includeSubtasks: Type.Optional(Type.Boolean()),
      includeLinkedIssues: Type.Optional(Type.Boolean()),
      includeRemoteLinks: Type.Optional(Type.Boolean()),
      includeExternalUrls: Type.Optional(Type.Boolean()),
      includeConfluenceChildren: Type.Optional(Type.Boolean()),
      includeFigmaContext: Type.Optional(Type.Boolean()),
      maxDepth: Type.Optional(Type.Integer({ minimum: 0 })),
      maxConfluencePages: Type.Optional(Type.Integer({ minimum: 0 })),
      maxJiraIssues: Type.Optional(Type.Integer({ minimum: 1 })),
      maxExternalUrls: Type.Optional(Type.Integer({ minimum: 0 })),
      maxChildPages: Type.Optional(Type.Integer({ minimum: 0 })),
      maxFigmaLinks: Type.Optional(Type.Integer({ minimum: 0 })),
      figmaMode: Type.Optional(Type.Union([Type.Literal("overview"), Type.Literal("screen")])),
      figmaMaxScreens: Type.Optional(Type.Integer({ minimum: 0 })),
      figmaMaxDepth: Type.Optional(Type.Integer({ minimum: 0 })),
    }),
    async execute(_toolCallId, params, signal): Promise<any> {
      if (params.includeContext) {
        const context = await buildStoryContext({ ...pickContextOptions(params), key: params.key, signal }, { jira, confluence });
        return { content: [{ type: "text", text: renderStoryContextMarkdown(context) }], details: context };
      }
      const issue = await getJiraIssueContext({ ...params, signal }, jira);
      return { content: [{ type: "text", text: renderJiraIssueMarkdown(issue) }], details: issue };
    },
  });

  pi.registerTool({
    name: "story_context",
    label: "Story Context",
    description: "Build bounded implementation context from a Jira story by following same-site Jira and Confluence links.",
    promptSnippet: "Resolve a Jira story into implementation context before selecting Figma screens or editing code.",
    promptGuidelines: [
      "Use story_context first when the user provides a Jira key for implementation work.",
      "Review externalUrls and designLinks before deciding whether to fetch non-Atlassian resources.",
    ],
    parameters: Type.Object({
      key: Type.String(),
      includeComments: Type.Optional(Type.Boolean()),
      includeConfluence: Type.Optional(Type.Boolean()),
      includeJiraLinks: Type.Optional(Type.Boolean()),
      includeParent: Type.Optional(Type.Boolean()),
      includeSubtasks: Type.Optional(Type.Boolean()),
      includeLinkedIssues: Type.Optional(Type.Boolean()),
      includeRemoteLinks: Type.Optional(Type.Boolean()),
      includeExternalUrls: Type.Optional(Type.Boolean()),
      includeConfluenceChildren: Type.Optional(Type.Boolean()),
      includeFigmaContext: Type.Optional(Type.Boolean()),
      maxComments: Type.Optional(Type.Integer({ minimum: 0 })),
      maxDepth: Type.Optional(Type.Integer({ minimum: 0 })),
      maxConfluencePages: Type.Optional(Type.Integer({ minimum: 0 })),
      maxJiraIssues: Type.Optional(Type.Integer({ minimum: 1 })),
      maxExternalUrls: Type.Optional(Type.Integer({ minimum: 0 })),
      maxChildPages: Type.Optional(Type.Integer({ minimum: 0 })),
      maxFigmaLinks: Type.Optional(Type.Integer({ minimum: 0 })),
      figmaMode: Type.Optional(Type.Union([Type.Literal("overview"), Type.Literal("screen")])),
      figmaMaxScreens: Type.Optional(Type.Integer({ minimum: 0 })),
      figmaMaxDepth: Type.Optional(Type.Integer({ minimum: 0 })),
    }),
    async execute(_toolCallId, params, signal) {
      const context = await buildStoryContext({ ...params, signal }, { jira, confluence });
      return { content: [{ type: "text", text: renderStoryContextMarkdown(context) }], details: context };
    },
  });
}

type ExecuteFn = (params: any, signal?: AbortSignal) => Promise<unknown>;

function register(pi: ExtensionAPI, name: string, description: string, parameters: unknown, execute: ExecuteFn): void {
  pi.registerTool({
    name,
    label: name,
    description,
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

function pickContextOptions(params: any): any {
  const {
    includeComments,
    includeConfluence,
    includeJiraLinks,
    includeParent,
    includeSubtasks,
    includeLinkedIssues,
    includeRemoteLinks,
    includeExternalUrls,
    includeConfluenceChildren,
    includeFigmaContext,
    maxComments,
    maxDepth,
    maxConfluencePages,
    maxJiraIssues,
    maxExternalUrls,
    maxChildPages,
    maxFigmaLinks,
    figmaMode,
    figmaMaxScreens,
    figmaMaxDepth,
  } = params;
  return {
    includeComments,
    includeConfluence,
    includeJiraLinks,
    includeParent,
    includeSubtasks,
    includeLinkedIssues,
    includeRemoteLinks,
    includeExternalUrls,
    includeConfluenceChildren,
    includeFigmaContext,
    maxComments,
    maxDepth,
    maxConfluencePages,
    maxJiraIssues,
    maxExternalUrls,
    maxChildPages,
    maxFigmaLinks,
    figmaMode,
    figmaMaxScreens,
    figmaMaxDepth,
  };
}
