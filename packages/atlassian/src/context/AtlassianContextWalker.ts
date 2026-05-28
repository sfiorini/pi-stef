import { getConfluencePageContext, renderConfluencePageMarkdown, type ConfluencePageContext } from "../confluence/ConfluenceContext";
import { FigmaAuthorization, buildFigmaContextForMode, renderFigmaContext } from "@pi-stef/figma";
import { ConfluenceClient } from "../confluence/ConfluenceClient";
import { extractLinks, unique } from "../links/extractLinks";
import { resolveAtlassianLinks } from "../links/resolveAtlassianLinks";
import { JiraPlatformClient } from "../jira/JiraPlatformClient";
import {
  formatIssueReference,
  getJiraIssueContext,
  renderJiraIssueMarkdown,
  type JiraIssueContext,
  type JiraIssueReference,
} from "../jira/JiraContext";

export const DEFAULT_JIRA_CONTEXT_OPTIONS = {
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
  maxFigmaLinks: 2,
  figmaMode: "overview",
  figmaMaxScreens: 10,
  figmaMaxDepth: 6,
} as const;

const FIGMA_CONTEXT_CONCURRENCY = 2;

export interface StoryContextOptions {
  key: string;
  includeComments?: boolean;
  includeConfluence?: boolean;
  includeJiraLinks?: boolean;
  includeParent?: boolean;
  includeSubtasks?: boolean;
  includeLinkedIssues?: boolean;
  includeRemoteLinks?: boolean;
  includeExternalUrls?: boolean;
  includeConfluenceChildren?: boolean;
  includeFigmaContext?: boolean;
  maxComments?: number;
  maxDepth?: number;
  maxConfluencePages?: number;
  maxJiraIssues?: number;
  maxExternalUrls?: number;
  maxChildPages?: number;
  maxFigmaLinks?: number;
  figmaMode?: "overview" | "screen";
  figmaMaxScreens?: number;
  figmaMaxDepth?: number;
  signal?: AbortSignal;
}

export interface StoryContext {
  issue: JiraIssueContext;
  jiraIssues: JiraIssueContext[];
  parentIssue?: JiraIssueContext;
  subtaskIssues: JiraIssueContext[];
  linkedIssueContexts: JiraIssueContext[];
  confluencePages: ConfluencePageContext[];
  figmaContexts: FigmaLinkContext[];
  designLinks: string[];
  externalUrls: string[];
  relatedJiraKeys: string[];
  inaccessibleLinks: InaccessibleLink[];
}

export interface InaccessibleLink {
  type: "jira" | "confluence" | "figma";
  target: string;
  reason: string;
}

export interface FigmaLinkContext {
  url: string;
  mode: "overview" | "screen";
  markdown: string;
  details: unknown;
}

interface ResolvedStoryContextOptions {
  key: string;
  includeComments: boolean;
  includeConfluence: boolean;
  includeJiraLinks: boolean;
  includeParent: boolean;
  includeSubtasks: boolean;
  includeLinkedIssues: boolean;
  includeRemoteLinks: boolean;
  includeExternalUrls: boolean;
  includeConfluenceChildren: boolean;
  includeFigmaContext?: boolean;
  maxComments: number;
  maxDepth: number;
  maxConfluencePages: number;
  maxJiraIssues: number;
  maxExternalUrls: number;
  maxChildPages: number;
  maxFigmaLinks: number;
  figmaMode: "overview" | "screen";
  figmaMaxScreens: number;
  figmaMaxDepth: number;
  signal?: AbortSignal;
}

interface ContextDeps {
  jira?: JiraContextClient;
  confluence?: ConfluenceContextClient;
  figma?: FigmaContextClient;
}

interface FigmaContextClient {
  isConfigured(): boolean;
  build(params: {
    url: string;
    mode: "overview" | "screen";
    maxScreens: number;
    maxDepth: number;
    signal?: AbortSignal;
  }): Promise<FigmaLinkContext>;
}

interface JiraContextClient {
  readonly baseUrl: string;
  getIssue(params: { issueIdOrKey: string; fields?: string[]; expand?: string[]; signal?: AbortSignal }): Promise<unknown>;
  getComments(params: { issueIdOrKey: string; orderBy?: string; maxResults?: number; signal?: AbortSignal }): Promise<unknown>;
  getRemoteLinks?(params: { issueIdOrKey: string; signal?: AbortSignal }): Promise<unknown>;
}

