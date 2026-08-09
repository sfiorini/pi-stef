/**
 * SSE (Server-Sent Events) parser as an async generator over a ReadableStream.
 * Buffers bytes, splits on "\n\n" boundaries, and yields SseEvent objects.
 */

export interface SseEvent {
  event?: string;
  data: string;
}

/**
 * Parse a fetch Response body (ReadableStream<Uint8Array>) as an SSE stream.
 * Buffers incoming text, splits records on the blank-line boundary ("\n\n"),
 * parses "event:" and "data:" lines (consecutive "data:" lines concatenated
 * with "\n"), and yields one SseEvent per complete record.
 *
 * The literal `data: [DONE]` record is yielded as `{ data: "[DONE]" }` and
 * the generator returns (terminates).
 *
 * Tolerates "\r\n" line endings. Flushes any trailing data without a final
 * "\n\n" when the stream ends.
 */
export async function* parseSseStream(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<SseEvent> {
  const decoder = new TextDecoder();
  let buffer = "";

  const reader = body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // Normalize CRLF to LF so splitting on "\n\n" works universally
      buffer = buffer.replace(/\r\n/g, "\n");

      // Process complete records (delimited by \n\n)
      const parts = buffer.split("\n\n");
      // The last element may be an incomplete record — keep it in the buffer
      buffer = parts.pop() ?? "";

      for (const part of parts) {
        if (!part.trim()) continue; // skip empty records
        const event = parseRecord(part);
        if (event) {
          yield event;
          if (event.data === "[DONE]") return;
        }
      }
    }

    // Flush trailing data (stream ended without a final \n\n)
    if (buffer.trim()) {
      const event = parseRecord(buffer);
      if (event) {
        yield event;
      }
    }
  } finally {
    reader.releaseLock();
  }
}

/**
 * Parse a single SSE record (text between blank-line boundaries).
 * Returns null if the record is empty after parsing.
 */
function parseRecord(text: string): SseEvent | null {
  const lines = text.split("\n");
  let event: string | undefined;
  const dataLines: string[] = [];

  for (const rawLine of lines) {
    const line = rawLine.replace(/\r$/, ""); // strip trailing \r from CRLF
    if (!line) continue;
    if (line.startsWith(":")) continue; // comment

    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) continue; // skip malformed lines

    const field = line.slice(0, colonIdx);
    let value = line.slice(colonIdx + 1);
    if (value.startsWith(" ")) value = value.slice(1); // strip leading space

    switch (field) {
      case "event":
        event = value;
        break;
      case "data":
        dataLines.push(value);
        break;
      // "id:", "retry:", unknown fields are ignored
    }
  }

  if (dataLines.length === 0) return null;
  return { event, data: dataLines.join("\n") };
}
