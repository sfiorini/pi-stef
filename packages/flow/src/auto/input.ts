export type InputKind = "prompt" | "md-file" | "prd" | "jira";

export interface ClassifiedInput {
  kind: InputKind;
  value: string;
}

/**
 * Classify a raw sf_flow_auto input string into one of the four input kinds.
 * - `jira <KEY-N>` → jira (value = the issue key)
 * - `*.md` / `path/to.md` → md-file (value = the path)
 * - `prd:<path>` / `*.prd` → prd (value = the path)
 * - anything else → prompt (value = the verbatim text)
 */
export function classifyInput(raw: string): ClassifiedInput {
  const s = raw.trim();
  if (/^jira\s+/i.test(s)) return { kind: "jira", value: resolveJiraRef(s) };
  if (/\.md$/i.test(s) || /^\.?\/.+\.md$/i.test(s)) return { kind: "md-file", value: s };
  if (/\.prd$/i.test(s) || /^prd:/i.test(s)) return { kind: "prd", value: s.replace(/^prd:\s*/i, "") };
  return { kind: "prompt", value: s };
}

/** Extract a Jira issue key (e.g. PROJ-123) from a `jira ...` string. */
export function resolveJiraRef(raw: string): string {
  const m = raw.match(/([A-Z][A-Z0-9_]+-\d+)/);
  return m ? m[1] : raw.replace(/^jira\s+/i, "");
}
