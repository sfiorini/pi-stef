export type WorkflowMessageLevel = "info" | "warning" | "error";

export interface WorkflowMessage {
  id: string;
  level: WorkflowMessageLevel;
  text: string;
  createdAtMs: number;
  expiresAtMs?: number;
}

export interface AddWorkflowMessageInput {
  id?: string;
  level?: WorkflowMessageLevel;
  text: string;
  ttlMs?: number;
}

export const MAX_WORKFLOW_MESSAGES = 5;
export const WORKFLOW_MESSAGE_MAX_CHARS = 140;

export function createWorkflowMessage(
  input: AddWorkflowMessageInput,
  nowMs = Date.now(),
): WorkflowMessage {
  const message: WorkflowMessage = {
    id: input.id ?? generatedMessageId(nowMs),
    level: input.level ?? "info",
    text: truncateWorkflowMessageText(input.text),
    createdAtMs: nowMs,
  };
  if (input.ttlMs !== undefined && Number.isFinite(input.ttlMs) && input.ttlMs >= 0) {
    message.expiresAtMs = nowMs + Math.floor(input.ttlMs);
  }
  return message;
}

export function addWorkflowMessage(
  messages: readonly WorkflowMessage[],
  input: AddWorkflowMessageInput,
  nowMs = Date.now(),
): WorkflowMessage[] {
  const message = createWorkflowMessage(input, nowMs);
  const withoutSameId = messages.filter((candidate) => candidate.id !== message.id);
  return [...withoutSameId, message].slice(-MAX_WORKFLOW_MESSAGES);
}

export function expireWorkflowMessages(
  messages: readonly WorkflowMessage[],
  nowMs = Date.now(),
): WorkflowMessage[] {
  return messages.filter((message) => message.expiresAtMs === undefined || message.expiresAtMs > nowMs);
}

export function renderWorkflowMessages(messages: readonly WorkflowMessage[]): string[] {
  return messages.map((message) => `${renderLevel(message.level)}: ${message.text}`);
}

export function truncateWorkflowMessageText(text: string): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= WORKFLOW_MESSAGE_MAX_CHARS) return normalized;
  return `${normalized.slice(0, WORKFLOW_MESSAGE_MAX_CHARS - 3).trimEnd()}...`;
}

function generatedMessageId(nowMs: number): string {
  return `workflow-message-${nowMs}-${crypto.randomUUID().slice(0, 8)}`;
}

function renderLevel(level: WorkflowMessageLevel): string {
  if (level === "warning") return "warn";
  return level;
}