interface ConfluenceContextClient {
  getPage(params: { pageId: string; bodyFormat?: "storage"; includeVersion?: boolean; signal?: AbortSignal }): Promise<unknown>;
  getPageChildren(params: { pageId: string; limit?: number; signal?: AbortSignal }): Promise<unknown>;
}

export async function buildStoryContext(options: StoryContextOptions, deps: ContextDeps = {}): Promise<StoryContext> {
  const settings: ResolvedStoryContextOptions = { ...DEFAULT_JIRA_CONTEXT_OPTIONS, ...options };
  const jira = deps.jira ?? new JiraPlatformClient();
  const confluence = deps.confluence ?? new ConfluenceClient();
  const figma = deps.figma ?? new DefaultFigmaContextClient();
  const visitedJira = new Set<string>();
  const queuedJira = new Set<string>();
  const issueQueue: Array<{ key: string; depth: number }> = [{ key: options.key, depth: 0 }];
  const issues: JiraIssueContext[] = [];
  const issueMap = new Map<string, JiraIssueContext>();
  const confluencePages: ConfluencePageContext[] = [];
  const seenConfluence = new Set<string>();
  const inaccessibleLinks: InaccessibleLink[] = [];
  const designLinks: string[] = [];
  const externalUrls: string[] = [];
  const relatedJiraKeys: string[] = [];

  queuedJira.add(options.key);

  while (issueQueue.length && issues.length < settings.maxJiraIssues) {
    const next = issueQueue.shift()!;
    if (visitedJira.has(next.key)) continue;
    visitedJira.add(next.key);

    let issue: JiraIssueContext;
    try {
      issue = await getJiraIssueContext(
        {
          key: next.key,
          includeComments: next.depth === 0 ? settings.includeComments : false,
          maxComments: next.depth === 0 ? settings.maxComments : 0,
          signal: settings.signal,
        },
        jira,
      );
    } catch (error) {
      inaccessibleLinks.push({ type: "jira", target: next.key, reason: errorMessage(error) });
      continue;
    }

    issues.push(issue);
    issueMap.set(issue.key, issue);

    const resolved = resolveAtlassianLinks(issue.links, { baseUrl: jira.baseUrl });
    collectInventory(resolved, settings, designLinks, externalUrls, relatedJiraKeys);

    if (settings.includeRemoteLinks && jira.getRemoteLinks) {
      try {
        const remoteLinks = resolveAtlassianLinks(extractLinks(await jira.getRemoteLinks({ issueIdOrKey: issue.key, signal: settings.signal })), { baseUrl: jira.baseUrl });
        collectInventory(remoteLinks, settings, designLinks, externalUrls, relatedJiraKeys);
        enqueueJira(remoteLinks.jiraKeys, next.depth, settings, issueQueue, queuedJira, visitedJira, issue.key);
        await fetchConfluence(remoteLinks.confluencePages.map((page) => page.url), settings, confluence, confluencePages, seenConfluence, inaccessibleLinks, designLinks, relatedJiraKeys);
      } catch {
        // Remote links are supplemental context; keep the main Jira context useful if unavailable.
      }
    }

    if (settings.includeConfluence) {
      await fetchConfluence(resolved.confluencePages.map((page) => page.url), settings, confluence, confluencePages, seenConfluence, inaccessibleLinks, designLinks, relatedJiraKeys);
    }

    if (next.depth >= settings.maxDepth) continue;
    const referenceKeys = referenceCandidates(issue, settings);
    enqueueJira([...referenceKeys, ...resolved.jiraKeys], next.depth, settings, issueQueue, queuedJira, visitedJira, issue.key);
  }

  const root = issueMap.get(options.key) ?? issues[0];
  if (!root) throw new Error(`Unable to fetch Jira issue ${options.key}.`);
  const parentIssue = root.parent ? issueMap.get(root.parent.key) : undefined;
  const subtaskIssues = root.subtasks.map((item) => issueMap.get(item.key)).filter((item): item is JiraIssueContext => Boolean(item));
  const directReferenceKeys = new Set([root.parent?.key, ...root.subtasks.map((item) => item.key)].filter((key): key is string => Boolean(key)));
  const linkedIssueContexts = issues.filter((item) => item.key !== root.key && !directReferenceKeys.has(item.key));
  const uniqueDesignLinks = unique(designLinks);
  const figmaContexts = await collectFigmaContexts(uniqueDesignLinks, settings, figma, inaccessibleLinks);

  return {
    issue: root,
    jiraIssues: issues,
    parentIssue,
    subtaskIssues,
    linkedIssueContexts,
    confluencePages,
    figmaContexts,
    designLinks: uniqueDesignLinks,
    externalUrls: unique(externalUrls).slice(0, settings.maxExternalUrls),
    relatedJiraKeys: unique(relatedJiraKeys.filter((key) => key !== root.key)),
    inaccessibleLinks,
  };
}

