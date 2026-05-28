/**
 * Resolution chain shared by every configurable knob:
 *
 *   prompt → project config → global config → Q&A → hard default
 *
 * The first source that returns a non-`undefined` value wins. The Q&A step is
 * a callback so callers can plug in whichever interactive primitive fits
 * (typically `ask-user.ts` from M3, which wraps `pi.ui.{select,input,confirm}`).
 *
 * The chain is locked-in plan decision #7 and applied uniformly so callers
 * never have to remember the precedence order.
 */
export interface ResolveSources<T> {
  /** From the tool-call's prompt arguments. Highest precedence. */
  prompt?: T;
  /** From `<repo>/.sf-team.json`. */
  project?: T;
  /** From `~/.pi/sf-team/config.json`. */
  global?: T;
  /** Default value used if the chain falls through. Required. */
  default: T;
  /** Optional Q&A callback. Returns `undefined` to fall through to default. */
  ask?: (signal?: AbortSignal) => Promise<T | undefined>;
  /** AbortSignal forwarded to the Q&A callback. */
  signal?: AbortSignal;
}

export interface ResolvedValue<T> {
  value: T;
  source: "prompt" | "project" | "global" | "ask" | "default";
}

export async function resolveValue<T>(sources: ResolveSources<T>): Promise<ResolvedValue<T>> {
  if (sources.prompt !== undefined) return { value: sources.prompt, source: "prompt" };
  if (sources.project !== undefined) return { value: sources.project, source: "project" };
  if (sources.global !== undefined) return { value: sources.global, source: "global" };
  if (sources.ask) {
    const answer = await sources.ask(sources.signal);
    if (answer !== undefined) return { value: answer, source: "ask" };
  }
  return { value: sources.default, source: "default" };
}

/** Synchronous variant for tests / pure-data resolution paths (no Q&A). */
export function resolveValueSync<T>(sources: Omit<ResolveSources<T>, "ask" | "signal">): ResolvedValue<T> {
  if (sources.prompt !== undefined) return { value: sources.prompt, source: "prompt" };
  if (sources.project !== undefined) return { value: sources.project, source: "project" };
  if (sources.global !== undefined) return { value: sources.global, source: "global" };
  return { value: sources.default, source: "default" };
}
