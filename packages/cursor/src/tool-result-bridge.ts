/** Result payload returned to SDK custom-tools when a pending call is resolved. */
export interface ToolBridgeResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

/** Internal deferred holder for a single pending tool call. */
interface Deferred {
  promise: Promise<ToolBridgeResult>;
  resolve: (result: ToolBridgeResult) => void;
  reject: (err: Error) => void;
}

export interface ToolResultBridge {
  /** Register a new pending tool call. Returns a promise that resolves when the
   *  result is supplied via `resolveFromToolResults`. */
  pending(
    toolCallId: string,
    _name: string,
    _argsJson: string,
  ): Promise<ToolBridgeResult>;

  /** True if at least one tool call is pending. */
  hasPending(): boolean;

  /** Return callIds of all currently pending tool calls. */
  pendingToolCallIds(): string[];

  /** Resolve matching pending calls from tool-result messages. Returns the
   *  resolved callIds. Unknown callIds are ignored. */
  resolveFromToolResults(
    results: Array<{ toolCallId: string; text: string; isError?: boolean }>,
  ): string[];

  /** Reject every pending call with the given error. */
  rejectAll(err: Error): void;

  /** Resolves the first time `pending()` is called after a 0→1 transition.
   *  Re-arms when pending count returns to 0. */
  whenPending(): Promise<void>;
}

export function createToolResultBridge(): ToolResultBridge {
  const pendingMap = new Map<string, Deferred>();

  // whenPending machinery: deferred that fires on next 0→1 transition
  let whenPendingDeferred: Deferred | null = null;
  let whenPendingArmed = true;

  function armWhenPending(): void {
    // Create a fresh deferred for the next 0→1 transition
    let resolve!: () => void;
    const promise = new Promise<void>((r) => {
      resolve = r;
    });
    whenPendingDeferred = {
      promise: promise as unknown as Promise<ToolBridgeResult>,
      resolve: resolve as unknown as (r: ToolBridgeResult) => void,
      reject: () => {},
    };
    whenPendingArmed = true;
  }

  // Arm initially so the first 0→1 transition fires
  armWhenPending();

  function pending(
    toolCallId: string,
    _name: string,
    _argsJson: string,
  ): Promise<ToolBridgeResult> {
    const wasEmpty = pendingMap.size === 0;

    let resolve!: (result: ToolBridgeResult) => void;
    let reject!: (err: Error) => void;
    const promise = new Promise<ToolBridgeResult>((res, rej) => {
      resolve = res;
      reject = rej;
    });

    pendingMap.set(toolCallId, { promise, resolve, reject });

    // 0→1 transition: fire whenPending
    if (wasEmpty && whenPendingArmed && whenPendingDeferred) {
      const def = whenPendingDeferred;
      whenPendingDeferred = null;
      whenPendingArmed = false;
      // Resolve asynchronously so the caller can await pending() first
      queueMicrotask(() =>
        (def.resolve as unknown as (v: void) => void)(undefined),
      );
    }

    return promise;
  }

  function hasPending(): boolean {
    return pendingMap.size > 0;
  }

  function pendingToolCallIds(): string[] {
    return Array.from(pendingMap.keys());
  }

  function resolveFromToolResults(
    results: Array<{ toolCallId: string; text: string; isError?: boolean }>,
  ): string[] {
    const resolved: string[] = [];
    for (const r of results) {
      const def = pendingMap.get(r.toolCallId);
      if (!def) continue;
      pendingMap.delete(r.toolCallId);
      def.resolve({
        content: [{ type: "text", text: r.text }],
        isError: r.isError,
      });
      resolved.push(r.toolCallId);
    }

    // Re-arm whenPending when all pending calls are drained
    if (pendingMap.size === 0 && !whenPendingArmed) {
      armWhenPending();
    }

    return resolved;
  }

  function rejectAll(err: Error): void {
    for (const def of pendingMap.values()) {
      def.reject(err);
    }
    pendingMap.clear();

    // Re-arm whenPending after drain
    if (!whenPendingArmed) {
      armWhenPending();
    }
  }

  function whenPending(): Promise<void> {
    if (!whenPendingDeferred) {
      // Already fired and not yet re-armed — arm now so the NEXT 0→1 fires
      armWhenPending();
    }
    return whenPendingDeferred!.promise as unknown as Promise<void>;
  }

  return {
    pending,
    hasPending,
    pendingToolCallIds,
    resolveFromToolResults,
    rejectAll,
    whenPending,
  };
}
