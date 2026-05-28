#!/usr/bin/env node
/**
 * pretty-pane — convert pi's line-delimited JSON event stream into
 * human-readable lines suitable for a tmux pane (or any TTY).
 *
 * Run pattern (the pane invokes this from `tail -F <log>`):
 *
 *     tail -F <agent-raw.log> | node pretty-pane.mjs
 *
 * THEMES
 *   - `plain`   — emoji-led, line-per-event renderer (preserves verbatim
 *                 historical behavior; tests assert byte-identity).
 *   - `codex`   — DEFAULT. Mirrors the OpenAI Codex CLI transcript:
 *                 every block leads with a red `▌` left-bar marker followed
 *                 by an action-type-colored label (Ran cyan, Edited magenta,
 *                 Explored blue, Reviewed yellow, Thinking dim, Error red,
 *                 Completed green, Working... dim, Session started dim).
 *                 Tool execution lines indent under the marker with `│`/`└`
 *                 children, and `Edited` blocks render the underlying
 *                 unified diff inline with line numbers when pi's `edit`
 *                 tool emits `evt.result.details.diff` +
 *                 `evt.result.details.firstChangedLine` (verified shape:
 *                 node_modules/@earendil-works/pi-coding-agent/dist/core/tools/edit.js
 *                 lines 240–250).
 *
 * MARKDOWN STREAMING (codex theme only)
 *   When the assistant streams a `text_start`/`text_delta`/`text_end`
 *   triplet (event names verified at
 *   node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai/dist/types.d.ts:191-215),
 *   we:
 *     1. Write each `text_delta` raw immediately (live feel preserved).
 *     2. Buffer the deltas in `mdStreamState.raw` keyed by `contentIndex`.
 *     3. On `text_end` (or defensive `agent_end` flush), if `raw` matches
 *        the MD-detection regex (heading/bold/list/code/etc.), compute
 *        wrap-aware `linesEmitted = Σ ceil(visibleLength(line)/CODEX_COLUMNS)`
 *        over `raw.replace(/\n$/, "").split("\n")` (the trailing-newline
 *        strip avoids the off-by-one when raw ends with `\n`).
 *     4. Branch A (safe rewind): if `linesEmitted < paneRows - 2`, emit
 *        `linesEmitted` reps of `\x1b[1A\r\x1b[2K` to clear the streamed
 *        rows, then write `marked.parse(raw)`, then `\x1b[J` to wipe any
 *        residue when the rendered MD is shorter than the raw.
 *     5. Branch B (overflow): if streaming would exceed the safe-rewind
 *        threshold, append `\n── markdown ──\n` then `marked.parse(raw)`
 *        BELOW the raw stream — no rewind. The raw remains readable.
 *     6. The heartbeat ticker (the only writer that could mis-align the
 *        rewind) early-returns while `mdStreamState.active === true`.
 *     7. `marked.parse()` is wrapped in try/catch; on throw we re-emit
 *        `raw` byte-for-byte (Branch A) or skip the divider (Branch B) so
 *        a renderer bug never strands the user with a half-erased pane.
 *
 *   Tests can force a `marked.parse` failure via `vi.spyOn(marked, 'parse')`
 *   — there is no production-side env knob for this.
 *
 *   Out-of-scope (acknowledged, not handled):
 *     - Mid-stream PTY resize between `text_start` and `text_end`.
 *     - Mid-text `tool_execution_*` interleaving (pi does not currently
 *       emit this; if it ever does, the rewind would miscount).
 *
 * RUNTIME DEPS
 *   `marked@^15` + `marked-terminal@^7`, both pure ESM.
 *   `marked-terminal@7` requires `marked@>=1 <16` — do not bump `marked`
 *   past 15.x without verifying compatibility.
 *
 * Recognized events (matching pi's `--mode json` protocol as observed
 * in real runs of pi-coding-agent ≥ 0.70):
 *
 *   Lifecycle:
 *     agent_start              → "▌ Session started" (codex) / "▶ session started" (plain)
 *     agent_end                → "<sep>\n▌ Completed" (codex) / "✓ done" (plain) + optional finalText
 *     error                    → "▌ Error <message>" (codex) / "✗ <message>" (plain)
 *     stalled / aborted / exit → "▌ <kind>" (codex) / "[<kind>]" (plain)
 *
 *   Tool execution (RICH — what most users care about):
 *     tool_execution_start     → "🔧 <toolName>(<args>)"
 *     tool_execution_update    → "   │ <newly-streamed line>" — pi sends
 *                                CUMULATIVE snapshots in
 *                                `partialResult.content[*].text`; we track
 *                                the bytes already rendered per
 *                                `toolCallId` and emit only the NEW
 *                                characters, split by newlines so each
 *                                line of bash output gets its own
 *                                indented marker.
 *     tool_execution_end       → "   ↳ <result preview>" — but ONLY when
 *                                no updates streamed content (otherwise
 *                                the user would see the same body twice).
 *                                On `isError=true`, renders
 *                                "   ✗ <error preview>" instead.
 *     tool_call (legacy)       → same render as tool_execution_start
 *     tool_result (legacy)     → same render as tool_execution_end
 *
 *   Streaming content (the model's actual output, character-by-character):
 *     message_update           → dispatch on `assistantMessageEvent.type`:
 *       text_delta             → write delta verbatim (the visible answer)
 *       thinking_delta         → write delta verbatim under "💭 thinking:"
 *       text_start             → emit "" (just opens the section)
 *       thinking_start         → emit "💭 thinking:"
 *       text_end / thinking_end→ flush trailing newline
 *       toolcall_*             → suppressed (tool_execution_* shows the
 *                                full info; the per-arg-character delta
 *                                stream is just noise)
 *     message_delta (legacy)   → write delta verbatim
 *     text_delta    (legacy)   → write delta verbatim
 *
 *   Structural (suppressed — they were the bulk of the bracket noise
 *   that prompted this rewrite):
 *     session, turn_start, turn_end, message_start, message_end
 *
 *   Unknown event types fall through to "[<type>]" so nothing
 *   silently disappears.
 *
 * Liveness heartbeat:
 *   When no event has arrived in the last
 *   `PRETTY_PANE_HEARTBEAT_THRESHOLD_MS` ms (default 30_000), the script
 *   emits ONE `⏳ working…` line so the user knows the subprocess is
 *   alive during the long time-to-first-token gap on a developer's
 *   first inference (large prompt + thinking budget). Resets on any
 *   subsequent event so the next silent gap also gets one tick.
 *   Interval cadence is `PRETTY_PANE_HEARTBEAT_INTERVAL_MS` (default
 *   5_000); both are env-var-tunable for fast tests.
 *
 * Output is stdout-only. We never crash on malformed JSON; bad lines
 * pass through verbatim (sanitized of C0 control bytes so a hostile
 * log line cannot smuggle ANSI escapes into the surrounding tmux UI).
 */

