import type { ExternalFetcher, ExternalFetchResult, ExternalRef } from "./types";

/**
 * Scan a prompt for external references and call the injected `ExternalFetcher`
 * for each. The production default fetcher (constructed by
 * `createDefaultExternalFetcher` in `default-fetcher.ts` and wired in
 * `register.ts`) dispatches URL refs through `@pi-stef/web-access`
 * (`fetchGuardedText` with SSRF policy + streaming byte cap), and Jira /
 * Confluence refs through `@pi-stef/atlassian` (`getJiraIssueContext`,
 * `getConfluencePageContext`). Tests and any direct API caller may pass
 * `noopExternalFetcher` (below) or their own implementation; if no
 * fetcher is injected, every ref falls into `unresolved` with the reason
 * `"no fetcher configured"`.
 *
 * Fetcher contract:
 *   - Return `null` for refs the fetcher can't or won't resolve.
 *   - Throw → caught here and treated as `unresolved` with the error message.
 *   - Return `{ content, title? }` for a successful fetch.
 */
export const noopExternalFetcher: ExternalFetcher = async () => null;

const URL_RE = /\bhttps?:\/\/[^\s)\]>]+/g;
const JIRA_RE = /\b([A-Z][A-Z0-9]{1,9})-(\d+)\b/g;
// Confluence URLs (Atlassian wiki). Examples:
//   https://acme.atlassian.net/wiki/spaces/ENG/pages/12345/Some+Title
//   https://acme.atlassian.net/wiki/x/ABCDEF
// Matches the URL prefix; the URL_RE catches the full URL too, so we mark
// the same string as kind=confluence (overrides the url classification).
const CONFLUENCE_RE = /\bhttps?:\/\/[^\s)\]>/]+\.atlassian\.net\/wiki\/[^\s)\]>]+/g;
// File-path scanning intentionally removed (Plan B): the researcher
// subprocess runs with `--tools read,grep,find,ls`, so it can read any
// repo-local file the user mentions in the brief without an orchestrator-
// side pre-fetch. Keeping the scan would force the orchestrator to ask the
// user to "Paste content of file:..." every time, which is the bug this
// removal fixes. The `kind="file"` enum value stays in `ExternalRefKind`
// so that any callers who construct file refs programmatically (none in
// the repo today) keep compiling; the default fetcher returns null for
// them defensively.

/** Pure regex scanner. Exposed for testing. */
export function scanRefs(prompt: string): ExternalRef[] {
  const byKey = new Map<string, ExternalRef>();
  // Confluence FIRST so its classification wins over the bare URL classifier.
  for (const m of prompt.matchAll(CONFLUENCE_RE)) {
    const url = stripTrailingPunctuation(m[0]);
    const key = `confluence:${url}`;
    if (byKey.has(key)) continue;
    byKey.set(key, { kind: "confluence", raw: m[0], id: url });
    byKey.set(`url:${url}`, byKey.get(key)!); // suppress URL_RE re-detection
  }
  for (const m of prompt.matchAll(URL_RE)) {
    const url = stripTrailingPunctuation(m[0]);
    const key = `url:${url}`;
    if (byKey.has(key)) continue;
    byKey.set(key, { kind: "url", raw: m[0], id: url });
  }
  for (const m of prompt.matchAll(JIRA_RE)) {
    const id = `${m[1]}-${m[2]}`;
    const key = `jira:${id}`;
    if (byKey.has(key)) continue;
    byKey.set(key, { kind: "jira", raw: m[0], id });
  }
  // Filter the suppression-only entries (those keyed `url:` whose target is a confluence ref).
  const refs: ExternalRef[] = [];
  const seen = new Set<string>();
  for (const [k, v] of byKey) {
    const stableKey = `${v.kind}:${v.id}`;
    if (seen.has(stableKey)) continue;
    if (k.startsWith("url:") && v.kind === "confluence") continue;
    seen.add(stableKey);
    refs.push(v);
  }
  return refs;
}

function stripTrailingPunctuation(s: string): string {
  return s.replace(/[.,;:!?)]+$/, "");
}

export interface FetchExternalContextOptions {
  fetcher?: ExternalFetcher;
  signal?: AbortSignal;
  /** Per-ref timeout in ms. Default 10s. */
  perRefTimeoutMs?: number;
}

export async function fetchExternalContext(
  prompt: string,
  opts: FetchExternalContextOptions = {},
): Promise<ExternalFetchResult> {
  const fetcher = opts.fetcher ?? noopExternalFetcher;
  const refs = scanRefs(prompt);
  const result: ExternalFetchResult = { resolved: [], unresolved: [] };
  for (const ref of refs) {
    try {
      const hit = await withTimeout(fetcher(ref, opts.signal), opts.perRefTimeoutMs ?? 10_000);
      if (hit === null) {
        result.unresolved.push({
          ref,
          reason: fetcher === noopExternalFetcher ? "no fetcher configured" : "fetcher returned null",
        });
      } else {
        result.resolved.push({ ref, content: hit.content, title: hit.title });
      }
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      result.unresolved.push({ ref, reason });
    }
  }
  return result;
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  if (ms <= 0) return p;
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`external fetch timeout after ${ms}ms`)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}
