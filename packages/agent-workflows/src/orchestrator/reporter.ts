import {
  addWorkflowMessage,
  expireWorkflowMessages,
  renderWorkflowMessages,
  type WorkflowMessage,
  type WorkflowMessageLevel,
} from "../widget/messages";

export interface WorkflowReporterMessageOptions {
  id?: string;
  level?: WorkflowMessageLevel;
  ttlMs?: number;
}

export interface WorkflowReporter {
  message(text: string, opts?: WorkflowReporterMessageOptions): string;
  clearMessage(id: string): void;
  dispose(): void;
}

export interface WorkflowReporterOptions {
  getMessages?: () => readonly WorkflowMessage[];
  setMessages?: (messages: WorkflowMessage[]) => void;
  render?: () => void;
  headless?: boolean;
  stderr?: { write(chunk: string | Uint8Array): unknown };
  nowMs?: () => number;
  setTimeoutFn?: typeof setTimeout;
  clearTimeoutFn?: typeof clearTimeout;
}

const DEFAULT_TTL_MS: Record<WorkflowMessageLevel, number> = {
  info: 8_000,
  warning: 12_000,
  error: 20_000,
};

export function createWorkflowReporter(opts: WorkflowReporterOptions = {}): WorkflowReporter {
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const nowMs = opts.nowMs ?? Date.now;
  const setTimeoutFn = opts.setTimeoutFn ?? setTimeout;
  const clearTimeoutFn = opts.clearTimeoutFn ?? clearTimeout;
  let disposed = false;

  const hasStore = (): boolean => typeof opts.getMessages === "function" && typeof opts.setMessages === "function";
  const getMsgs = (): readonly WorkflowMessage[] => opts.getMessages?.() ?? [];
  const setMsgs = (msgs: WorkflowMessage[]): void => { opts.setMessages?.(msgs); };

  const clearTimer = (id: string): void => {
    const timer = timers.get(id);
    if (!timer) return;
    clearTimeoutFn(timer);
    timers.delete(id);
  };

  const scheduleExpiration = (message: WorkflowMessage): void => {
    clearTimer(message.id);
    if (message.expiresAtMs === undefined) return;
    const delayMs = Math.max(0, message.expiresAtMs - nowMs());
    const timer = setTimeoutFn(() => {
      timers.delete(message.id);
      if (disposed || !hasStore()) return;
      const current = getMsgs();
      const next = expireWorkflowMessages(current, nowMs());
      if (next.length === current.length) return;
      setMsgs(next);
      opts.render?.();
    }, delayMs);
    timer.unref?.();
    timers.set(message.id, timer);
  };

  const writeFallback = (message: WorkflowMessage): void => {
    const stderr = opts.stderr ?? process.stderr;
    try {
      stderr.write(`${renderWorkflowMessages([message])[0]}\n`);
    } catch {
      // best-effort status reporting
    }
  };

  return {
    message(text: string, messageOpts: WorkflowReporterMessageOptions = {}): string {
      const level = messageOpts.level ?? "info";
      const ttlMs = messageOpts.ttlMs ?? DEFAULT_TTL_MS[level];
      const currentNowMs = nowMs();
      const nextMessages = addWorkflowMessage(
        hasStore() && !disposed ? getMsgs() : [],
        { id: messageOpts.id, level, text, ttlMs },
        currentNowMs,
      );
      const message = nextMessages[nextMessages.length - 1];
      if (!message) return messageOpts.id ?? "";

      if (opts.headless || !hasStore()) {
        writeFallback(message);
      }

      if (!disposed && hasStore()) {
        setMsgs(nextMessages);
        opts.render?.();
        scheduleExpiration(message);
      }

      return message.id;
    },

    clearMessage(id: string): void {
      clearTimer(id);
      if (disposed || !hasStore()) return;
      const current = getMsgs();
      const next = current.filter((message) => message.id !== id);
      if (next.length === current.length) return;
      setMsgs(next);
      opts.render?.();
    },

    dispose(): void {
      if (disposed) return;
      disposed = true;
      for (const id of timers.keys()) clearTimer(id);
    },
  };
}
