/**
 * Strip the `<details>…</details>` block that qwen.aikit.club appends to
 * non-streaming responses (contains Response ID / Request ID junk).
 *
 * Two modes:
 * - `stripDetails(text)` — regex strip for non-stream responses.
 * - `DetailsStreamStripper` — streaming-safe 9-char hold-back class for
 *   chunk-by-chunk stripping (OpenAI + Anthropic adapters).
 */

const DETAILS_RE = /<details>[\s\S]*?<\/details>\s*$/;

/** Non-stream: strip trailing `<details>…</details>` block + trimEnd. */
export function stripDetails(text: string): string {
  return text.replace(DETAILS_RE, "").trimEnd();
}

/**
 * Streaming-safe details stripper.
 *
 * Holds back the last 9 characters (`<details>`.length) of each push to
 * detect the opening tag even when it's split across chunks. Once the tag
 * is seen, the stripper *seals* — all subsequent data is dropped.
 * `finalize()` regex-strips any residual buffer content as a backstop.
 */
export class DetailsStreamStripper {
  private buffer = "";
  private sealed = false;
  private static OPEN = "<details>"; // length 9
  private static OPEN_LEN = 9;

  /**
   * Feed a content delta. Returns the safe-to-emit text (may be "").
   * After sealing, always returns "".
   */
  push(chunk: string): string {
    if (this.sealed) return "";

    this.buffer += chunk;

    // Emit any holdback from previous push (safe — it was buffered long
    // enough to check for a partial tag last time, and the new chunk
    // didn't create a tag match at the boundary).
    const holdback =
      this.buffer.length > DetailsStreamStripper.OPEN_LEN
        ? this.buffer.slice(
            0,
            this.buffer.length - DetailsStreamStripper.OPEN_LEN,
          )
        : "";

    // Now check for <details> in the FULL buffer (including the 9-char tail).
    const idx = this.buffer.indexOf(DetailsStreamStripper.OPEN);
    if (idx !== -1) {
      // Tag found — seal and emit everything before it.
      this.sealed = true;
      const safe = this.buffer.slice(0, idx);
      this.buffer = "";
      return safe;
    }

    // No tag — safe to emit the holdback portion.
    if (holdback) {
      this.buffer = this.buffer.slice(
        this.buffer.length - DetailsStreamStripper.OPEN_LEN,
      );
      return holdback;
    }

    // Buffer ≤ OPEN_LEN — keep holding
    return "";
  }

  /**
   * Flush remaining buffer. If not sealed, regex-strip any residual
   * `<details>…</details>` as a backstop.
   */
  finalize(): string {
    if (this.sealed) {
      this.buffer = "";
      return "";
    }
    const remaining = stripDetails(this.buffer);
    this.buffer = "";
    return remaining;
  }
}
