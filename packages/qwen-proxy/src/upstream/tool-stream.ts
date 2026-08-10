/**
 * Streaming-safe tool-call detector.
 *
 * Mirrors DetailsStreamStripper but for `<tool_calls>` blocks.
 *
 * State machine: NORMAL → BUFFERING → SEALED
 *
 * NORMAL:    Forward content, hold back last 12 chars to detect `<tool_calls>` prefix
 * BUFFERING: Accumulating content inside the tag until `</tool_calls>` is seen
 * SEALED:    Tag fully seen — all subsequent content is dropped (Q5)
 *
 * 12-char hold-back = `<tool_calls>`.length — so even if the tag is split
 * across two chunks, we detect it.
 *
 * Q4: stream ends mid-`<tool_calls>` → finalize() discards buffer, no tool calls
 * Q5: content after `</tool_calls>` → suppressed
 */

const TAG_OPEN = "<tool_calls>";
const TAG_OPEN_LEN = TAG_OPEN.length; // 12
const TAG_CLOSE = "</tool_calls>";

export interface ToolStreamResult {
  /** Content safe to emit. Empty string = nothing to emit this push. Undefined = field not present (sealed). */
  content?: string;
  /** True when a full `<tool_calls>...</tool_calls>` block has been captured. */
  toolCallsReady?: boolean;
}

type DetectorState = "NORMAL" | "BUFFERING" | "SEALED";

export class ToolStreamDetector {
  private state: DetectorState = "NORMAL";
  private buffer = "";
  private tagBlock = "";

  /** The full `<tool_calls>...</tool_calls>` span, available after SEALED. */
  get completedBlock(): string {
    return this.tagBlock;
  }

  /**
   * Feed a content delta. Returns the safe-to-emit content and whether
   * tool calls are ready to parse.
   *
   * - NORMAL:  hold back last TAG_OPEN_LEN chars; emit everything else
   * - BUFFERING: accumulate until `</tool_calls>` is found → transition to SEALED
   * - SEALED:  drop everything (Q5) — returns {} (content field absent)
   */
  push(chunk: string): ToolStreamResult {
    switch (this.state) {
      case "NORMAL":
        return this.pushNormal(chunk);
      case "BUFFERING":
        return this.pushBuffering(chunk);
      case "SEALED":
        return {}; // Q5: content after tag is suppressed (field absent = undefined)
    }
  }

  /**
   * Flush remaining buffer. Behavior by state:
   * - NORMAL:     emit remaining content (as content field)
   * - BUFFERING:  discard (Q4 — mid-tag end) — returns {} (content field absent)
   * - SEALED:     returns {} (content field absent)
   */
  finalize(): ToolStreamResult {
    switch (this.state) {
      case "NORMAL": {
        const remaining = this.buffer;
        this.buffer = "";
        return { content: remaining }; // may be ""
      }
      case "BUFFERING": {
        // Q4: mid-tag end → discard
        this.buffer = "";
        this.state = "NORMAL";
        return {}; // content field absent = undefined
      }
      case "SEALED":
        return {};
    }
  }

  // ── NORMAL state ──────────────────────────────────────────────────────

  private pushNormal(chunk: string): ToolStreamResult {
    this.buffer += chunk;

    // Check if the tag open appears in the buffer
    const idx = this.buffer.indexOf(TAG_OPEN);
    if (idx !== -1) {
      // Tag found — emit content before the tag, start buffering from tag start
      const safeContent = this.buffer.slice(0, idx);
      this.buffer = this.buffer.slice(idx); // includes the tag
      this.state = "BUFFERING";
      // Re-enter buffering to check if close tag is also present
      const bufferingResult = this.pushBuffering("");
      return { content: safeContent, ...bufferingResult };
    }

    // No tag found — emit safe content (hold back last TAG_OPEN_LEN chars)
    if (this.buffer.length > TAG_OPEN_LEN) {
      const safe = this.buffer.slice(0, this.buffer.length - TAG_OPEN_LEN);
      this.buffer = this.buffer.slice(this.buffer.length - TAG_OPEN_LEN);
      return { content: safe };
    }

    // Buffer is ≤ TAG_OPEN_LEN — hold everything (content = "")
    return { content: "" };
  }

  // ── BUFFERING state ───────────────────────────────────────────────────

  private pushBuffering(chunk: string): ToolStreamResult {
    this.buffer += chunk;

    // Look for closing tag
    const closeIdx = this.buffer.indexOf(TAG_CLOSE);
    if (closeIdx !== -1) {
      // Found — extract full tag span and seal
      const endIdx = closeIdx + TAG_CLOSE.length;
      this.tagBlock = this.buffer.slice(0, endIdx);
      this.buffer = "";
      this.state = "SEALED";
      return { toolCallsReady: true };
    }

    // Still buffering — nothing to emit
    return {};
  }
}
