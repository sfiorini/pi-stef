import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";

import { ConfluenceClient } from "./ConfluenceClient";
import { getConfluencePageContext, renderConfluencePageMarkdown } from "./ConfluenceContext";
import { ConfluenceLegacyClient } from "./ConfluenceLegacyClient";

export interface ConfluenceToolDeps {
  confluence?: ConfluenceClient;
  legacy?: ConfluenceLegacyClient;
}

export function registerConfluenceTools(pi: ExtensionAPI, deps: ConfluenceToolDeps = {}): void {
  const confluence = deps.confluence ?? new ConfluenceClient();
  const legacy = deps.legacy ?? new ConfluenceLegacyClient();
  const bodyFormat = Type.Optional(Type.Union([
    Type.Literal("storage"),
    Type.Literal("atlas_doc_format"),
    Type.Literal("view"),
    Type.Literal("export_view"),
    Type.Literal("anonymous_export_view"),
  ]));
  const bodyRepresentation = Type.Optional(Type.Union([Type.Literal("storage"), Type.Literal("atlas_doc_format")]));

  register(pi, "confluence_list_spaces", "List Confluence spaces.", Type.Object({
    limit: Type.Optional(Type.Integer({ minimum: 1 })),
    cursor: Type.Optional(Type.String()),
    keys: Type.Optional(Type.Array(Type.String())),
    ids: Type.Optional(Type.Array(Type.String())),
    status: Type.Optional(Type.Array(Type.String())),
  }), (params, signal) => confluence.listSpaces({ ...params, signal }));

  register(pi, "confluence_list_pages", "List Confluence pages.", Type.Object({
    spaceId: Type.Optional(Type.String()),
    limit: Type.Optional(Type.Integer({ minimum: 1 })),
    cursor: Type.Optional(Type.String()),
    status: Type.Optional(Type.String()),
    title: Type.Optional(Type.String()),
    bodyFormat,
  }), (params, signal) => confluence.listPages({ ...params, signal }));

  register(pi, "confluence_create_page", "Create a Confluence page.", Type.Object({
    spaceId: Type.String(),
    title: Type.String(),
    body: Type.String(),
    parentId: Type.Optional(Type.String()),
    bodyRepresentation,
  }), (params, signal) => confluence.createPage({ ...params, signal }));

  register(pi, "confluence_update_page", "Update a Confluence page. Pass the current page version; the tool sends current version + 1 to Confluence.", Type.Object({
    pageId: Type.String(),
    title: Type.String(),
    body: Type.String(),
    version: Type.Integer({ minimum: 1 }),
    bodyRepresentation,
  }), (params, signal) => confluence.updatePage({ ...params, signal }));

  register(pi, "confluence_search", "Search Confluence content using CQL. Uses verified Confluence v1 search because v2 has no equivalent.", Type.Object({
    cql: Type.String(),
    limit: Type.Optional(Type.Integer({ minimum: 1 })),
    start: Type.Optional(Type.Integer({ minimum: 0 })),
    expand: Type.Optional(Type.String()),
  }), (params, signal) => legacy.search({ ...params, signal }));

  register(pi, "confluence_get_page", "Get a Confluence page by ID.", Type.Object({
    pageId: Type.String(),
    bodyFormat,
    includeLabels: Type.Optional(Type.Boolean()),
    includeVersion: Type.Optional(Type.Boolean()),
  }), (params, signal) => confluence.getPage({ ...params, signal }));

  register(pi, "confluence_get_page_children", "Get child pages for a Confluence page.", Type.Object({
    pageId: Type.String(),
    limit: Type.Optional(Type.Integer({ minimum: 1 })),
    cursor: Type.Optional(Type.String()),
    sort: Type.Optional(Type.String()),
  }), (params, signal) => confluence.getPageChildren({ ...params, signal }));

  register(pi, "confluence_get_comments", "Get footer comments for a Confluence page.", Type.Object({
    pageId: Type.String(),
    bodyFormat,
    limit: Type.Optional(Type.Integer({ minimum: 1 })),
    cursor: Type.Optional(Type.String()),
    sort: Type.Optional(Type.String()),
    status: Type.Optional(Type.String()),
  }), (params, signal) => confluence.getComments({ ...params, signal }));

  register(pi, "confluence_get_labels", "Get labels for a Confluence page.", Type.Object({
    pageId: Type.String(),
    prefix: Type.Optional(Type.String()),
    limit: Type.Optional(Type.Integer({ minimum: 1 })),
    cursor: Type.Optional(Type.String()),
    sort: Type.Optional(Type.String()),
  }), (params, signal) => confluence.getLabels({ ...params, signal }));

  register(pi, "confluence_search_user", "Search Confluence users. Uses verified Confluence v1 user search because v2 has no equivalent.", Type.Object({
    cql: Type.String(),
    limit: Type.Optional(Type.Integer({ minimum: 1 })),
    start: Type.Optional(Type.Integer({ minimum: 0 })),
  }), (params, signal) => legacy.searchUser({ ...params, signal }));

  register(pi, "confluence_delete_page", "Delete a Confluence page.", Type.Object({
    pageId: Type.String(),
    purge: Type.Optional(Type.Boolean()),
  }), (params, signal) => confluence.deletePage({ ...params, signal }));

  register(pi, "confluence_add_label", "Add labels to a Confluence page. Uses verified Confluence v1 label endpoint because v2 has no equivalent.", Type.Object({
    pageId: Type.String(),
    labels: Type.Array(Type.Object({ prefix: Type.String(), name: Type.String() })),
  }), (params, signal) => legacy.addLabel({ ...params, signal }));

  register(pi, "confluence_add_comment", "Add a footer comment to a Confluence page.", Type.Object({
    pageId: Type.String(),
    body: Type.String(),
    parentCommentId: Type.Optional(Type.String()),
    bodyRepresentation,
  }), (params, signal) => confluence.addComment({ ...params, signal }));

  pi.registerTool({
    name: "confluence_page",
    label: "Confluence Page",
    description: "Fetch compact Confluence page context by URL or page ID.",
    promptSnippet: "Read Confluence page context and extract page content, headings, Jira keys, and Figma links.",
    promptGuidelines: ["Use confluence_page when Jira or the user links to a Confluence page that may contain requirements or design references."],
    parameters: Type.Object({
      url: Type.Optional(Type.String()),
      pageId: Type.Optional(Type.String()),
      includeChildPages: Type.Optional(Type.Boolean()),
      maxChildPages: Type.Optional(Type.Integer({ minimum: 0 })),
    }),
    async execute(_toolCallId, params, signal) {
      const page = await getConfluencePageContext({ ...params, signal }, confluence);
      return { content: [{ type: "text", text: renderConfluencePageMarkdown(page) }], details: page };
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