export function renderStoryContextMarkdown(context: StoryContext): string {
  const lines = [renderJiraIssueMarkdown(context.issue).trim()];

  if (context.parentIssue) lines.push("", "## Parent Issue Details", issueSummaryBlock(context.parentIssue));
  if (context.subtaskIssues.length) {
    lines.push("", "## Subtask Issue Details");
    for (const issue of context.subtaskIssues) lines.push("", issueSummaryBlock(issue));
  }
  if (context.linkedIssueContexts.length) {
    lines.push("", "## Linked Issue Details");
    for (const issue of context.linkedIssueContexts) lines.push("", issueSummaryBlock(issue));
  }
  if (context.figmaContexts.length) {
    lines.push("", "## Linked Figma Context");
    for (const figma of context.figmaContexts) {
      lines.push("", `### ${figma.url}`, "", figma.markdown.trim());
    }
  }
  if (context.designLinks.length) lines.push("", "## Design Links For Follow-up", ...context.designLinks.map((url) => `- ${url}`));
  if (context.confluencePages.length) {
    lines.push("", "## Linked Confluence Pages");
    for (const page of context.confluencePages) {
      lines.push("", renderConfluencePageMarkdown(page).trim());
    }
  }
  if (context.externalUrls.length) lines.push("", "## External URLs", ...context.externalUrls.map((url) => `- ${url}`));
  if (context.relatedJiraKeys.length) lines.push("", "## Related Jira Keys", ...context.relatedJiraKeys.map((key) => `- ${key}`));
  if (context.inaccessibleLinks.length) {
    lines.push("", "## Inaccessible Links", ...context.inaccessibleLinks.map((link) => `- ${link.type}: ${link.target} (${link.reason})`));
  }

  return `${lines.join("\n")}\n`;
}

async function collectFigmaContexts(
  urls: string[],
  settings: ResolvedStoryContextOptions,
  client: FigmaContextClient,
  inaccessibleLinks: InaccessibleLink[],
): Promise<FigmaLinkContext[]> {
  const cappedUrls = urls.slice(0, settings.maxFigmaLinks);
  const configured = client.isConfigured();
  const shouldInclude = settings.includeFigmaContext ?? configured;
  if (!shouldInclude) return [];
  if (!configured) {
    for (const url of cappedUrls) {
      inaccessibleLinks.push({ type: "figma", target: url, reason: "Figma token is not configured." });
    }
    return [];
  }

  const results: FigmaLinkContext[] = [];
  // Keep Figma enrichment bounded: at most maxFigmaLinks URLs, fetched two at a time.
  // Jira context should remain responsive even when design files are slow or unavailable.
  for (let index = 0; index < cappedUrls.length; index += FIGMA_CONTEXT_CONCURRENCY) {
    const batch = cappedUrls.slice(index, index + FIGMA_CONTEXT_CONCURRENCY);
    const settled = await Promise.allSettled(
      batch.map((url) =>
        client.build({
          url,
          mode: settings.figmaMode,
          maxScreens: settings.figmaMaxScreens,
          maxDepth: settings.figmaMaxDepth,
          signal: settings.signal,
        }),
      ),
    );
    settled.forEach((result, offset) => {
      const url = batch[offset];
      if (result.status === "fulfilled") {
        results.push(result.value);
      } else {
        inaccessibleLinks.push({ type: "figma", target: url, reason: errorMessage(result.reason) });
      }
    });
  }
  return results;
}

