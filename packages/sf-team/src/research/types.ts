/**
 * Public types for the research phase: external refs the orchestrator
 * extracts from the prompt, the injected fetcher, and the researcher's
 * structured output (`ResearchAnalysis`).
 */

export type ExternalRefKind = "url" | "jira" | "confluence" | "file";

export interface ExternalRef {
  kind: ExternalRefKind;
  /** Original substring from the prompt. */
  raw: string;
  /** Normalized identifier (URL string, Jira key, file path). */
  id: string;
}

export interface ExternalFetchHit {
  ref: ExternalRef;
  content: string;
  title?: string;
}

export interface ExternalFetchMiss {
  ref: ExternalRef;
  reason: string;
}

export interface ExternalFetchResult {
  resolved: ExternalFetchHit[];
  unresolved: ExternalFetchMiss[];
}

/**
 * The injection point. Default implementation in `external-fetch.ts` is a
 * no-op that returns `null` for every ref (so all refs become unresolved).
 *
 * A real implementation (follow-up PR) wires in workspace-dep helpers
 * (`@pi-stef/web-access`, `@pi-stef/atlassian`, etc.) or pi
 * extension tools. It must NEVER throw — errors should be caught and the
 * ref returned as a miss with a reason.
 */
export type ExternalFetcher = (
  ref: ExternalRef,
  signal?: AbortSignal,
) => Promise<{ content: string; title?: string } | null>;

export interface ResearchOpenQuestion {
  /** Stable id used to cache the answer; required so resume re-uses prior responses. */
  id: string;
  /** "input" → free-form text; "select" → one of `options[]`. */
  kind: "input" | "select";
  title: string;
  /** Required when kind="select". */
  options?: string[];
  /** Only honored for kind="input"; questions are required by default. */
  optional?: boolean;
}

export interface ResearchExternalContext {
  url?: string;
  title?: string;
  /** Brief summary — typically 1-3 sentences extracted from the fetched content. */
  summary: string;
}

export interface ResearchAnalysis {
  /** Things the researcher considers established (from prompt + fetched context + repo). */
  knownFacts: string[];
  /** Things the researcher noticed but couldn't resolve. */
  ambiguities: string[];
  /** Questions the orchestrator should ask the user. */
  openQuestions: ResearchOpenQuestion[];
  /** Per-ref summaries (echoed back from the orchestrator's fetched context). */
  external: ResearchExternalContext[];
  /** Free-form notes from the researcher; surfaced in the planner brief. */
  notes?: string;
}
