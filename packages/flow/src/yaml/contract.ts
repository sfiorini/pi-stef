import type { FlowYaml, PhaseDef } from "./schema.js";

/** Names published by a phase: out (shorthand) + outputs.publish keys + "slug" if it derives one. */
export function publishedNames(ph: PhaseDef): string[] {
  const names = new Set<string>();
  if (ph.out) names.add(ph.out);
  if (ph.outputs?.publish) for (const k of Object.keys(ph.outputs.publish)) names.add(k);
  if (ph.outputs?.slug) names.add("slug");
  return [...names];
}

/** Names required by a phase: in (shorthand) + inputs.require. */
export function requiredNames(ph: PhaseDef): string[] {
  const names = new Set<string>();
  if (ph.in) Array.isArray(ph.in) ? ph.in.forEach((n) => names.add(n)) : names.add(ph.in);
  if (ph.inputs?.require) ph.inputs.require.forEach((n) => names.add(n));
  return [...names];
}

/** Reserved always-available inputs (never require these). */
export const BUILTIN_INPUTS = new Set(["input", "flow"]);

/**
 * Walk phases in order; return the set of names available BEFORE the phase at
 * `index` (built-in inputs + everything published by earlier phases).
 */
export function availableBefore(flow: FlowYaml, index: number): Set<string> {
  const avail = new Set<string>(BUILTIN_INPUTS);
  flow.phases.slice(0, index).forEach((ph) => publishedNames(ph).forEach((n) => avail.add(n)));
  return avail;
}

/** Template path -> resolved filesystem path, or null if unresolvable. */
export type TemplateResolver = (ref: string) => string | null;
