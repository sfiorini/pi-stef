import { analyzeResumeTarget, type ResumeAnalysis, type WorkflowToolName } from "@pi-stef/agent-workflows";

export interface ResumeInputShape {
  resume?: string;
}

export interface ResolveToolResumeInput {
  repoRoot: string;
  toolName: WorkflowToolName;
  input: ResumeInputShape & object;
  normalField: string;
  /** Candidate planRoot directories for the resume cascade (prompt root → config root → index). */
  candidatePlanRoots?: string[];
}

export async function resolveToolResume(input: ResolveToolResumeInput): Promise<ResumeAnalysis | undefined> {
  const resume = stringValue(input.input.resume);
  const normal = stringValue((input.input as Record<string, unknown>)[input.normalField]);
  if (resume && normal) {
    throw new Error(`${input.toolName}: provide either ${input.normalField} or resume, not both`);
  }
  if (!resume && !normal) {
    throw new Error(`${input.toolName}: provide either ${input.normalField} or resume`);
  }
  if (!resume) return undefined;
  return analyzeResumeTarget({
    repoRoot: input.repoRoot,
    target: resume,
    invokedTool: input.toolName,
    candidatePlanRoots: input.candidatePlanRoots,
  });
}

export function normalOrResumeValue(
  input: ResumeInputShape & object,
  normalField: string,
  resume: ResumeAnalysis | undefined,
): string {
  const normal = stringValue((input as Record<string, unknown>)[normalField]);
  if (normal) return normal;
  if (resume) return resume.target.slug;
  throw new Error(`missing ${normalField}`);
}

function stringValue(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}
