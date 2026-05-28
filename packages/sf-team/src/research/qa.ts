import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import {
  legacyResearchAnswersPath,
  researchAnswersPath,
} from "@pi-stef/agent-workflows";

import { askResearchQuestion } from "./question-ui";
import type { ResearchAnalysis } from "./types";

export interface AskResearchQuestionsOptions {
  /** Used to read/write the per-plan resume cache. When omitted, no persistent caching. */
  repoRoot?: string;
  slug?: string;
  signal?: AbortSignal;
}

/**
 * Drive the research question UI for each `openQuestion` produced by the
 * researcher (and the orchestrator-appended unresolved external refs).
 *
 * Resume-stable caching: when `repoRoot` and `slug` are provided, prior
 * answers are persisted to `ai_plan/<slug>/research-answers.json`. On the
 * next invocation (resume), already-answered questions short-circuit
 * without re-prompting.
 *
 * Backwards compat: plans created before the dot-prefix was dropped wrote
 * `.research-answers.json` instead. Read-side falls back to the legacy
 * filename when the dotless file is absent; the writer always emits the
 * dotless name.
 */
export async function askResearchQuestions(
  analysis: ResearchAnalysis,
  ui: ExtensionUIContext,
  opts: AskResearchQuestionsOptions = {},
): Promise<Record<string, string>> {
  const persisted = await loadPersistedAnswers(opts.repoRoot, opts.slug);
  const answers: Record<string, string> = { ...persisted };

  for (const q of analysis.openQuestions) {
    if (answers[q.id] !== undefined) continue;
    const answer = await askResearchQuestion(ui, q, opts.signal);
    if (answer !== undefined && answer.trim() !== "") {
      answers[q.id] = answer;
      // Persist after each successful answer so an abort mid-questionnaire
      // doesn't lose progress on resume.
      await persistAnswers(opts.repoRoot, opts.slug, answers).catch(() => undefined);
    }
  }
  return answers;
}

async function loadPersistedAnswers(
  repoRoot: string | undefined,
  slug: string | undefined,
): Promise<Record<string, string>> {
  if (!repoRoot || !slug) return {};
  // Prefer the dotless file. Only fall back to the legacy dotted name when
  // the dotless file is *absent* (ENOENT). If the dotless file exists but
  // is corrupt or unreadable for any other reason, start fresh — never
  // silently restore stale answers from the legacy file.
  const dotlessAttempt = await tryReadAnswers(researchAnswersPath(repoRoot, slug));
  if (dotlessAttempt.kind === "ok") return dotlessAttempt.value;
  if (dotlessAttempt.kind === "corrupt") return {};
  // dotless file is missing — try the legacy fallback, then start fresh.
  const legacyAttempt = await tryReadAnswers(legacyResearchAnswersPath(repoRoot, slug));
  return legacyAttempt.kind === "ok" ? legacyAttempt.value : {};
}

type AnswersReadResult =
  | { kind: "ok"; value: Record<string, string> }
  | { kind: "missing" }
  | { kind: "corrupt" };

async function tryReadAnswers(filePath: string): Promise<AnswersReadResult> {
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "ENOENT" ? { kind: "missing" } : { kind: "corrupt" };
  }
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return { kind: "ok", value: parsed as Record<string, string> };
    }
  } catch {
    // fall through
  }
  return { kind: "corrupt" };
}

async function persistAnswers(
  repoRoot: string | undefined,
  slug: string | undefined,
  answers: Record<string, string>,
): Promise<void> {
  if (!repoRoot || !slug) return;
  // Always write the dotless filename. We do not delete the legacy file so
  // a manual rollback to the previous code still works on existing plans.
  const target = researchAnswersPath(repoRoot, slug);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, JSON.stringify(answers, null, 2), "utf8");
}