import readline from "node:readline";

// NOTE: We do NOT create the readline interface here. The top-level
// `await import("marked")` further down would race against incoming
// stdin lines (readline reads eagerly; line events fire before our
// handler is attached, and event-emitter semantics drop them silently).
// We create rl AFTER both imports resolve and handlers are bound — see
// the bottom of the file.
let rl;

const THEME = selectTheme();
const CODEX_SEPARATOR = "────────────────────────────────────────";
const CODEX_MARKER = "▌";
const CODEX_MD_DIVIDER = "── markdown ──";
const ANSI = {
  reset: "\x1b[0m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
  dim: "\x1b[2m",
};

/**
 * Per-action label colors for the codex theme. Looked up by the canonical
 * label string (the same string emitted to the pane). The marker `▌` is
 * always painted ANSI red regardless of label; only the label itself
 * receives this color.
 */
const CODEX_LABEL_COLORS = {
  Ran: ANSI.cyan,
  Edited: ANSI.magenta,
  Explored: ANSI.blue,
  Reviewed: ANSI.yellow,
  Thinking: ANSI.dim,
  Error: ANSI.red,
  Completed: ANSI.green,
  "Working...": ANSI.dim,
  "Session started": ANSI.dim,
};

/**
 * MD detection regexes. ANY match triggers the rewind/re-render branch;
 * NO match skips re-render entirely (raw stream stays byte-identical).
 */
const MD_DETECTION_REGEXES = [
  /^#{1,6} /m,           // ATX heading
  /```/,                 // fenced code
  /\*\*[^*]+\*\*/,       // bold
  /__[^_]+__/,           // alt bold
  /`[^`\n]+`/,           // inline code span
  /^\s*[-*+] /m,         // unordered list
  /^\s*\d+\. /m,         // ordered list
  /^> /m,                // blockquote
  /\[[^\]]+\]\([^)]+\)/, // link
  /~~[^~]+~~/,           // strikethrough
  /^\|.*\|/m,            // table row
];

function selectTheme() {
  const raw = (process.env.PRETTY_PANE_THEME || process.env.SF_TEAM_PANE_THEME || "").trim().toLowerCase();
  return raw === "plain" ? "plain" : "codex";
}

function colorEnabled() {
  const mode = (process.env.PRETTY_PANE_COLOR || "auto").trim().toLowerCase();
  if (process.env.NO_COLOR || mode === "never" || mode === "none" || mode === "false" || mode === "0") return false;
  if (mode === "always" || mode === "true" || mode === "1") return true;
  return Boolean(process.stdout.isTTY);
}

const USE_COLOR = colorEnabled();
// marked-terminal uses chalk, which auto-detects TTY. Symmetrical FORCE_COLOR
// override BEFORE marked-terminal is imported so its internal Chalk instance
// matches our colorEnabled() decision in both directions:
//   - USE_COLOR=true  but stdout is a pipe → FORCE_COLOR=3 to enable colors.
//   - USE_COLOR=false but stdout is a TTY  → FORCE_COLOR=0 to disable colors
//     (covers marked-terminal style hooks like `firstHeading` and `href`
//     that read from chalk directly without going through our renderer
//     identity-override map).
if (!process.env.FORCE_COLOR) process.env.FORCE_COLOR = USE_COLOR ? "3" : "0";
const CODEX_COLUMNS = clampInt(process.env.PRETTY_PANE_COLUMNS ?? process.env.COLUMNS ?? process.stdout.columns, 20, 240, 100);
const CODEX_MAX_TOOL_LINES = clampInt(process.env.PRETTY_PANE_MAX_TOOL_LINES, 1, 500, 18);

/** Resolve pane row count for the MD overflow guard. */
function paneRows() {
  const fromTty = process.stdout.rows;
  if (Number.isFinite(fromTty) && fromTty > 0) return fromTty;
  const fromEnv = Number.parseInt(process.env.PRETTY_PANE_ROWS ?? "", 10);
  if (Number.isFinite(fromEnv) && fromEnv > 0) return fromEnv;
  return 24;
}