class DefaultFigmaContextClient implements FigmaContextClient {
  isConfigured(): boolean {
    try {
      return Boolean(new FigmaAuthorization().getConfig().apiToken);
    } catch {
      return false;
    }
  }

  async build(params: {
    url: string;
    mode: "overview" | "screen";
    maxScreens: number;
    maxDepth: number;
    signal?: AbortSignal;
  }): Promise<FigmaLinkContext> {
    const details = await buildFigmaContextForMode({
      url: params.url,
      mode: params.mode,
      format: "markdown",
      maxScreens: params.maxScreens,
      maxDepth: params.maxDepth,
      signal: params.signal,
    });
    return {
      url: params.url,
      mode: params.mode,
      markdown: renderFigmaContext(details, "markdown"),
      details,
    };
  }
}

function referenceCandidates(issue: JiraIssueContext, settings: ResolvedStoryContextOptions): string[] {
  return unique([
    ...(settings.includeParent && issue.parent ? [issue.parent.key] : []),
    ...(settings.includeSubtasks ? issue.subtasks.map((item) => item.key) : []),
    ...(settings.includeLinkedIssues ? issue.linkedIssues.map((item) => item.key) : []),
  ]);
}

function enqueueJira(
  keys: string[],
  currentDepth: number,
  settings: ResolvedStoryContextOptions,
  queue: Array<{ key: string; depth: number }>,
  queued: Set<string>,
  visited: Set<string>,
  currentKey: string,
): void {
  if (!settings.includeJiraLinks) return;
  for (const key of keys) {
    if (key === currentKey || queued.has(key) || visited.has(key)) continue;
    if (queue.length + visited.size >= settings.maxJiraIssues) break;
    queued.add(key);
    queue.push({ key, depth: currentDepth + 1 });
  }
}

async function fetchConfluence(
  urls: string[],
  settings: ResolvedStoryContextOptions,
  client: ConfluenceContextClient,
  pages: ConfluencePageContext[],
  seen: Set<string>,
  inaccessibleLinks: InaccessibleLink[],
  designLinks: string[],
  relatedJiraKeys: string[],
): Promise<void> {
  for (const url of urls) {
    if (seen.size >= settings.maxConfluencePages) return;
    if (seen.has(url)) continue;
    seen.add(url);
    try {
      const page = await getConfluencePageContext(
        {
          url,
          includeChildPages: settings.includeConfluenceChildren,
          maxChildPages: settings.maxChildPages,
          signal: settings.signal,
        },
        client,
      );
      pages.push(page);
      designLinks.push(...page.links.figmaUrls);
      relatedJiraKeys.push(...page.links.jiraKeys);
    } catch (error) {
      inaccessibleLinks.push({ type: "confluence", target: url, reason: errorMessage(error) });
    }
  }
}

function collectInventory(
  resolved: { jiraKeys: string[]; figmaUrls: string[]; externalUrls: string[] },
  settings: ResolvedStoryContextOptions,
  designLinks: string[],
  externalUrls: string[],
  relatedJiraKeys: string[],
): void {
  designLinks.push(...resolved.figmaUrls);
  relatedJiraKeys.push(...resolved.jiraKeys);
  if (settings.includeExternalUrls) externalUrls.push(...resolved.externalUrls);
}

function issueSummaryBlock(issue: JiraIssueContext): string {
  const lines = [
    `### ${issue.key}: ${issue.summary}`,
    issue.status ? `- Status: ${issue.status}` : undefined,
    issue.issueType ? `- Type: ${issue.issueType}` : undefined,
    issue.description ? `- Description: ${firstLine(issue.description)}` : undefined,
  ].filter((line): line is string => Boolean(line));

  if (issue.parent) lines.push(formatIssueReference(issue.parent));
  if (issue.linkedIssues.length) lines.push("- Linked:", ...issue.linkedIssues.slice(0, 5).map((link) => `  ${formatIssueReference(link)}`));
  return lines.join("\n");
}

function firstLine(value: string): string {
  return value.split("\n").find((line) => line.trim().length > 0)?.trim() ?? "";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export const getStoryContext = buildStoryContext;
