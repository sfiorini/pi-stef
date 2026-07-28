/**
 * Atomic model-spec normalizer — the single chokepoint that guarantees a
 * resolved model spec is a **well-formed** `provider/modelId` (shape check;
 * does NOT validate against the model registry) or a bare registry id, and
 * NEVER a cross-source hybrid spliced from two different sources (the root
 * cause of Issue #2: buildFallbackModel in
 * @quintinshaw/pi-dynamic-workflows keeps one source's `provider` and
 * overwrites `id` from another).
 *
 * Contract: returns the validated spec string verbatim when well-formed,
 * and `null` when the spec is absent/empty/malformed. `null` means
 * "fall through to the next precedence tier / omit `model:` at dispatch
 * so pi-subagents applies the agent .md model: or inherits the orchestrator".
 * It NEVER invents or splices a provider+id pair.
 */
const MODEL_SPEC_RE = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;

/**
 * Validate an already-resolved model spec. Accepts:
 *   - `provider/modelId` (e.g. "anthropic/claude-opus-5")
 *   - a bare registry id with NO slash that is at least 2 chars and looks
 *     like an alias (known alias set) — these are passed through so legacy
 *     config values like "sonnet" keep working (pi-subagents / the registry
 *     resolves them downstream).
 * Rejects (returns null): empty string, whitespace-only, "/", "x/", "/y",
 * any value with a slash whose provider or id segment is empty, undefined, null.
 */
export function normalizeModelSpec(spec: string | undefined | null): string | null {
  if (spec == null) return null;
  const trimmed = String(spec).trim();
  if (trimmed.length === 0) return null;
  if (trimmed.includes("/")) {
    return MODEL_SPEC_RE.test(trimmed) ? trimmed : null;
  }
  // Bare alias / single-segment id: passthrough (registry resolves it).
  // We deliberately do NOT fabricate a provider prefix.
  return trimmed.length >= 2 ? trimmed : null;
}

/** True when normalizeModelSpec accepts the spec (non-null). */
export function isWellFormedModelSpec(spec: string | undefined | null): boolean {
  return normalizeModelSpec(spec) !== null;
}
