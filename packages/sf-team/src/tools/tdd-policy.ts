/**
 * Canonical strict-TDD policy text shared across every sf_team_*
 * developer/reviewer/planner prompt. Centralized so prompts cannot drift
 * across task, followup, implement, auto, and plan tools.
 */

export type TddMode = "auto" | "on" | "off";
export type GitMode = "on" | "off";

export interface TddPolicyInput {
  tddMode?: TddMode;
  gitMode?: GitMode;
}

/** Returns true when the workflow requires a TDD proof block in the handoff. */
export function tddRequiresProof(tddMode: TddMode): boolean {
  return tddMode !== "off";
}

/** Returns true when the developer may use the no-test-needed shortcut. */
export function tddAllowsSkipShortcut(tddMode: TddMode): boolean {
  return tddMode !== "on";
}

export function composeTddContract(input: TddPolicyInput = {}): string {
  const tddMode = input.tddMode ?? "auto";
  const gitMode = input.gitMode ?? "on";

  if (tddMode === "off") return "";

  const step3 = gitMode === "on"
    ? "3. **Implement the change.** Stage only files you touched (never `git add -A`)."
    : "3. **Implement the change.** Include the file changes in the `## Changes` block of your handoff.";

  const lines = [
    "",
    "## Mandatory test-first contract",
    "",
    "BEFORE writing any non-test code you MUST:",
    "",
    "1. **Write the test(s)** that capture the new/changed behavior. Add them to a *.test.ts (or *.spec.ts) file colocated with existing tests for the area you are touching.",
    "2. **Run them and confirm they fail (RED).** Use a targeted command (e.g. `pnpm -F <pkg> test path/to/the.test.ts` or `pnpm -F <pkg> test -t \"<test-name>\"`). Show that the test fails for the right reason — assertion failure on the new behavior, not a syntax error or import miss.",
    step3,
    "4. **Re-run the SAME targeted command and confirm GREEN.** ALL tests in the touched test file(s) — both the new ones and any pre-existing tests in those files — must pass. Do NOT run the full suite; the orchestrator runs the configured verification gate (typecheck + full test) after impl-review approval.",
    "",
    "Your handoff prose to the reviewer MUST include a section titled `## TDD proof` with the four labeled subsections:",
    "",
    "  ### Tests added",
    "  - `<file>::<test-name>` — one-line description per test",
    "",
    "  ### Red",
    "  ```",
    "  <verbatim output of step 2: command + the failure tail>",
    "  ```",
    "",
    "  ### Implementation",
    "  - One line summarizing what changed and why it now satisfies the test.",
    "",
    "  ### Green",
    "  ```",
    "  <verbatim output of step 4: command + the pass summary line>",
    "  ```",
    "",
  ];

  const diffRef = gitMode === "off" ? "diff" : "staged diff";

  if (tddMode === "on") {
    lines.push(
      "The `no-test-needed:` escape hatch is forbidden in strict TDD mode. Every change must have an accompanying test.",
    );
  } else {
    lines.push(
      "If the change is genuinely test-irrelevant (docs, README, package.json bumps, type-only signature changes with no runtime branch), replace the `## TDD proof` section with a single line:",
      "",
      "  `no-test-needed: <one-sentence reason citing why no behavior changed>`",
      "",
      `The reviewer will reject your handoff (P0 finding) if this proof block is missing or if the no-test-needed rationale is unconvincing for the ${diffRef}.`,
    );
  }

  return lines.join("\n");
}

/**
 * Appended to every reviewer prompt (round-1 kickoff and revise-round
 * prompts). Tells the reviewer to enforce the TDD contract.
 */
export function REVIEWER_TDD_POLICY(input: TddPolicyInput = {}): string {
  const tddMode = input.tddMode ?? "auto";
  const gitMode = input.gitMode ?? "on";

  if (tddMode === "off") return "";

  const diffRef = gitMode === "off" ? "diff" : "staged diff";

  if (tddMode === "on") {
    return [
      "",
      "## TDD enforcement",
      "",
      "The developer is bound by a strict test-first contract. The handoff prose MUST contain a `## TDD proof` section with `### Tests added`, `### Red`, `### Implementation`, `### Green` subsections.",
      "",
      "The escape hatch `no-test-needed: <reason>` is not acceptable and is disallowed in strict (`on`) TDD mode. Every diff must have an accompanying test.",
      "",
      `If the proof block is missing, issue a P0 finding ("TDD proof missing") and \`VERDICT: REVISE\`. Do NOT approve solely because the ${diffRef} looks correct — without the proof, you cannot tell whether the developer actually exercised the change.`,
    ].join("\n");
  }

  return [
    "",
    "## TDD enforcement",
    "",
    `The developer is bound by a strict test-first contract. The handoff prose MUST contain a \`## TDD proof\` section with \`### Tests added\`, \`### Red\`, \`### Implementation\`, \`### Green\` subsections. The single-line escape hatch \`no-test-needed: <reason>\` is acceptable ONLY when the ${diffRef} is non-code (docs / config / type-only).`,
    "",
    `If the proof block is missing OR the no-test-needed rationale is unconvincing for the ${diffRef}, issue a P0 finding ("TDD proof missing" or "unconvincing no-test-needed rationale: <why>") and \`VERDICT: REVISE\`. Do NOT approve solely because the ${diffRef} looks correct — without the proof, you cannot tell whether the developer actually exercised the change.`,
  ].join("\n");
}

/**
 * Appended to planner brief + planner revise prompts. Pushes the
 * planner to schedule tests-first stories.
 */
export function PLANNER_TDD_REMINDER(input: TddPolicyInput = {}): string {
  const tddMode = input.tddMode ?? "auto";

  if (tddMode === "off") return "";

  if (tddMode === "on") {
    return [
      "",
      "## Test-first planning reminder",
      "",
      "The downstream developer agent is bound by a strict test-first contract: write the test(s), confirm RED, implement, confirm GREEN. Lay out the plan body so each story explicitly schedules its test step BEFORE the implementation step. The `no-test-needed:` escape hatch is forbidden in strict (`on`) TDD mode — every story must include a test step.",
    ].join("\n");
  }

  return [
    "",
    "## Test-first planning reminder",
    "",
    "The downstream developer agent is bound by a strict test-first contract: write the test(s), confirm RED, implement, confirm GREEN. Lay out the plan body so each story explicitly schedules its test step BEFORE the implementation step. For test-irrelevant work (docs / config / type-only) you may omit the test step; flag those stories explicitly with `no-test-needed: <reason>`.",
  ].join("\n");
}
