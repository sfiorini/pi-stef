import {
  getConfluencePageContext,
  getJiraIssueContext,
  renderConfluencePageMarkdown,
  renderJiraIssueMarkdown,
} from "@pi-stef/atlassian";
import {
  fetchGuardedText,
  loadWebAccessConfig,
} from "@pi-stef/web-access";

import type { ExternalFetcher } from "./types";

/**
 * Network/Atlassian-backed `ExternalFetcher` used by `sf_team_plan` when
 * no test seam overrides the wiring.
 *
 * Dispatch by `ref.kind`:
 *   - `url`        → `fetchGuardedText` from `@pi-stef/web-access`
 *                    (SSRF allowlist, DNS pinning, streamed byte cap,
 *                    redirect cap, timeout — see web-access docs).
 *   - `jira`       → `getJiraIssueContext` + `renderJiraIssueMarkdown`
 *                    from `@pi-stef/atlassian`. Lazily reads
 *                    `AtlassianAuth` credentials; throws "Atlassian
 *                    credentials not found." when not configured —
 *                    caught here, returns null.
 *   - `confluence` → `getConfluencePageContext` + `renderConfluencePageMarkdown`.
 *                    Short tinyLink URLs (`/wiki/x/...`) have no
 *                    parseable pageId; the helper throws "Confluence
 *                    pageId is required.", caught here, returns null.
 *   - `file`       → defensive `null` (scanRefs no longer emits this).
 *
 * **Contract**: the returned fetcher MUST NOT throw. Every code path is
 * wrapped in try/catch; failures become `null` so the orchestrator can
 * record the ref as unresolved with a descriptive reason.
 *
 * **Trust boundary**: this fetcher runs in the orchestrator's TS context,
 * NOT inside the reviewer/planner/researcher pi subprocesses. Loading it
 * does not widen those subprocesses' network surface; they still spawn
 * under `--no-extensions --tools read,grep,find,ls`.
 */
export interface DefaultExternalFetcherOptions {
  /**
   * Test seam — replaces the network call. Default wraps `fetchGuardedText`
   * with `loadWebAccessConfig()`.
   */
  fetchUrl?: (
    url: string,
    signal?: AbortSignal,
  ) => Promise<{ text: string; status: number; url: string; contentType?: string } | null>;
  /**
   * Test seam — defaults to the real `getJiraIssueContext`. Typed as the
   * function itself to avoid pulling in the private `JiraContextClient`
   * interface.
   */
  getJiraContext?: typeof getJiraIssueContext;
  /**
   * Test seam — defaults to the real `getConfluencePageContext`.
   */
  getConfluenceContext?: typeof getConfluencePageContext;
  /**
   * Test seam — defaults to `loadWebAccessConfig`. Lets tests pin a
   * deterministic config.
   */
  loadConfig?: typeof loadWebAccessConfig;
  /**
   * Post-render content byte cap. Defaults to 64 KB so the researcher's
   * prompt budget is bounded even when the network response is large.
   * Network reads are also capped earlier by `fetchGuardedText` via
   * `WebAccessConfig.fetchMaxBytes` (default 2 MB).
   */
  maxRenderedBytes?: number;
}

const DEFAULT_MAX_RENDERED_BYTES = 64 * 1024;

export function createDefaultExternalFetcher(
  opts: DefaultExternalFetcherOptions = {},
): ExternalFetcher {
  const maxRenderedBytes = opts.maxRenderedBytes ?? DEFAULT_MAX_RENDERED_BYTES;
  const fetchUrl = opts.fetchUrl ?? makeDefaultFetchUrl(opts.loadConfig ?? loadWebAccessConfig);
  const getJiraContext = opts.getJiraContext ?? getJiraIssueContext;
  const getConfluenceContext = opts.getConfluenceContext ?? getConfluencePageContext;

  return async (ref, signal) => {
    try {
      switch (ref.kind) {
        case "url": {
          const res = await fetchUrl(ref.id, signal);
          if (!res) return null;
          if (res.status < 200 || res.status >= 300) return null;
          // HTML extraction (strip <script>/<style>, drop tags, decode entities,
          // pull <title>) is only safe for HTML/XHTML content types. For
          // text/plain, text/markdown, application/json, source files, etc.,
          // angle-bracket characters in the body are real content (e.g.,
          // generics, JSX, JSON-of-HTML strings) and must NOT be stripped.
          const isHtml = isHtmlContentType(res.contentType);
          const { title, content } = isHtml
            ? extractHtmlContent(res.text)
            : { title: undefined, content: res.text };
          return {
            content: cap(content, maxRenderedBytes),
            title: title ?? ref.id,
          };
        }
        case "jira": {
          const ctx = await getJiraContext({ key: ref.id, signal });
          return {
            content: cap(renderJiraIssueMarkdown(ctx), maxRenderedBytes),
            title: `${ctx.key}: ${ctx.summary}`,
          };
        }
        case "confluence": {
          const ctx = await getConfluenceContext({ url: ref.id, signal });
          return {
            content: cap(renderConfluencePageMarkdown(ctx), maxRenderedBytes),
            title: ctx.title,
          };
        }
        case "file":
          // scanRefs no longer emits this; programmatic callers get null.
          return null;
      }
    } catch {
      return null;
    }
  };
}

function makeDefaultFetchUrl(
  loadConfig: typeof loadWebAccessConfig,
): NonNullable<DefaultExternalFetcherOptions["fetchUrl"]> {
  return async (url, signal) => {
    const config = await loadConfig();
    const res = await fetchGuardedText(url, { config, signal });
    return { text: res.text, status: res.status, url: res.url, contentType: res.contentType };
  };
}

const SCRIPT_RE = /<script\b[^>]*>[\s\S]*?<\/script\s*>/gi;
const STYLE_RE = /<style\b[^>]*>[\s\S]*?<\/style\s*>/gi;
const TITLE_RE = /<title\b[^>]*>([\s\S]*?)<\/title\s*>/i;
const TAG_RE = /<[^>]+>/g;
const WS_RE = /[ \t\f\v]+/g;
const NEWLINE_RE = /\n{3,}/g;

function isHtmlContentType(contentType: string | undefined): boolean {
  if (!contentType) return false;
  const ct = contentType.toLowerCase();
  return ct.includes("text/html") || ct.includes("application/xhtml+xml");
}

function extractHtmlContent(raw: string): { title?: string; content: string } {
  // Title FIRST so script/style stripping doesn't remove the head.
  const titleMatch = raw.match(TITLE_RE);
  const title = titleMatch ? decodeEntities(titleMatch[1]).trim() : undefined;

  const stripped = raw.replace(SCRIPT_RE, "").replace(STYLE_RE, "");
  const text = decodeEntities(stripped.replace(TAG_RE, " "));
  const content = text.replace(WS_RE, " ").replace(NEWLINE_RE, "\n\n").trim();
  return { title, content };
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ");
}

function cap(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max);
}
