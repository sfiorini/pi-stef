import {
  AtlassianAuth,
  buildStoryContext as defaultBuildStoryContext,
  extractLinks,
  renderStoryContextMarkdown as defaultRenderStoryContextMarkdown,
  type StoryContext,
  type StoryContextOptions,
} from "@pi-stef/atlassian";

export interface DetectedJiraReferences {
  /** Deduped, first-occurrence-ordered Jira ticket keys after the false-positive filter. */
  keys: string[];
  /** Confluence URLs found in the input. Recorded for transcript visibility; not used as fetch roots. */
  confluenceUrls: string[];
}

/**
 * Single-letter prefixes followed only by digits (`M1`, `T2`, `S5`, …) match
 * the underlying Jira-key regex but are almost always milestone/sprint
 * false positives in plan briefs. Reject them.
 */
const FALSE_POSITIVE_PREFIX = /^[A-Z]\d+$/;

export function detectJiraReferences(text: string): DetectedJiraReferences {
  const links = extractLinks(text);
  const keys = links.jiraKeys.filter((key) => {
    const prefix = key.split("-")[0];
    return !FALSE_POSITIVE_PREFIX.test(prefix);
  });
  return { keys, confluenceUrls: links.confluenceUrls };
}

export interface JiraContextResult {
  status: "used" | "skipped" | "failed";
  reason?: string;
  detectedKeys: string[];
  confluenceUrls: string[];
  fetchedCount: number;
  /** Concatenated `renderStoryContextMarkdown` output. Empty when status !== "used". */
  markdown: string;
}

export interface FetchJiraContextInput {
  title: string;
  brief: string;
  signal?: AbortSignal;
}

export interface FetchJiraContextDeps {
  auth?: { getConfig(): unknown };
  buildStoryContext?: typeof defaultBuildStoryContext;
  renderStoryContextMarkdown?: typeof defaultRenderStoryContextMarkdown;
}

const DEFAULT_FETCH_OPTIONS: Omit<StoryContextOptions, "key" | "signal"> = {
  includeComments: true,
  includeConfluence: true,
  includeJiraLinks: true,
  includeParent: true,
  includeSubtasks: true,
  includeLinkedIssues: true,
  includeRemoteLinks: true,
  includeExternalUrls: false,
  includeConfluenceChildren: false,
  maxComments: 5,
  maxDepth: 1,
  maxConfluencePages: 3,
  maxJiraIssues: 10,
  maxExternalUrls: 20,
  maxChildPages: 10,
};

export async function fetchJiraContext(
  input: FetchJiraContextInput,
  deps: FetchJiraContextDeps = {},
): Promise<JiraContextResult> {
  const detected = detectJiraReferences(`${input.title}\n${input.brief}`);
  const baseResult = {
    detectedKeys: detected.keys,
    confluenceUrls: detected.confluenceUrls,
    fetchedCount: 0,
    markdown: "",
  };

  if (detected.keys.length === 0) {
    return {
      status: "skipped",
      reason: "no Jira keys detected",
      ...baseResult,
    };
  }

  // Auth: load credentials. If anything is wrong (missing env, malformed
  // file, etc.), skip without failing the plan.
  try {
    const auth = deps.auth ?? new AtlassianAuth();
    auth.getConfig();
  } catch (error) {
    return {
      status: "skipped",
      reason: `credentials missing: ${formatError(error)}`,
      ...baseResult,
    };
  }

  const buildStoryContext = deps.buildStoryContext ?? defaultBuildStoryContext;
  const renderStoryContextMarkdown = deps.renderStoryContextMarkdown ?? defaultRenderStoryContextMarkdown;

  const sections: string[] = [];
  let fetchedCount = 0;

  for (const key of detected.keys) {
    let context: StoryContext;
    try {
      context = await buildStoryContext({
        key,
        ...DEFAULT_FETCH_OPTIONS,
        signal: input.signal,
      });
    } catch (error) {
      return {
        status: "failed",
        reason: `walker error for ${key}: ${formatError(error)}`,
        ...baseResult,
      };
    }
    sections.push(renderStoryContextMarkdown(context));
    fetchedCount += 1;
  }

  return {
    status: "used",
    detectedKeys: detected.keys,
    confluenceUrls: detected.confluenceUrls,
    fetchedCount,
    markdown: sections.join("\n\n"),
  };
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