function clampInt(raw, min, max, fallback) {
  const parsed = Number.parseInt(String(raw ?? ""), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function paint(code, s) {
  if (!USE_COLOR || !s) return s;
  return `${code}${s}${ANSI.reset}`;
}

/** Paint the codex `▌` marker; always red regardless of label. */
function markerPrefix() {
  return `${paint(ANSI.red, CODEX_MARKER)} `;
}

/** Paint a codex action label with its assigned color (no-op for unknown labels). */
function paintLabel(label) {
  const color = CODEX_LABEL_COLORS[label];
  return color ? paint(color, label) : label;
}

/** Returns true when raw text contains any markdown construct worth re-rendering. */
function mdHasMarkers(raw) {
  if (typeof raw !== "string" || raw.length === 0) return false;
  for (const re of MD_DETECTION_REGEXES) if (re.test(raw)) return true;
  return false;
}

/* ──────────────────── markdown renderer (eager init) ─────────────────── */
/**
 * marked + marked-terminal are loaded EAGERLY via top-level await so
 * `flushMdStream()` can be a fully synchronous function. The earlier
 * lazy approach made `flushMdStream` async, which meant defensive
 * callers (`text_start` while a previous block was active, `agent_end`
 * mid-stream) could not safely call it without awaiting — and the
 * intervening synchronous writes (the new block's deltas, the separator,
 * the `▌ Completed` line) would shift the cursor before the rewind ran,
 * causing the cursor-up sequence to erase the wrong rows.
 *
 * Cost: ~10-50ms one-time at process start. Negligible for a long-lived
 * tmux pane filter; well worth eliminating the entire async-interleaving
 * bug class.
 *
 * When color is disabled, every CALLABLE default style entry the renderer
 * exposes is overridden to identity so no ANSI bytes leak through. We
 * iterate `renderer.<key>` rather than a hardcoded list so a future
 * `marked-terminal` hook addition cannot leak escape codes.
 *
 * Tests can stub renderer.parse via `vi.spyOn` on the imported module.
 */
let _markedRenderer = null;
let _markedLoadFailed = false;
try {
  const { marked } = await import("marked");
  const tt = await import("marked-terminal");
  const factory = tt.markedTerminal ?? tt.default;
  if (typeof factory !== "function") {
    _markedLoadFailed = true;
  } else {
    // Color suppression strategy when USE_COLOR is false:
    //
    //   We rely SOLELY on FORCE_COLOR=0 (set above before this import).
    //   marked-terminal's renderer is built on top of `chalk`; setting
    //   `FORCE_COLOR=0` makes chalk's level-0 instance emit no escape
    //   codes, so the default style hooks emit plain (un-styled) text.
    //
    //   We do NOT identity-override the renderer hooks. The legacy
    //   `(text, level, raw)` positional signature for `heading` breaks
    //   under marked v15 (the new renderer takes a token object), so an
    //   identity wrapper would return the LITERAL markdown source
    //   ("## Reviewing files" instead of just "Reviewing files"). The
    //   default hooks correctly strip the markup and rely on chalk for
    //   color, which our FORCE_COLOR knob already governs in both
    //   directions.
    //
    // `showSectionPrefix: false` overrides marked-terminal's default
    // (true), which would otherwise prepend `'#'.repeat(level) + ' '`
    // BACK onto every heading after stripping the markdown source —
    // leaving "## Reviewing files" verbatim in the rendered output and
    // defeating the entire point of running through marked.
    marked.use(factory({ unescape: true, showSectionPrefix: false }));
    _markedRenderer = marked;
  }
} catch {
  _markedLoadFailed = true;
}
function getMarkedRenderer() {
  return _markedRenderer;
}

/* ──────────────────── unified diff renderer ─────────────────── */
/**
 * Parse a unified diff string (as produced by pi's edit tool —
 * see node_modules/@earendil-works/pi-coding-agent/dist/core/tools/edit.js
 * lines 240–250 — `result.details.diff`) and return a renderable shape.
 * Returns `null` if input doesn't look like a unified diff.
 */
function parseUnifiedDiff(diffStr) {
  if (typeof diffStr !== "string" || diffStr.length === 0) return null;
  const lines = diffStr.split("\n");
  let added = 0;
  let removed = 0;
  const hunks = [];
  let cur = null;
  for (const raw of lines) {
    if (raw.startsWith("@@")) {
      // Header: @@ -oldStart,oldLen +newStart,newLen @@
      const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(raw);
      if (m) {
        cur = { newStart: Number.parseInt(m[3], 10), lines: [] };
        hunks.push(cur);
        continue;
      }
      cur = { newStart: 0, lines: [] };
      hunks.push(cur);
      continue;
    }
    if (raw.startsWith("+++") || raw.startsWith("---")) continue;
    if (cur === null) continue;
    if (raw.startsWith("+")) added += 1;
    else if (raw.startsWith("-")) removed += 1;
    cur.lines.push(raw);
  }
  if (hunks.length === 0) return null;
  return { added, removed, hunks };
}

/**
 * Render a parsed diff to the pane using line numbers and per-line
 * coloring. Each rendered line is `<NNN> <prefix><body>` where prefix
 * is space / `+` / `-` and `+N -M` totals are returned via the caller.
 */
function renderParsedDiff(parsed, firstChangedLine) {
  for (const hunk of parsed.hunks) {
    let lineNo = Number.isFinite(firstChangedLine) && firstChangedLine > 0
      ? firstChangedLine
      : (hunk.newStart || 1);
    // If multiple hunks, fall back to each hunk's own newStart after the first.
    for (const ln of hunk.lines) {
      const safe = sanitize(ln);
      const prefix = safe.length > 0 ? safe[0] : " ";
      const body = safe.length > 0 ? safe.slice(1) : "";
      const numStr = String(lineNo).padStart(4, " ");
      let color;
      if (prefix === "+") color = ANSI.green;
      else if (prefix === "-") color = ANSI.red;
      else color = ANSI.dim;
      const rendered = `  ${numStr}  ${prefix}${body}`;
      out(`${paint(color, rendered)}\n`);
      // Line number advances for new-side lines (`+` and ` `), not for `-`.
      if (prefix !== "-") lineNo += 1;
    }
    firstChangedLine = undefined; // subsequent hunks use their own newStart
  }
}

/**
 * Emit a pre-rendered marked-terminal MD string with a per-line indent
 * prefix. Skips `sanitize()` (which would strip the ANSI escapes the
 * renderer just produced); marked-terminal output is trusted because we
 * fed it the already-sanitized raw input.
 *
 * Trailing blank lines from marked-terminal are dropped so the visual
 * shape matches `writeCodexBlock`.
 */
function emitRenderedMd(rendered, prefix) {
  const lines = String(rendered ?? "").split("\n");
  while (lines.length > 0 && lines[lines.length - 1].length === 0) lines.pop();
  for (const line of lines) {
    if (line.length === 0) {
      out("\n");
      continue;
    }
    out(`${prefix}${line}\n`);
  }
}

/**
 * Run `buf` through marked-terminal if (a) it contains MD markers and
 * (b) the renderer is loaded and parses without throwing. Emits the
 * rendered output via `emitRenderedMd` with the given indent prefix.
 * Falls back to `writeCodexBlock(buf)` (plain-text path with sanitize)
 * when MD detection short-circuits or when parse fails — so a renderer
 * bug never strands the user with a half-emitted block.
 *
 * Returns true when the MD render path was taken; false when the
 * fallback was used. The caller can use the return to skip a redundant
 * trailing newline.
 */
function emitMaybeRenderedMd(buf, prefix) {
  if (!buf || buf.length === 0) return false;
  if (mdHasMarkers(buf)) {
    const renderer = getMarkedRenderer();
    if (renderer) {
      let rendered = null;
      try { rendered = renderer.parse(buf); } catch { rendered = null; }
      if (rendered !== null) {
        emitRenderedMd(rendered, prefix);
        return true;
      }
    }
  }
  writeCodexBlock(buf, prefix);
  return false;
}

/* ─────────────────── markdown stream state (codex theme) ─────────────────── */
const mdStreamState = { active: false, contentIndex: undefined, raw: "" };

/**
 * Flush the current MD stream at text_end / agent_end. Implements the
 * MD-detection short-circuit, wrap-aware line counting, and the
 * Branch A (safe rewind) / Branch B (overflow) dichotomy described in
 * the file-header docblock.
 *
 * SYNCHRONOUS by design — the renderer is eagerly loaded at module
 * top-level so callers can rely on the cursor being in a known position
 * by the time this function returns. Defensive callers (text_start while
 * a previous block is active; agent_end while active) depend on this.
 */
function flushMdStream() {
  if (!mdStreamState.active) return;
  const raw = mdStreamState.raw;
  // Reset eagerly so a second call is a no-op.
  mdStreamState.active = false;
  mdStreamState.contentIndex = undefined;
  mdStreamState.raw = "";
  if (raw.length === 0) return;
  if (THEME !== "codex") return; // gate: plain theme never re-renders
  if (!mdHasMarkers(raw)) return;
  // Ensure cursor is on a fresh line BEFORE we measure / rewind.
  if (pendingTextEnd) {
    process.stdout.write("\n");
    pendingTextEnd = false;
  }
  // Wrap-aware row count over raw stripped of one trailing newline (so
  // "abc\n" → ["abc"] → 1 row, not ["abc",""] → 2 rows).
  const stripped = raw.replace(/\n$/, "");
  const cols = CODEX_COLUMNS;
  let linesEmitted = 0;
  for (const line of stripped.split("\n")) {
    const visible = visibleLength(line);
    linesEmitted += Math.max(1, Math.ceil(visible / cols));
  }
  const safeRewindMax = Math.max(1, paneRows() - 2);
  const renderer = getMarkedRenderer();
  let rendered = null;
  if (renderer) {
    try {
      rendered = renderer.parse(raw);
    } catch {
      rendered = null;
    }
  }
  if (linesEmitted < safeRewindMax) {
    // Branch A: safe rewind — wipe the streamed rows then write rendered.
    for (let i = 0; i < linesEmitted; i += 1) process.stdout.write("\x1b[1A\r\x1b[2K");
    if (rendered === null) {
      // Renderer failed or unavailable — re-emit the raw we just erased.
      process.stdout.write(raw);
    } else {
      process.stdout.write(rendered);
      // Wipe any residue below if the rendered output is shorter.
      process.stdout.write("\x1b[J");
    }
    pendingTextEnd = !((rendered ?? raw).endsWith("\n"));
  } else {
    // Branch B: overflow — keep raw visible, append divider + rendered below.
    if (rendered !== null) {
      const div = USE_COLOR ? paint(ANSI.dim, CODEX_MD_DIVIDER) : CODEX_MD_DIVIDER;
      process.stdout.write(`\n${div}\n`);
      process.stdout.write(rendered);
      pendingTextEnd = !rendered.endsWith("\n");
    }
  }
}

function codexColorForLine(line) {
  const safe = sanitize(line);
  const trimmed = safe.trimStart();
  if (/^\+/.test(safe)) return ANSI.green;
  if (/^-/.test(safe)) return ANSI.red;
  if (/^@@/.test(safe)) return ANSI.cyan;
  if (/^(error|failed|failure|fatal)\b/i.test(trimmed)) return ANSI.red;
  if (/^(success|succeeded|completed|passed|approved)\b/i.test(trimmed)) return ANSI.green;
  return undefined;
}

function codexStyleLine(line, color = codexColorForLine(line)) {
  const safe = sanitize(line);
  return color ? paint(color, safe) : safe;
}

function stripAnsi(s) {
  return String(s).replace(/\x1b\[[0-9;]*m/g, "");
}

function visibleLength(s) {
  return stripAnsi(s).length;
}

function wrapLine(line, width) {
  const safe = sanitize(line);
  if (safe.length <= width) return [safe];
  const chunks = [];
  let rest = safe;
  while (rest.length > width) {
    let cut = rest.lastIndexOf(" ", width);
    if (cut <= 0) cut = width;
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\s+/, "");
  }
  chunks.push(rest);
  return chunks;
}

function writeCodexWrapped(firstPrefix, nextPrefix, text, style = (s) => s) {
  const paragraphs = String(text ?? "").split("\n");
  let firstOutput = true;
  for (const paragraph of paragraphs) {
    const prefix = firstOutput ? firstPrefix : nextPrefix;
    const width = Math.max(10, CODEX_COLUMNS - visibleLength(prefix));
    const chunks = paragraph.length === 0 ? [""] : wrapLine(paragraph, width);
    for (let i = 0; i < chunks.length; i += 1) {
      const currentPrefix = firstOutput && i === 0 ? firstPrefix : nextPrefix;
      out(`${currentPrefix}${style(chunks[i])}\n`);
    }
    firstOutput = false;
  }
}

/**
 * Emit a codex header line: `▌ <colored label> [<body>]`. The `▌` is
 * always painted ANSI red. The first word of `text` is treated as the
 * action label and looked up in CODEX_LABEL_COLORS for its color; the
 * remainder of `text` is the body and stays default-colored. Continuation
 * lines (when wrapped) are indented by two spaces with no marker.
 *
 * `text` examples (from existing call sites):
 *   "Ran git commit -m foo"   → label "Ran",   body "git commit -m foo"
 *   "Edited"                  → label "Edited", body ""
 *   "Session started (dev)"   → label "Session started", body "(dev)"
 *   "Working..."              → label "Working...", body ""
 */
function writeCodexBullet(text) {
  const safe = sanitize(text);
  const { label, body } = splitCodexLabel(safe);
  const colored = paintLabel(label) + (body ? ` ${body}` : "");
  // Bypass writeCodexWrapped: that helper sanitizes per chunk, which would
  // strip the ANSI escapes we just added. Bullets are short single lines —
  // the terminal handles overflow wrap natively.
  out(`${markerPrefix()}${colored}\n`);
}

/**
 * Match the longest CODEX_LABEL_COLORS key that the input begins with
 * (so "Session started" wins over "Session"). Falls back to first word.
 *
 * Caveat: an unknown action whose first word is a strict prefix of an
 * existing label (e.g., a future "Edit" label coexisting with "Edited")
 * would mis-split. Sort-by-longest handles current cases; if a new
 * label is added, double-check the sort still picks the intended winner.
 */
function splitCodexLabel(text) {
  const labels = Object.keys(CODEX_LABEL_COLORS).sort((a, b) => b.length - a.length);
  for (const lbl of labels) {
    if (text === lbl) return { label: lbl, body: "" };
    if (text.startsWith(lbl + " ")) return { label: lbl, body: text.slice(lbl.length + 1) };
  }
  // Unknown label → first word.
  const idx = text.indexOf(" ");
  if (idx === -1) return { label: text, body: "" };
  return { label: text.slice(0, idx), body: text.slice(idx + 1) };
}

function writeCodexChild(marker, text, options = {}) {
  const color = options.color ?? codexColorForLine(text);
  const firstPrefix = `  ${marker} `;
  const nextPrefix = marker === "└" ? "    " : firstPrefix;
  writeCodexWrapped(firstPrefix, nextPrefix, sanitize(text), (segment) => codexStyleLine(segment, color));
}

function writeCodexBlock(text, prefix = "  ") {
  const lines = sanitize(String(text ?? "")).split("\n");
  for (const line of lines) {
    if (line.length === 0) {
      out("\n");
      continue;
    }
    writeCodexWrapped(prefix, prefix, line);
  }
}

function renderCodexToolLines(lines) {
  const clean = lines.map((line) => sanitize(line));
  while (clean.at(-1) === "") clean.pop();
  const visible = clean.slice(0, CODEX_MAX_TOOL_LINES);
  for (const line of visible) {
    writeCodexChild("│", line);
  }
  if (clean.length > visible.length) {
    writeCodexChild("│", `... +${clean.length - visible.length} lines`, { color: undefined });
  }
}

/* ──────────────────────── liveness heartbeat ──────────────────────── */
/**
 * The developer's first inference call has a long time-to-first-token
 * (large prompt + thinking budget). pi emits no events during that
 * wait, so the pane shows only `▶ session started` for 30-90+ seconds —
 * indistinguishable from a hang. Same problem on tool-only turns where
 * the model emits no thinking/text deltas between consecutive tools.
 *
 * Solution: a low-frequency timer that emits one `⏳ working…` line
 * after `THRESHOLD_MS` of silence. On any incoming event the silence
 * counter resets so the next gap also gets one tick. Both knobs are
 * env-var-tunable so tests can use small values without slowing the
 * suite.
 */
// Floor the interval at 10ms so a hostile env var can't pin the event
// loop. 10ms is small enough that tests can use sub-100ms thresholds
// and large enough to be a no-op cost in production where the default
// is 5_000ms.
const HEARTBEAT_INTERVAL_MS = Math.max(
  10,
  Number.parseInt(process.env.PRETTY_PANE_HEARTBEAT_INTERVAL_MS ?? "5000", 10) || 5000,
);
const HEARTBEAT_THRESHOLD_MS = Math.max(
  HEARTBEAT_INTERVAL_MS,
  Number.parseInt(process.env.PRETTY_PANE_HEARTBEAT_THRESHOLD_MS ?? "30000", 10) || 30000,
);
let lastEventAt = Date.now();
let heartbeatPending = true; // true = next silent-gap tick should fire
const heartbeatTimer = setInterval(() => {
  if (mdStreamState.active) return; // suppress while MD streaming to keep rewind math honest
  if (!heartbeatPending) return;
  if (Date.now() - lastEventAt < HEARTBEAT_THRESHOLD_MS) return;
  if (THEME === "codex") writeCodexBullet("Working...");
  else out("⏳ working…\n");
  heartbeatPending = false; // suppress until next real event resets
}, HEARTBEAT_INTERVAL_MS);
// Don't keep the process alive solely for the heartbeat — once stdin
// closes and `rl` ends, the script should exit.
heartbeatTimer.unref?.();
function noteEvent() {
  lastEventAt = Date.now();
  heartbeatPending = true;
}

let pendingTextEnd = false; // true when last write was a streaming delta without trailing newline
let codexThinkingActive = false;
let codexThinkingBuffer = "";

/**
 * Strip C0 control bytes (and DEL) from agent-supplied strings before
 * they hit the terminal. Tabs (0x09) and line feeds (0x0A) are kept so
 * legitimate prose formatting survives. Without this, a model or tool
 * that emits literal `\x1b[2J` (clear-screen) inside a streamed delta
 * could clear the user's pane, hijack the cursor, or inject ANSI
 * sequences into the surrounding tmux UI.
 *
 * Note: readline strips the trailing newline from each line BEFORE
 * giving it to us, so this sanitizer never sees the line-terminating
 * \n. Newlines INSIDE a JSON string survive; we keep them.
 */
function sanitize(s) {
  if (typeof s !== "string") return s;
  return s.replace(/[\x00-\x08\x0B-\x1F\x7F]/g, "");
}

function out(s) {
  // If we're in the middle of a streamed delta (no newline yet) and
  // the next line is a structured event, terminate the delta line
  // first so the structured event starts on a fresh line.
  if (pendingTextEnd) {
    process.stdout.write("\n");
    pendingTextEnd = false;
  }
  process.stdout.write(s);
}

function codexToolLabel(toolName) {
  const name = String(toolName || "").toLowerCase();
  if (/^(read|find|grep|rg|ls|list|open|search)/.test(name)) return "Explored";
  if (/^(edit|write|apply_patch|patch|update)/.test(name)) return "Edited";
  if (/^(review|status|check|verify)/.test(name)) return "Reviewed";
  return "Ran";
}

function firstCommandLine(command) {
  const line = sanitize(command)
    .split("\n")
    .map((part) => part.trim())
    .find((part) => part.length > 0);
  return line || sanitize(command).replace(/\s+/g, " ").trim();
}

function basename(value) {
  const parts = String(value ?? "").split(/[\\/]/).filter(Boolean);
  return parts.at(-1) ?? String(value ?? "");
}

function codexToolHeader(name, argsRaw) {
  const lower = String(name || "").toLowerCase();
  if (lower === "bash" && argsRaw && typeof argsRaw === "object" && typeof argsRaw.command === "string") {
    return `Ran ${firstCommandLine(argsRaw.command) || "bash"}`;
  }
  if (lower === "read") return "Explored";
  const args = sanitize(summarizeInput(argsRaw));
  return args ? `${codexToolLabel(name)} ${name}(${args})` : `${codexToolLabel(name)} ${name}`;
}

function codexReadSummary(argsRaw) {
  const path = argsRaw && typeof argsRaw === "object" && typeof argsRaw.path === "string" ? argsRaw.path : undefined;
  return path ? `Read ${basename(path)}` : "Read";
}

/**
 * Write a streaming delta WITHOUT a trailing newline so successive
 * deltas concatenate naturally. The next structured event will
 * terminate the line via `out`'s pendingTextEnd flush.
 */
function writeDelta(s) {
  if (!s) return;
  const safe = sanitize(s);
  process.stdout.write(safe);
  pendingTextEnd = !safe.endsWith("\n");
}

function summarizeInput(input) {
  if (input == null) return "";
  if (typeof input === "string") {
    return input.length > 80 ? input.slice(0, 77) + "..." : input;
  }
  if (typeof input !== "object") return String(input);
  const parts = [];
  let count = 0;
  for (const [k, v] of Object.entries(input)) {
    if (count >= 3) {
      parts.push("...");
      break;
    }
    let preview;
    if (v == null) preview = "null";
    else if (typeof v === "string") preview = v.length > 30 ? `${v.slice(0, 27)}...` : v;
    else preview = JSON.stringify(v).slice(0, 30);
    parts.push(`${k}=${preview}`);
    count += 1;
  }
  return parts.join(" ");
}

/**
 * Extract a short text preview from a tool result. Tools may return:
 *   - a plain string
 *   - a structured object with `content: [{type:"text", text:"..."}]`
 *     (matches pi-coding-agent's MCP-style tool result shape)
 *   - any other object (best-effort summary)
 */
function summarizeResult(result) {
  if (result == null) return "";
  if (typeof result === "string") {
    const oneLine = result.replace(/\s+/g, " ");
    return oneLine.length > 100 ? oneLine.slice(0, 97) + "..." : oneLine;
  }
  if (Array.isArray(result)) {
    return `[${result.length} items]`;
  }
  if (typeof result === "object") {
    // MCP-style: { content: [{ type: "text", text: "..." }, ...] }
    if (Array.isArray(result.content)) {
      const textBlock = result.content.find((c) => c && c.type === "text" && typeof c.text === "string");
      if (textBlock) return summarizeResult(textBlock.text);
    }
    return summarizeInput(result);
  }
  return String(result);
}

/**
 * Per-toolCallId state for incremental rendering of
 * `tool_execution_update` cumulative snapshots. Each entry tracks:
 *   - `seen`: total chars of `partialResult.content[*].text` already
 *     rendered for this tool call. Lets us emit only the new bytes
 *     since the last update.
 *   - `partial`: chars after the most recent newline that haven't been
 *     flushed yet (we wait for a `\n` before writing the line so we
 *     don't render half-lines).
 *   - `streamed`: true if any update emitted content. Drives whether
 *     `tool_execution_end` should render the `↳ preview` line —
 *     suppressed when we already streamed the body.
 */
const toolStateById = new Map();

function getToolState(id) {
  let s = toolStateById.get(id);
  if (!s) {
    s = { seen: 0, partial: "", streamed: false, lines: [], toolName: undefined, argsRaw: undefined };
    toolStateById.set(id, s);
  }
  return s;
}

/**
 * Extract the cumulative text from a `partialResult` (or `result`)
 * shape: `{ content: [{ type: "text", text: "..." }, ...] }`. Tolerates
 * missing fields and ignores non-text content blocks.
 */
function extractCumulativeText(holder) {
  if (!holder || typeof holder !== "object") return "";
  const content = holder.content;
  if (!Array.isArray(content)) return "";
  let acc = "";
  for (const c of content) {
    if (c && c.type === "text" && typeof c.text === "string") acc += c.text;
  }
  return acc;
}

function codexResultText(result) {
  if (typeof result === "string") return result;
  if (result && typeof result === "object" && Array.isArray(result.content)) {
    return extractCumulativeText(result);
  }
  return summarizeResult(result);
}

/** Render a tool_execution_start (or legacy tool_call) line. */
function renderToolStart(evt) {
  const name = typeof evt.toolName === "string" ? sanitize(evt.toolName) : "tool";
  const argsRaw = evt.args ?? evt.input;
  const id = typeof evt.toolCallId === "string" ? evt.toolCallId : undefined;
  if (id) {
    const state = getToolState(id);
    state.toolName = name;
    state.argsRaw = argsRaw;
  }
  const args = sanitize(summarizeInput(argsRaw));
  if (THEME === "codex") {
    writeCodexBullet(codexToolHeader(name, argsRaw));
    return;
  }
  out(`🔧 ${name}(${args})\n`);
}

/**
 * Stream the new bytes of a tool_execution_update. pi gives us the
 * CUMULATIVE running output, so we slice from `seen` to the end and
 * split the result on newlines. Each complete line gets `   │ <line>`;
 * any trailing chars after the last `\n` go into `partial` and wait
 * for the next update to terminate them.
 *
 * Sanitization runs on each line before write (control bytes stripped)
 * so a hostile tool stdout cannot inject ANSI sequences into the tmux
 * pane. Updates that arrive without a `toolCallId` are dropped — we
 * cannot track cumulative `seen` state across events without a stable
 * id, and a fresh-state-per-event fallback would re-emit prior lines
 * on every snapshot.
 */
function renderToolUpdate(evt) {
  const cumulative = extractCumulativeText(evt.partialResult);
  if (!cumulative) return;
  const id = typeof evt.toolCallId === "string" ? evt.toolCallId : undefined;
  // Without a stable toolCallId we cannot track per-call `seen` length
  // across events. Falling through to a fresh state per event would
  // re-emit ALL cumulative lines on every snapshot — turning the
  // bracket-noise problem this fix is supposed to solve into a
  // duplicate-streamed-lines problem. Drop the event instead;
  // tool_execution_end will still render a `↳ preview` from the final
  // result. Pi 0.70+ always emits a `toolCallId` so this branch is
  // defensive against a future protocol drift, not a current path.
  if (!id) return;
  const state = getToolState(id);
  if (cumulative.length <= state.seen) return; // nothing new
  const delta = cumulative.slice(state.seen);
  state.seen = cumulative.length;
  const combined = state.partial + delta;
  const lines = combined.split("\n");
  // Last element is the trailing fragment after the final '\n' (empty
  // string when input ended with '\n'). Save it for the next update.
  state.partial = lines.pop() ?? "";
  for (const line of lines) {
    if (THEME === "codex") state.lines.push(sanitize(line));
    else out(`   │ ${sanitize(line)}\n`);
    state.streamed = true;
  }
}

/**
 * Render a tool_execution_end (or legacy tool_result) line.
 *
 * Three branches:
 *   1. `isError === true` → emit `   ✗ <error preview>`.
 *   2. Updates already streamed content for this toolCallId →
 *      flush any trailing partial line, drop the result preview
 *      (the user has already seen the body).
 *   3. No updates streamed → keep legacy `   ↳ <result preview>`
 *      behavior. Older logs without update events render unchanged.
 */
function renderToolEnd(evt) {
  const id = typeof evt.toolCallId === "string" ? evt.toolCallId : undefined;
  const state = id ? toolStateById.get(id) : undefined;
  if (THEME === "codex") {
    renderCodexToolEnd(evt, state, id);
    return;
  }
  // Flush any in-progress mid-line content from updates. Defensive —
  // pi's well-formed updates always end on '\n', but a tool that
  // truncated mid-byte should still surface its last line.
  if (state && state.partial.length > 0) {
    if (THEME === "codex") out(`  │ ${codexStyleLine(state.partial)}\n`);
    else out(`   │ ${sanitize(state.partial)}\n`);
    state.partial = "";
    state.streamed = true;
  }
  if (evt.isError === true) {
    const preview = sanitize(summarizeResult(evt.result ?? evt.output ?? evt.text));
    if (THEME === "codex") {
      if (preview) out(`  └ ${paint(ANSI.red, `failed: ${preview}`)}\n`);
      else out(`  └ ${paint(ANSI.red, "failed")}\n`);
    } else if (preview) out(`   ✗ ${preview}\n`);
  } else if (!state || !state.streamed) {
    const preview = sanitize(summarizeResult(evt.result ?? evt.output ?? evt.text));
    if (THEME === "codex") {
      if (preview) out(`  └ ${codexStyleLine(preview)}\n`);
      else out(`  └ completed\n`);
    } else if (preview) out(`   ↳ ${preview}\n`);
  } else if (THEME === "codex") {
    out(`  └ ${codexStyleLine("completed")}\n`);
  }
  if (id) toolStateById.delete(id);
}

function renderCodexToolEnd(evt, state, id) {
  const toolName = state?.toolName ?? (typeof evt.toolName === "string" ? sanitize(evt.toolName) : undefined);
  const argsRaw = state?.argsRaw ?? evt.args ?? evt.input;
  if (state && state.partial.length > 0) {
    state.lines.push(sanitize(state.partial));
    state.partial = "";
    state.streamed = true;
  }

  // pi `edit` tool result shape (verified against
  // node_modules/@earendil-works/pi-coding-agent/dist/core/tools/edit.js
  // lines 240–250) carries `result.details.diff` (unified diff string) +
  // `result.details.firstChangedLine`. When present, render the diff
  // inline with line numbers and per-line +/- coloring instead of the
  // generic preview.
  const details = evt.result && typeof evt.result === "object" ? evt.result.details : undefined;
  const diffStr = details && typeof details.diff === "string" ? details.diff : undefined;
  const firstChangedLine = details && typeof details.firstChangedLine === "number" ? details.firstChangedLine : undefined;
  if (diffStr && !evt.isError) {
    const parsed = parseUnifiedDiff(diffStr);
    if (parsed) {
      const path = argsRaw && typeof argsRaw === "object" && typeof argsRaw.path === "string"
        ? sanitize(argsRaw.path)
        : "";
      const fileLabel = path ? basename(path) : "";
      // Build the Edited header by composition — bypass writeCodexBullet
      // because its sanitize() pass would strip the ANSI in the +N/-M counts.
      const counts = `(${paint(ANSI.green, `+${parsed.added}`)} ${paint(ANSI.red, `-${parsed.removed}`)})`;
      const body = fileLabel ? `${fileLabel} ${counts}` : counts;
      out(`${markerPrefix()}${paintLabel("Edited")} ${body}\n`);
      renderParsedDiff(parsed, firstChangedLine);
      writeCodexChild("└", "completed");
      if (id) toolStateById.delete(id);
      return;
    }
  }

  if (String(toolName || "").toLowerCase() === "read") {
    writeCodexChild("└", codexReadSummary(argsRaw));
    if (id) toolStateById.delete(id);
    return;
  }

  const resultText = codexResultText(evt.result ?? evt.output ?? evt.text);
  const lines = state?.lines ?? [];
  if (lines.length === 0 && resultText) {
    lines.push(...sanitize(resultText).split("\n"));
  }
  if (lines.length > 0) renderCodexToolLines(lines);

  if (evt.isError === true) {
    const preview = sanitize(summarizeResult(evt.result ?? evt.output ?? evt.text));
    writeCodexChild("└", preview ? `failed: ${preview}` : "failed", { color: ANSI.red });
  } else {
    writeCodexChild("└", "completed");
  }
  if (id) toolStateById.delete(id);
}

/**
 * Dispatch a `message_update` event on its inner
 * `assistantMessageEvent.type`. This is where pi puts the streaming
 * content (text_delta, thinking_delta, toolcall_delta, plus their
 * matching start/end boundaries).
 */
function handleMessageUpdate(evt) {
  const inner = evt.assistantMessageEvent;
  if (!inner || typeof inner !== "object" || typeof inner.type !== "string") return;
  switch (inner.type) {
    case "text_start": {
      // Just opens a visible-text content block; no glyph needed —
      // the deltas that follow are the user-facing answer.
      // Codex theme: also start tracking MD stream state for the rewind branch.
      if (THEME === "codex") {
        // Out-of-order guard: if a previous block is still active, treat this
        // as an implicit text_end of the prior block (flush, then reset).
        if (mdStreamState.active) {
          flushMdStream();
        }
        mdStreamState.active = true;
        mdStreamState.contentIndex = inner.contentIndex;
        mdStreamState.raw = "";
      }
      break;
    }
    case "text_delta":
    case "text": {
      const delta = typeof inner.delta === "string" ? inner.delta : inner.text;
      // Buffer for the codex MD branch (only when contentIndex matches the
      // active block, so out-of-order deltas don't poison the rewind math).
      if (THEME === "codex" && mdStreamState.active && typeof delta === "string") {
        const idx = inner.contentIndex;
        if (idx === undefined || idx === mdStreamState.contentIndex) {
          mdStreamState.raw += sanitize(delta);
        }
      }
      writeDelta(delta);
      break;
    }
    case "text_end":
      if (THEME === "codex" && mdStreamState.active) {
        // Per-block flush — the MD-detection short-circuit, wrap-aware
        // rewind, and overflow branches all live in flushMdStream().
        // SYNCHRONOUS by design (renderer was preloaded at module top),
        // so the cursor is in a known position before the next event runs.
        flushMdStream();
      } else if (pendingTextEnd) {
        process.stdout.write("\n");
        pendingTextEnd = false;
      }
      break;
    case "thinking_start":
      if (THEME === "codex") {
        writeCodexBullet("Thinking");
        codexThinkingActive = true;
        codexThinkingBuffer = "";
      } else {
        out("💭 thinking:\n");
      }
      break;
    case "thinking_delta":
    case "thinking":
      if (THEME === "codex" && codexThinkingActive) {
        codexThinkingBuffer += sanitize(typeof inner.delta === "string" ? inner.delta : inner.thinking);
      } else {
        writeDelta(typeof inner.delta === "string" ? inner.delta : inner.thinking);
      }
      break;
    case "thinking_end":
      if (THEME === "codex" && codexThinkingActive) {
        // Run thinking content through marked-terminal when it contains
        // MD constructs (**bold**, # heading, fenced code, lists, …).
        // No rewind needed — thinking is buffered up-front and emitted
        // exactly once here. emitMaybeRenderedMd falls back to the
        // plain-text writeCodexBlock path when no MD markers are
        // present or when marked.parse throws.
        emitMaybeRenderedMd(codexThinkingBuffer, "  ");
        codexThinkingActive = false;
        codexThinkingBuffer = "";
      } else if (pendingTextEnd) {
        process.stdout.write("\n");
        pendingTextEnd = false;
      }
      break;
    case "toolcall_start":
    case "toolcall_delta":
    case "toolcall_end":
      // Suppress — tool_execution_start / tool_execution_end render
      // the full toolName + args + result. The per-arg-character
      // delta stream is just bracket noise.
      break;
    default:
      // Unknown inner type — render compactly so we don't silently
      // drop something the user might want to see.
      out(`[${sanitize(inner.type)}]\n`);
      break;
  }
}

function onLine(line) {
  // Reset the heartbeat clock on EVERY incoming line — including blank
  // lines and non-JSON pass-through — because any input proves the
  // upstream stream is alive.
  noteEvent();
  // For BLANK-LINE detection and JSON parsing we tolerate trailing
  // whitespace (a malformed JSON producer might append spaces). For
  // non-JSON pass-through we preserve the original line verbatim so
  // we don't strip caller-meaningful trailing spaces or tabs.
  const trimmed = line.trimEnd();
  if (trimmed.length === 0) {
    // Preserve blank lines in the streaming output so prose paragraphs
    // breathe.
    out("\n");
    return;
  }

  let evt;
  try {
    evt = JSON.parse(trimmed);
  } catch {
    // Non-JSON line — pass through with sanitization (so a hostile
    // log line cannot smuggle ANSI escape sequences into the tmux
    // pane). Otherwise verbatim — preserve any trailing whitespace.
    out(sanitize(line) + "\n");
    return;
  }

  if (typeof evt !== "object" || evt == null || typeof evt.type !== "string") {
    // JSON-shaped but not an event we recognize — pass through (sanitized).
    out(sanitize(line) + "\n");
    return;
  }

  switch (evt.type) {
    case "agent_start": {
      const agent = evt.agent ? ` (${sanitize(String(evt.agent))})` : "";
      if (THEME === "codex") writeCodexBullet(`Session started${agent}`);
      else out(`▶ session started${agent}\n`);
      break;
    }
    // Rich tool rendering. tool_execution_* is the modern pi shape;
    // tool_call / tool_result are kept for backward compat.
    case "tool_execution_start":
    case "tool_call":
      renderToolStart(evt);
      break;
    case "tool_execution_update":
      renderToolUpdate(evt);
      break;
    case "tool_execution_end":
    case "tool_result":
      renderToolEnd(evt);
      break;
    // Streaming content lives inside message_update.assistantMessageEvent.
    case "message_update":
      handleMessageUpdate(evt);
      break;
    // Legacy top-level streaming events (older pi versions).
    case "message_delta":
    case "text_delta":
      writeDelta(typeof evt.delta === "string" ? evt.delta : evt.text);
      break;
    case "agent_end": {
      // Defensive flush — if an MD stream is mid-block, render now before
      // emitting the separator so the user sees the formatted version.
      if (mdStreamState.active) {
        flushMdStream();
      }
      if (THEME === "codex") {
        out(`${CODEX_SEPARATOR}\n`);
        writeCodexBullet("Completed");
      } else {
        out(`✓ done\n`);
      }
      const finalText = typeof evt.text === "string" ? sanitize(evt.text) : undefined;
      if (finalText && finalText.length > 0) {
        out(`${finalText}\n`);
      }
      break;
    }
    case "error": {
      const msg = typeof evt.message === "string" ? sanitize(evt.message) : sanitize(line);
      if (THEME === "codex") writeCodexBullet(`Error ${msg}`);
      else out(`✗ ${msg}\n`);
      break;
    }
    // Structural events that just clutter the pane with bracket noise
    // — every assistant turn fires several of these.
    case "session":
    case "turn_start":
    case "turn_end":
    case "message_start":
    case "message_end":
      break;
    case "stalled":
    case "aborted":
    case "exit":
      // Lifecycle events from the runtime layer; not from pi itself.
      if (THEME === "codex") writeCodexBullet(sanitize(evt.type));
      else out(`[${sanitize(evt.type)}]\n`);
      break;
    default:
      if (THEME === "codex") writeCodexBullet(sanitize(String(evt.type)));
      else out(`[${sanitize(String(evt.type))}]\n`);
      break;
  }
}

function onClose() {
  clearInterval(heartbeatTimer);
  if (THEME === "codex" && codexThinkingActive) {
    writeCodexBlock(codexThinkingBuffer);
    codexThinkingActive = false;
    codexThinkingBuffer = "";
  }
  // Defensive flush: if the upstream stream closed mid-text-block (no
  // text_end event), flush whatever we buffered. Synchronous now —
  // renderer was preloaded.
  if (THEME === "codex" && mdStreamState.active) flushMdStream();
  if (pendingTextEnd) process.stdout.write("\n");
}

// Create the readline interface NOW that all handlers + the marked
// renderer are ready. Doing this earlier would race the top-level await
// for marked: stdin lines that arrive while we're awaiting would be
// parsed by readline and dropped (no listeners yet → silent loss).
rl = readline.createInterface({ input: process.stdin });
rl.on("line", onLine);
rl.on("close", onClose);
