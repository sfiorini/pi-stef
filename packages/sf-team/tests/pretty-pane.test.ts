import { spawn } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";

const PRETTY_PANE = path.resolve(
  new URL(".", import.meta.url).pathname,
  "..",
  "scripts",
  "pretty-pane.mjs",
);

/**
 * Issue 5: the tmux pane runs `tail -F <log> | node pretty-pane.mjs`.
 * We test the filter end-to-end by piping a known sequence of pi
 * JSON events into stdin and asserting the human-readable output on
 * stdout.
 */
function runPretty(stdin: string, env?: Record<string, string>): Promise<{ stdout: string; code: number }> {
  return new Promise((resolve) => {
    const child = spawn("node", [PRETTY_PANE], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, PRETTY_PANE_THEME: "plain", ...env },
    });
    let stdout = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (c) => { stdout += c; });
    child.on("close", (code) => resolve({ stdout, code: code ?? 1 }));
    child.stdin.end(stdin);
  });
}

/**
 * Same as `runPretty`, but writes stdin in timed chunks. Used by heartbeat
 * tests that need stdin to stay open between events so the timer-driven
 * tick can fire during the silent gap. Each chunk's `delayMsAfter` is the
 * pause AFTER writing that chunk; the total run length must stay short
 * (single-digit hundreds of ms) so vitest doesn't slow down.
 */
function runPrettyTimed(
  chunks: { content: string; delayMsAfter?: number; waitForStdout?: RegExp | string; waitTimeoutMs?: number }[],
  env?: Record<string, string>,
): Promise<{ stdout: string; code: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn("node", [PRETTY_PANE], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, PRETTY_PANE_THEME: "plain", ...env },
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      fn();
    };
    const waitForStdout = (pattern: RegExp | string, timeoutMs: number) => new Promise<void>((done, fail) => {
      const started = Date.now();
      const hasMatch = () => typeof pattern === "string" ? stdout.includes(pattern) : pattern.test(stdout);
      const tick = () => {
        if (hasMatch()) {
          done();
          return;
        }
        if (Date.now() - started >= timeoutMs) {
          fail(new Error(`Timed out waiting for stdout ${String(pattern)}.\nstdout:\n${stdout}\nstderr:\n${stderr}`));
          return;
        }
        setTimeout(tick, 25);
      };
      tick();
    });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (c) => { stdout += c; });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (c) => { stderr += c; });
    child.on("error", (error) => finish(() => reject(error)));
    child.on("close", (code) => finish(() => resolve({ stdout, code: code ?? 1 })));
    (async () => {
      for (const { content, delayMsAfter, waitForStdout: pattern, waitTimeoutMs } of chunks) {
        child.stdin.write(content);
        if (pattern) await waitForStdout(pattern, waitTimeoutMs ?? 10_000);
        if (delayMsAfter) await new Promise((r) => setTimeout(r, delayMsAfter));
      }
      child.stdin.end();
    })().catch((error) => {
      child.stdin.destroy();
      child.kill();
      finish(() => reject(error));
    });
  });
}

describe("pretty-pane filter (Issue 5)", () => {
  it("agent_start renders as ▶ session started", async () => {
    const { stdout } = await runPretty(`${JSON.stringify({ type: "agent_start", agent: "researcher" })}\n`);
    expect(stdout).toBe("▶ session started (researcher)\n");
  });

  it("tool_call renders as 🔧 <name>(<args>) with truncated arg preview", async () => {
    const { stdout } = await runPretty(
      `${JSON.stringify({ type: "tool_call", toolName: "read", input: { path: "/etc/hosts" } })}\n`,
    );
    expect(stdout).toBe("🔧 read(path=/etc/hosts)\n");
  });

  it("tool_result renders as `   ↳ <preview>`; long output is truncated", async () => {
    const longResult = "x".repeat(200);
    const { stdout } = await runPretty(`${JSON.stringify({ type: "tool_result", result: longResult })}\n`);
    expect(stdout).toMatch(/^   ↳ x{97}\.\.\.\n$/);
  });

  it("text_delta events concatenate (no leading glyph) and a structured event terminates the line", async () => {
    const stdin = [
      JSON.stringify({ type: "text_delta", delta: "Hello " }),
      JSON.stringify({ type: "text_delta", delta: "world" }),
      JSON.stringify({ type: "agent_end", text: "DONE" }),
    ].join("\n") + "\n";
    const { stdout } = await runPretty(stdin);
    // Three lines: "Hello world\n", "✓ done\n", "DONE\n"
    expect(stdout).toBe("Hello world\n✓ done\nDONE\n");
  });

  it("non-JSON lines pass through verbatim (stderr from pi)", async () => {
    const { stdout } = await runPretty("warning: foo\nplain text\n");
    expect(stdout).toBe("warning: foo\nplain text\n");
  });

  it("JSON without `type` field passes through verbatim", async () => {
    const stdin = `${JSON.stringify({ not_an_event: true })}\n`;
    const { stdout } = await runPretty(stdin);
    expect(stdout).toBe(stdin);
  });

  it("error events render as ✗ <message>", async () => {
    const { stdout } = await runPretty(`${JSON.stringify({ type: "error", message: "oops" })}\n`);
    expect(stdout).toBe("✗ oops\n");
  });

  it("unknown event type renders as `[<type>]` (nothing silently disappears)", async () => {
    const { stdout } = await runPretty(`${JSON.stringify({ type: "future_event_kind", x: 1 })}\n`);
    expect(stdout).toBe("[future_event_kind]\n");
  });

  it("agent_end without text only emits the ✓ done line (no extra blank line)", async () => {
    const { stdout } = await runPretty(`${JSON.stringify({ type: "agent_end" })}\n`);
    expect(stdout).toBe("✓ done\n");
  });

  it("strips ANSI escape sequences from streamed text deltas (terminal injection guard)", async () => {
    // \x1b[2J would clear the pane if passed through. The sanitizer must
    // strip the ESC byte so only the harmless residue survives.
    const stdin = [
      JSON.stringify({ type: "text_delta", delta: "Hello \x1b[2Jworld" }),
      JSON.stringify({ type: "agent_end" }),
    ].join("\n") + "\n";
    const { stdout } = await runPretty(stdin);
    expect(stdout).toBe("Hello [2Jworld\n✓ done\n");
  });

  it("strips control bytes from tool_call args and from error messages", async () => {
    const stdin = [
      JSON.stringify({ type: "tool_call", toolName: "rm", input: { path: "evil\x07.sh" } }),
      JSON.stringify({ type: "error", message: "boom\x1b[31m red" }),
    ].join("\n") + "\n";
    const { stdout } = await runPretty(stdin);
    expect(stdout).toBe("🔧 rm(path=evil.sh)\n✗ boom[31m red\n");
  });

  it("non-JSON pass-through preserves trailing whitespace (verbatim contract)", async () => {
    // The line has trailing spaces. trimEnd() would strip them — we
    // must NOT do that on pass-through.
    const stdin = "warning: foo   \nplain text\n";
    const { stdout } = await runPretty(stdin);
    expect(stdout).toBe("warning: foo   \nplain text\n");
  });

  it("non-JSON pass-through still strips control bytes (defense in depth)", async () => {
    const stdin = "warning\x1b[2J: scary\n";
    const { stdout } = await runPretty(stdin);
    expect(stdout).toBe("warning[2J: scary\n");
  });
});

describe("pretty-pane codex theme", () => {
  it("renders grouped transcript bullets without emoji when PRETTY_PANE_THEME=codex", async () => {
    const stdin = [
      JSON.stringify({ type: "agent_start", agent: "developer" }),
      JSON.stringify({ type: "tool_execution_start", toolCallId: "T1", toolName: "bash", args: { command: "pnpm test" } }),
      JSON.stringify({
        type: "tool_execution_update",
        toolCallId: "T1",
        partialResult: { content: [{ type: "text", text: "+ added\nerror: failed\n" }] },
      }),
      JSON.stringify({ type: "tool_execution_end", toolCallId: "T1", isError: false, result: { content: [{ type: "text", text: "+ added\nerror: failed\n" }] } }),
      JSON.stringify({ type: "error", message: "oops" }),
      JSON.stringify({ type: "agent_end" }),
    ].join("\n") + "\n";
    const { stdout } = await runPretty(stdin, {
      PRETTY_PANE_THEME: "codex",
      PRETTY_PANE_COLOR: "never",
    });
    expect(stdout).toBe(
      "▌ Session started (developer)\n" +
        "▌ Ran pnpm test\n" +
        "  │ + added\n" +
        "  │ error: failed\n" +
        "  └ completed\n" +
        "▌ Error oops\n" +
        "────────────────────────────────────────\n" +
        "▌ Completed\n",
    );
    expect(stdout).not.toMatch(/[🔧▶✓✗⏳💭]/u);
  });

  it("renders bash commands and read calls like Codex transcript actions", async () => {
    const stdin = [
      JSON.stringify({ type: "tool_execution_start", toolCallId: "B1", toolName: "bash", args: { command: "grep -rn customer accounts src/pages" } }),
      JSON.stringify({ type: "tool_execution_end", toolCallId: "B1", toolName: "bash", isError: false, result: { content: [] } }),
      JSON.stringify({ type: "tool_execution_start", toolCallId: "R1", toolName: "read", args: { path: "/repo/packages/sf-team/tests/pretty-pane.test.ts" } }),
      JSON.stringify({ type: "tool_execution_end", toolCallId: "R1", toolName: "read", isError: false, result: { content: [{ type: "text", text: "large file body that should not be dumped" }] } }),
    ].join("\n") + "\n";
    const { stdout } = await runPretty(stdin, {
      PRETTY_PANE_THEME: "codex",
      PRETTY_PANE_COLOR: "never",
    });

    expect(stdout).toBe(
      "▌ Ran grep -rn customer accounts src/pages\n" +
        "  └ completed\n" +
        "▌ Explored\n" +
        "  └ Read pretty-pane.test.ts\n",
    );
  });

  it("wraps Codex thinking blocks with a stable hanging indent", async () => {
    const stdin = [
      JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "thinking_start" } }),
      JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "alpha beta gamma delta epsilon zeta" } }),
      JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "thinking_end" } }),
    ].join("\n") + "\n";
    const { stdout } = await runPretty(stdin, {
      PRETTY_PANE_THEME: "codex",
      PRETTY_PANE_COLOR: "never",
      PRETTY_PANE_COLUMNS: "28",
    });

    expect(stdout).toBe(
      "▌ Thinking\n" +
        "  alpha beta gamma delta\n" +
        "  epsilon zeta\n",
    );
  });

  it("compacts long Codex tool output instead of flooding the pane", async () => {
    const stdin = [
      JSON.stringify({ type: "tool_execution_start", toolCallId: "T-long", toolName: "bash", args: { command: "ls tests" } }),
      JSON.stringify({
        type: "tool_execution_update",
        toolCallId: "T-long",
        partialResult: { content: [{ type: "text", text: "one\ntwo\nthree\nfour\nfive\n" }] },
      }),
      JSON.stringify({ type: "tool_execution_end", toolCallId: "T-long", isError: false, result: { content: [] } }),
    ].join("\n") + "\n";
    const { stdout } = await runPretty(stdin, {
      PRETTY_PANE_THEME: "codex",
      PRETTY_PANE_COLOR: "never",
      PRETTY_PANE_MAX_TOOL_LINES: "3",
    });

    expect(stdout).toBe(
      "▌ Ran ls tests\n" +
        "  │ one\n" +
        "  │ two\n" +
        "  │ three\n" +
        "  │ ... +2 lines\n" +
        "  └ completed\n",
    );
  });

  it("colors codex diff/status lines only when renderer color is enabled", async () => {
    const stdin = [
      JSON.stringify({ type: "tool_execution_start", toolCallId: "T2", toolName: "bash" }),
      JSON.stringify({
        type: "tool_execution_update",
        toolCallId: "T2",
        partialResult: { content: [{ type: "text", text: "+ added\n- removed\n@@ hunk\ncompleted\nfailed\n" }] },
      }),
      JSON.stringify({ type: "tool_execution_end", toolCallId: "T2", isError: false, result: { content: [] } }),
    ].join("\n") + "\n";
    const colored = await runPretty(stdin, {
      PRETTY_PANE_THEME: "codex",
      PRETTY_PANE_COLOR: "always",
      NO_COLOR: "",
    });
    expect(colored.stdout).toContain("\x1b[32m+ added\x1b[0m");
    expect(colored.stdout).toContain("\x1b[31m- removed\x1b[0m");
    expect(colored.stdout).toContain("\x1b[36m@@ hunk\x1b[0m");
    expect(colored.stdout).toContain("\x1b[32mcompleted\x1b[0m");
    expect(colored.stdout).toContain("\x1b[31mfailed\x1b[0m");

    const noColor = await runPretty(stdin, {
      PRETTY_PANE_THEME: "codex",
      PRETTY_PANE_COLOR: "always",
      NO_COLOR: "1",
    });
    expect(noColor.stdout).not.toMatch(/\x1b\[/);
  });

  it("does not color filenames red just because they contain the word error", async () => {
    const stdin = [
      JSON.stringify({ type: "tool_execution_start", toolCallId: "T-name", toolName: "bash" }),
      JSON.stringify({
        type: "tool_execution_update",
        toolCallId: "T-name",
        partialResult: { content: [{ type: "text", text: "funding-error-states.spec.ts\nerror: failed\n" }] },
      }),
      JSON.stringify({ type: "tool_execution_end", toolCallId: "T-name", isError: false, result: { content: [] } }),
    ].join("\n") + "\n";
    const { stdout } = await runPretty(stdin, {
      PRETTY_PANE_THEME: "codex",
      PRETTY_PANE_COLOR: "always",
      NO_COLOR: "",
    });

    expect(stdout).toContain("funding-error-states.spec.ts");
    expect(stdout).not.toContain("\x1b[31mfunding-error-states.spec.ts");
    expect(stdout).toContain("\x1b[31merror: failed\x1b[0m");
  });

  it("uses codex as the default theme when no theme env is set", async () => {
    const { stdout } = await runPretty(`${JSON.stringify({ type: "agent_end" })}\n`, {
      PRETTY_PANE_THEME: "",
      SF_TEAM_PANE_THEME: "",
      PRETTY_PANE_COLOR: "never",
    });
    expect(stdout).toBe("────────────────────────────────────────\n▌ Completed\n");
  });
});

/* ───────────────────── modern pi protocol (≥ 0.70) ─────────────────── */

describe("pretty-pane: modern pi event protocol", () => {
  it("tool_execution_start renders as 🔧 <name>(<args>) using the `args` field (not `input`)", async () => {
    const { stdout } = await runPretty(
      `${JSON.stringify({ type: "tool_execution_start", toolName: "read", args: { path: "/etc/hosts" } })}\n`,
    );
    expect(stdout).toBe("🔧 read(path=/etc/hosts)\n");
  });

  it("tool_execution_end renders the MCP-shape result preview from result.content[0].text", async () => {
    const stdin = `${JSON.stringify({
      type: "tool_execution_end",
      toolName: "read",
      result: { content: [{ type: "text", text: "the file contents go here" }] },
    })}\n`;
    const { stdout } = await runPretty(stdin);
    expect(stdout).toBe("   ↳ the file contents go here\n");
  }, 15000);

  it("message_update with text_delta streams the visible response (no leading glyph)", async () => {
    const stdin = [
      JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "text_start" } }),
      JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "Hello " } }),
      JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "world" } }),
      JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "text_end" } }),
    ].join("\n") + "\n";
    const { stdout } = await runPretty(stdin);
    expect(stdout).toBe("Hello world\n");
  });

  it("message_update with thinking_delta emits the thinking header then streams the thought", async () => {
    const stdin = [
      JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "thinking_start" } }),
      JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "Examining " } }),
      JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "the task" } }),
      JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "thinking_end" } }),
    ].join("\n") + "\n";
    const { stdout } = await runPretty(stdin);
    expect(stdout).toBe("💭 thinking:\nExamining the task\n");
  });

  it("message_update with toolcall_* events is SUPPRESSED (tool_execution_* carries the full info)", async () => {
    const stdin = [
      JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "toolcall_start" } }),
      JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "toolcall_delta", delta: "{\"path\":\"/etc/hosts\"}" } }),
      JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "toolcall_end" } }),
      JSON.stringify({ type: "tool_execution_start", toolName: "read", args: { path: "/etc/hosts" } }),
    ].join("\n") + "\n";
    const { stdout } = await runPretty(stdin);
    // Only the tool_execution_start line appears; toolcall_* deltas are suppressed.
    expect(stdout).toBe("🔧 read(path=/etc/hosts)\n");
  });

  it("structural events are silenced (session, turn_start, turn_end, message_start, message_end)", async () => {
    const stdin = [
      JSON.stringify({ type: "session", id: "abc" }),
      JSON.stringify({ type: "turn_start" }),
      JSON.stringify({ type: "message_start", message: { role: "assistant" } }),
      JSON.stringify({ type: "message_end", message: { role: "assistant" } }),
      JSON.stringify({ type: "turn_end" }),
    ].join("\n") + "\n";
    const { stdout } = await runPretty(stdin);
    // ALL of these were the bracket-noise that drove this rewrite; none should appear.
    expect(stdout).toBe("");
  });

  it("unknown assistantMessageEvent.type renders as `[<type>]` (mirrors the outer fallback)", async () => {
    // Defense against pi adding a new content-block type pretty-pane
    // hasn't learned yet — surface it under brackets so the user can
    // see something happened, instead of silent dropping. Mirrors the
    // outer-event-type default branch.
    const stdin = `${JSON.stringify({
      type: "message_update",
      assistantMessageEvent: { type: "future_block_kind", x: 1 },
    })}\n`;
    const { stdout } = await runPretty(stdin);
    expect(stdout).toBe("[future_block_kind]\n");
  });

  it("ANSI sanitization applies inside streamed thinking_delta payloads", async () => {
    const stdin = [
      JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "thinking_start" } }),
      JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "evil\x1b[2Jboom" } }),
      JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "thinking_end" } }),
    ].join("\n") + "\n";
    const { stdout } = await runPretty(stdin);
    expect(stdout).toBe("💭 thinking:\nevil[2Jboom\n");
  });

  // ---------------------------------------------------------------
  // tool_execution_update streaming
  //
  // Each `tool_execution_update` carries `partialResult.content[].text`
  // which is the CUMULATIVE running output of the tool — not a delta.
  // pretty-pane tracks the bytes already rendered per `toolCallId` and
  // emits only the NEW characters as `   │ <line>` (one prefixed line
  // per newline) so the user sees bash output stream into the pane in
  // real time without flooding it.
  // ---------------------------------------------------------------
  it("tool_execution_update streams new content as `   │ <line>` (cumulative-snapshot delta tracking)", async () => {
    const stdin = [
      JSON.stringify({ type: "tool_execution_start", toolCallId: "T1", toolName: "bash", args: { command: "find" } }),
      JSON.stringify({
        type: "tool_execution_update",
        toolCallId: "T1",
        toolName: "bash",
        partialResult: { content: [{ type: "text", text: "/foo/a.md\n/foo/b.md\n" }] },
      }),
      JSON.stringify({
        type: "tool_execution_update",
        toolCallId: "T1",
        toolName: "bash",
        // Cumulative — must NOT re-emit /foo/a.md or /foo/b.md.
        partialResult: { content: [{ type: "text", text: "/foo/a.md\n/foo/b.md\n/foo/c.md\n" }] },
      }),
      JSON.stringify({ type: "tool_execution_end", toolCallId: "T1", toolName: "bash", isError: false, result: { content: [{ type: "text", text: "/foo/a.md\n/foo/b.md\n/foo/c.md\n" }] } }),
    ].join("\n") + "\n";
    const { stdout } = await runPretty(stdin);
    // Three streamed lines, in order, each prefixed with `   │ `.
    expect(stdout).toContain("🔧 bash(command=find)\n");
    expect(stdout).toContain("   │ /foo/a.md\n");
    expect(stdout).toContain("   │ /foo/b.md\n");
    expect(stdout).toContain("   │ /foo/c.md\n");
    // Each output line appears EXACTLY ONCE — duplicate-suppression test.
    expect(stdout.match(/\/foo\/a\.md/g)?.length).toBe(1);
    expect(stdout.match(/\/foo\/b\.md/g)?.length).toBe(1);
    expect(stdout.match(/\/foo\/c\.md/g)?.length).toBe(1);
  });

  it("tool_execution_update splits cumulative output across multiple updates by NEW newlines, not by total length", async () => {
    // Update arrives mid-line; pretty-pane should wait for the newline
    // before flushing — otherwise it would render `   │ /partial`.
    const stdin = [
      JSON.stringify({ type: "tool_execution_start", toolCallId: "T2", toolName: "bash" }),
      JSON.stringify({ type: "tool_execution_update", toolCallId: "T2", toolName: "bash", partialResult: { content: [{ type: "text", text: "first line\nseco" }] } }),
      JSON.stringify({ type: "tool_execution_update", toolCallId: "T2", toolName: "bash", partialResult: { content: [{ type: "text", text: "first line\nsecond line\n" }] } }),
      JSON.stringify({ type: "tool_execution_end", toolCallId: "T2", toolName: "bash", isError: false, result: { content: [{ type: "text", text: "first line\nsecond line\n" }] } }),
    ].join("\n") + "\n";
    const { stdout } = await runPretty(stdin);
    expect(stdout).toContain("   │ first line\n");
    expect(stdout).toContain("   │ second line\n");
    expect(stdout).not.toContain("   │ seco\n");
  });

  it("tool_execution_end SUPPRESSES the result preview when updates have already streamed content (no duplicate)", async () => {
    const stdin = [
      JSON.stringify({ type: "tool_execution_start", toolCallId: "T3", toolName: "bash" }),
      JSON.stringify({ type: "tool_execution_update", toolCallId: "T3", toolName: "bash", partialResult: { content: [{ type: "text", text: "streamed body\n" }] } }),
      JSON.stringify({ type: "tool_execution_end", toolCallId: "T3", toolName: "bash", isError: false, result: { content: [{ type: "text", text: "streamed body\n" }] } }),
    ].join("\n") + "\n";
    const { stdout } = await runPretty(stdin);
    expect(stdout).toContain("   │ streamed body\n");
    // The legacy `   ↳ <preview>` line MUST NOT appear when an update
    // already streamed the body — otherwise the user sees the same
    // text twice in different formats.
    expect(stdout).not.toContain("   ↳ streamed body");
  });

  it("tool_execution_end STILL renders `   ↳ <preview>` when no updates streamed content (back-compat for the no-update path)", async () => {
    // No tool_execution_update between start and end — the existing
    // behavior must be preserved so older logs render unchanged.
    const stdin = [
      JSON.stringify({ type: "tool_execution_start", toolCallId: "T4", toolName: "read", args: { path: "/x/y" } }),
      JSON.stringify({ type: "tool_execution_end", toolCallId: "T4", toolName: "read", isError: false, result: { content: [{ type: "text", text: "file body" }] } }),
    ].join("\n") + "\n";
    const { stdout } = await runPretty(stdin);
    expect(stdout).toContain("🔧 read(path=/x/y)\n");
    expect(stdout).toContain("   ↳ file body\n");
  });

  it("tool_execution_end with isError=true renders `   ✗ tool errored` (and skips the `↳ preview` even on the no-update path so the error stands alone)", async () => {
    const stdin = [
      JSON.stringify({ type: "tool_execution_start", toolCallId: "T5", toolName: "bash" }),
      JSON.stringify({ type: "tool_execution_end", toolCallId: "T5", toolName: "bash", isError: true, result: { content: [{ type: "text", text: "command failed: exit 1" }] } }),
    ].join("\n") + "\n";
    const { stdout } = await runPretty(stdin);
    expect(stdout).toContain("   ✗ command failed: exit 1\n");
  });

  it("multiple toolCallIds in flight: state is isolated per id (no cross-contamination of `seen` length)", async () => {
    const stdin = [
      JSON.stringify({ type: "tool_execution_start", toolCallId: "A", toolName: "bash" }),
      JSON.stringify({ type: "tool_execution_start", toolCallId: "B", toolName: "bash" }),
      JSON.stringify({ type: "tool_execution_update", toolCallId: "A", toolName: "bash", partialResult: { content: [{ type: "text", text: "from-A line 1\n" }] } }),
      JSON.stringify({ type: "tool_execution_update", toolCallId: "B", toolName: "bash", partialResult: { content: [{ type: "text", text: "from-B line 1\n" }] } }),
      JSON.stringify({ type: "tool_execution_update", toolCallId: "A", toolName: "bash", partialResult: { content: [{ type: "text", text: "from-A line 1\nfrom-A line 2\n" }] } }),
      JSON.stringify({ type: "tool_execution_end", toolCallId: "A", toolName: "bash", isError: false, result: { content: [] } }),
      JSON.stringify({ type: "tool_execution_end", toolCallId: "B", toolName: "bash", isError: false, result: { content: [] } }),
    ].join("\n") + "\n";
    const { stdout } = await runPretty(stdin);
    // Each toolCallId's lines appear exactly once.
    expect(stdout.match(/from-A line 1/g)?.length).toBe(1);
    expect(stdout.match(/from-A line 2/g)?.length).toBe(1);
    expect(stdout.match(/from-B line 1/g)?.length).toBe(1);
  });

  it("tool_execution_update without a toolCallId is dropped (we cannot track cumulative state without a stable id)", async () => {
    // Two updates without toolCallId, each containing cumulative
    // output. A naive per-event fresh-state implementation would
    // re-emit "/foo/a.md" twice. We drop the events instead.
    const stdin = [
      JSON.stringify({ type: "tool_execution_start", toolCallId: "T", toolName: "bash" }),
      JSON.stringify({ type: "tool_execution_update", toolName: "bash", partialResult: { content: [{ type: "text", text: "/foo/a.md\n" }] } }),
      JSON.stringify({ type: "tool_execution_update", toolName: "bash", partialResult: { content: [{ type: "text", text: "/foo/a.md\n/foo/b.md\n" }] } }),
      JSON.stringify({ type: "tool_execution_end", toolCallId: "T", toolName: "bash", isError: false, result: { content: [{ type: "text", text: "/foo/a.md\n/foo/b.md\n" }] } }),
    ].join("\n") + "\n";
    const { stdout } = await runPretty(stdin);
    // No `   │ /foo/a.md` from updates — they were dropped.
    expect(stdout).not.toContain("   │ /foo/a.md");
    expect(stdout).not.toContain("   │ /foo/b.md");
    // tool_execution_end still renders the legacy `   ↳ <preview>`
    // because the matching toolCallId state has no `streamed` flag set.
    expect(stdout).toContain("   ↳ /foo/a.md /foo/b.md");
  }, 10_000);

  it("ANSI sanitization applies inside streamed tool_execution_update text — control bytes are stripped before reaching the pane", async () => {
    const stdin = [
      JSON.stringify({ type: "tool_execution_start", toolCallId: "T6", toolName: "bash" }),
      JSON.stringify({ type: "tool_execution_update", toolCallId: "T6", toolName: "bash", partialResult: { content: [{ type: "text", text: "evil\x1b[2Jboom\n" }] } }),
      JSON.stringify({ type: "tool_execution_end", toolCallId: "T6", toolName: "bash", isError: false, result: { content: [] } }),
    ].join("\n") + "\n";
    const { stdout } = await runPretty(stdin);
    // ESC byte stripped; the literal `[2J` characters survive (they're
    // text once the ESC is removed).
    expect(stdout).toContain("   │ evil[2Jboom\n");
    expect(stdout).not.toMatch(/\x1b/);
  });

  // ---------------------------------------------------------------
  // Heartbeat tick on silent gap
  //
  // pretty-pane runs a low-frequency interval. If no event has arrived
  // in the last `PRETTY_PANE_HEARTBEAT_THRESHOLD_MS`, it emits ONE
  // `⏳ working…` line. Resets on the next event. This covers the
  // multi-minute TTFT gap on the developer's first inference call.
  // ---------------------------------------------------------------
  it("emits a `⏳ working…` line after the heartbeat threshold elapses with no events", async () => {
    const env = {
      PRETTY_PANE_HEARTBEAT_INTERVAL_MS: "30",
      PRETTY_PANE_HEARTBEAT_THRESHOLD_MS: "100",
    };
    const { stdout } = await runPrettyTimed(
      [
        {
          content: JSON.stringify({ type: "agent_start", agent: "developer" }) + "\n",
          waitForStdout: /⏳ working/,
        },
        { content: JSON.stringify({ type: "tool_execution_start", toolCallId: "X", toolName: "bash" }) + "\n" },
      ],
      env,
    );
    expect(stdout).toContain("▶ session started (developer)\n");
    expect(stdout).toMatch(/⏳ working/);
    expect(stdout).toContain("🔧 bash");
  });

  it("heartbeat fires AT MOST ONCE per silent gap (does not flood every interval tick)", async () => {
    const env = {
      PRETTY_PANE_HEARTBEAT_INTERVAL_MS: "30",
      PRETTY_PANE_HEARTBEAT_THRESHOLD_MS: "100",
    };
    const { stdout } = await runPrettyTimed(
      [
        {
          content: JSON.stringify({ type: "agent_start", agent: "developer" }) + "\n",
          waitForStdout: /⏳ working/,
          delayMsAfter: 250,
        },
        { content: JSON.stringify({ type: "agent_end" }) + "\n" },
      ],
      env,
    );
    // 500 ms gap with 20 ms interval would naively fire ~25 times;
    // we want exactly one.
    const matches = stdout.match(/⏳ working/g) ?? [];
    expect(matches.length).toBe(1);
  });

  it("heartbeat resets after a real event — two silent gaps produce two `⏳ working…` lines", async () => {
    // Gaps need enough headroom over the threshold so the test stays
    // non-flaky under heavy parallel test load (the event loop can drop
    // a tick or two when the worker pool is saturated).
    const env = {
      PRETTY_PANE_HEARTBEAT_INTERVAL_MS: "30",
      PRETTY_PANE_HEARTBEAT_THRESHOLD_MS: "100",
    };
    const { stdout } = await runPrettyTimed(
      [
        {
          content: JSON.stringify({ type: "agent_start", agent: "developer" }) + "\n",
          waitForStdout: /⏳ working/,
        },
        {
          content: JSON.stringify({ type: "tool_execution_start", toolCallId: "X", toolName: "bash" }) + "\n",
          waitForStdout: /(?:⏳ working[\s\S]*){2}/,
        },
        { content: JSON.stringify({ type: "agent_end" }) + "\n" },
      ],
      env,
    );
    const matches = stdout.match(/⏳ working/g) ?? [];
    expect(matches.length).toBe(2);
  });

  it("a realistic agent run renders the meaningful events without bracket noise", async () => {
    // Models the actual sequence pretty-pane sees during a researcher
    // run: turn boundary noise, a tool call/result pair, and streamed
    // thinking. The output should contain only the rich content.
    const stdin = [
      JSON.stringify({ type: "agent_start", agent: "researcher" }),
      JSON.stringify({ type: "turn_start" }),
      JSON.stringify({ type: "message_start", message: { role: "assistant" } }),
      JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "thinking_start" } }),
      JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "I should read the SKILL file" } }),
      JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "thinking_end" } }),
      JSON.stringify({ type: "tool_execution_start", toolName: "read", args: { path: "/x/SKILL.md" } }),
      JSON.stringify({
        type: "tool_execution_end",
        toolName: "read",
        result: { content: [{ type: "text", text: "skill body here" }] },
      }),
      JSON.stringify({ type: "message_end" }),
      JSON.stringify({ type: "turn_end" }),
      JSON.stringify({ type: "agent_end" }),
    ].join("\n") + "\n";
    const { stdout } = await runPretty(stdin);
    expect(stdout).toBe(
      "▶ session started (researcher)\n" +
        "💭 thinking:\nI should read the SKILL file\n" +
        "🔧 read(path=/x/SKILL.md)\n" +
        "   ↳ skill body here\n" +
        "✓ done\n",
    );
  });
});

/* ───────────────────── codex ▌ marker + label colors ─────────────────── */

describe("pretty-pane codex marker parity", () => {
  it("uses the red ▌ marker and never • in the codex theme (color disabled)", async () => {
    const stdin = [
      JSON.stringify({ type: "agent_start", agent: "developer" }),
      JSON.stringify({ type: "tool_execution_start", toolCallId: "T", toolName: "bash", args: { command: "echo hi" } }),
      JSON.stringify({ type: "tool_execution_end", toolCallId: "T", toolName: "bash", isError: false, result: { content: [] } }),
      JSON.stringify({ type: "error", message: "boom" }),
      JSON.stringify({ type: "stalled" }),
      JSON.stringify({ type: "agent_end" }),
    ].join("\n") + "\n";
    const { stdout } = await runPretty(stdin, { PRETTY_PANE_THEME: "codex", PRETTY_PANE_COLOR: "never" });
    // Every event line in codex theme begins with ▌ (or with a child marker / continuation indent).
    expect(stdout).toContain("▌ Session started (developer)");
    expect(stdout).toContain("▌ Ran echo hi");
    expect(stdout).toContain("▌ Error boom");
    expect(stdout).toContain("▌ stalled");
    expect(stdout).toContain("▌ Completed");
    // No • bullets remain anywhere.
    expect(stdout).not.toMatch(/^•/m);
    expect(stdout).not.toContain("• ");
  });

  it("colors the ▌ marker red and each label its assigned color (color enabled)", async () => {
    const stdin = [
      JSON.stringify({ type: "agent_start", agent: "dev" }),
      JSON.stringify({ type: "tool_execution_start", toolCallId: "TR", toolName: "bash", args: { command: "ls" } }),
      JSON.stringify({ type: "tool_execution_end", toolCallId: "TR", toolName: "bash", isError: false, result: { content: [] } }),
      JSON.stringify({ type: "tool_execution_start", toolCallId: "TX", toolName: "read", args: { path: "/foo" } }),
      JSON.stringify({ type: "tool_execution_end", toolCallId: "TX", toolName: "read", isError: false, result: { content: [] } }),
      JSON.stringify({ type: "error", message: "oops" }),
      JSON.stringify({ type: "agent_end" }),
    ].join("\n") + "\n";
    const { stdout } = await runPretty(stdin, { PRETTY_PANE_THEME: "codex", PRETTY_PANE_COLOR: "always", NO_COLOR: "" });
    // Marker is red.
    expect(stdout).toContain("\x1b[31m▌\x1b[0m");
    // Label colors per CODEX_LABEL_COLORS map.
    expect(stdout).toContain("\x1b[2mSession started\x1b[0m");      // dim
    expect(stdout).toContain("\x1b[36mRan\x1b[0m");                  // cyan
    expect(stdout).toContain("\x1b[34mExplored\x1b[0m");             // blue
    expect(stdout).toContain("\x1b[31mError\x1b[0m");                // red
    expect(stdout).toContain("\x1b[32mCompleted\x1b[0m");            // green
  });

  it("paints Working... dim in heartbeat ticks (codex theme)", async () => {
    const env = {
      PRETTY_PANE_THEME: "codex",
      PRETTY_PANE_COLOR: "always",
      NO_COLOR: "",
      PRETTY_PANE_HEARTBEAT_INTERVAL_MS: "30",
      PRETTY_PANE_HEARTBEAT_THRESHOLD_MS: "100",
    };
    const { stdout } = await runPrettyTimed(
      [
        // Keep the silent gap well above the threshold. The heartbeat timer is
        // intentionally unref'd, so very small gaps can be scheduler-sensitive
        // when the test worker is under load.
        {
          content: JSON.stringify({ type: "agent_start", agent: "x" }) + "\n",
          waitForStdout: "Working...",
        },
        { content: JSON.stringify({ type: "agent_end" }) + "\n" },
      ],
      env,
    );
    expect(stdout).toContain("▌");
    expect(stdout).toContain("\x1b[2mWorking...\x1b[0m");
  });
});

/* ───────────────────── codex inline diff rendering ─────────────────── */

describe("pretty-pane codex diff rendering", () => {
  // Pi's edit tool emits result = { content: [{type:"text", text:"..."}], details: { diff: <string>, firstChangedLine: <int> } }
  // (verified at node_modules/@earendil-works/pi-coding-agent/dist/core/tools/edit.js:240-250).
  const sampleDiff = [
    "@@ -10,4 +10,5 @@",
    " context line",
    "-removed line",
    "+added line one",
    "+added line two",
    " trailing context",
  ].join("\n");

  it("renders the ▌ Edited <basename> (+N -M) header from result.details.diff (color disabled)", async () => {
    const stdin = [
      JSON.stringify({ type: "tool_execution_start", toolCallId: "E1", toolName: "edit", args: { path: "/repo/src/foo.ts" } }),
      JSON.stringify({
        type: "tool_execution_end",
        toolCallId: "E1",
        toolName: "edit",
        isError: false,
        result: {
          content: [{ type: "text", text: "Successfully replaced 1 block(s) in /repo/src/foo.ts." }],
          details: { diff: sampleDiff, firstChangedLine: 11 },
        },
      }),
    ].join("\n") + "\n";
    const { stdout } = await runPretty(stdin, { PRETTY_PANE_THEME: "codex", PRETTY_PANE_COLOR: "never" });
    expect(stdout).toContain("▌ Edited foo.ts (+2 -1)");
    // Line numbers + diff body.
    expect(stdout).toMatch(/  11   context line/);
    expect(stdout).toMatch(/  12  -removed line/);
    expect(stdout).toMatch(/  12  \+added line one/);
    expect(stdout).toMatch(/  13  \+added line two/);
    // Closing marker.
    expect(stdout).toContain("  └ completed");
  });

  it("colors +/- diff lines green/red and the +N/-M counts in the header (color enabled)", async () => {
    const stdin = [
      JSON.stringify({ type: "tool_execution_start", toolCallId: "E2", toolName: "edit", args: { path: "/x/file.txt" } }),
      JSON.stringify({
        type: "tool_execution_end",
        toolCallId: "E2",
        toolName: "edit",
        isError: false,
        result: { content: [], details: { diff: sampleDiff, firstChangedLine: 11 } },
      }),
    ].join("\n") + "\n";
    const { stdout } = await runPretty(stdin, { PRETTY_PANE_THEME: "codex", PRETTY_PANE_COLOR: "always", NO_COLOR: "" });
    // Header counts colored.
    expect(stdout).toContain("\x1b[32m+2\x1b[0m");
    expect(stdout).toContain("\x1b[31m-1\x1b[0m");
    // Diff body lines colored — "+added line one" wrapped in green.
    expect(stdout).toContain("\x1b[32m");
    expect(stdout).toContain("+added line one");
    expect(stdout).toContain("\x1b[31m");
    expect(stdout).toContain("-removed line");
  });

  it("falls back to existing renderer when result.details.diff is absent (no shape change)", async () => {
    const stdin = [
      JSON.stringify({ type: "tool_execution_start", toolCallId: "B1", toolName: "bash", args: { command: "true" } }),
      JSON.stringify({
        type: "tool_execution_end",
        toolCallId: "B1",
        toolName: "bash",
        isError: false,
        result: { content: [{ type: "text", text: "ok" }] },
      }),
    ].join("\n") + "\n";
    const { stdout } = await runPretty(stdin, { PRETTY_PANE_THEME: "codex", PRETTY_PANE_COLOR: "never" });
    expect(stdout).toContain("▌ Ran true");
    // Existing renderer streams the result text as a child line, then closes with `└ completed`.
    expect(stdout).toContain("  │ ok");
    expect(stdout).toContain("  └ completed");
    // No "Edited" header should appear for a non-edit tool.
    expect(stdout).not.toContain("Edited");
  });
});

/* ───────────────────── codex markdown live-stream + rewind ─────────────────── */

describe("pretty-pane codex markdown rendering (chunk 5/6)", () => {
  // Helper to build a streamed text-block sequence (text_start + N deltas + text_end).
  function streamTextBlock(rawChunks: string[], contentIndex = 0): string {
    const events = [JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "text_start", contentIndex } })];
    for (const c of rawChunks) {
      events.push(JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex, delta: c } }));
    }
    events.push(JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "text_end", contentIndex } }));
    return events.join("\n") + "\n";
  }

  it("plain prose passes through byte-identically with no rewind (codex theme)", async () => {
    const stdin = streamTextBlock(["Hello world\n"]);
    const { stdout } = await runPretty(stdin, {
      PRETTY_PANE_THEME: "codex",
      PRETTY_PANE_COLOR: "never",
      PRETTY_PANE_COLUMNS: "80",
      PRETTY_PANE_ROWS: "24",
    });
    // No cursor-up sequences (no rewind for plain prose).
    expect(stdout).not.toContain("\x1b[1A");
    // No erase-screen-from-cursor.
    expect(stdout).not.toContain("\x1b[J");
    // The raw text is in the output as-is.
    expect(stdout).toContain("Hello world");
  });

  it("emits a rewind sequence when the streamed text contains MD markers (heading)", async () => {
    const stdin = streamTextBlock(["## Heading\n"]);
    const { stdout } = await runPretty(stdin, {
      PRETTY_PANE_THEME: "codex",
      PRETTY_PANE_COLOR: "never",
      PRETTY_PANE_COLUMNS: "80",
      PRETTY_PANE_ROWS: "24",
    });
    // The raw `## Heading` was written first.
    expect(stdout).toContain("## Heading");
    // A rewind sequence followed (cursor up + erase line).
    expect(stdout).toContain("\x1b[1A\r\x1b[2K");
    // After the rewind, the rendered MD also appears (marked-terminal strips ##).
    expect(stdout).toContain("Heading");
    // Trailing erase to end of screen wipes any residue.
    expect(stdout).toContain("\x1b[J");
    // REGRESSION GUARD: `## Heading` must appear EXACTLY ONCE (the raw
    // stream). If it appeared twice, the rendered version is leaking
    // the literal markdown source — that was the showSectionPrefix=true
    // bug in marked-terminal v7's default options that previously left
    // headings round-tripped as "## Heading" through both halves of the
    // text_delta pipeline.
    expect((stdout.match(/## Heading/g) ?? []).length).toBe(1);
  });

  it("trailing-newline fixture: raw='abc\\n' with MD markers triggers exactly 1 \\x1b[1A (off-by-one guard)", async () => {
    // Need MD markers to trigger the rewind branch.
    const stdin = streamTextBlock(["**abc**\n"]);
    const { stdout } = await runPretty(stdin, {
      PRETTY_PANE_THEME: "codex",
      PRETTY_PANE_COLOR: "never",
      PRETTY_PANE_COLUMNS: "80",
      PRETTY_PANE_ROWS: "24",
    });
    const upMatches = stdout.match(/\x1b\[1A/g) ?? [];
    expect(upMatches.length).toBe(1);
    // REGRESSION GUARD: literal `**abc**` appears EXACTLY ONCE (the raw
    // stream). The rendered version emits just `abc` (asterisks stripped).
    expect((stdout.match(/\*\*abc\*\*/g) ?? []).length).toBe(1);
    // The rendered `abc` is also in the output (post-rewind).
    expect(stdout).toContain("abc");
  });

  it("wrap-aware line counting: 200-char single-line at COLUMNS=80 → 3 cursor-ups", async () => {
    // 200 chars of dense markdown so the heuristic triggers and wrap math kicks in.
    const long = "**" + "x".repeat(196) + "**\n";
    const stdin = streamTextBlock([long]);
    const { stdout } = await runPretty(stdin, {
      PRETTY_PANE_THEME: "codex",
      PRETTY_PANE_COLOR: "never",
      PRETTY_PANE_COLUMNS: "80",
      PRETTY_PANE_ROWS: "24",
    });
    const upMatches = stdout.match(/\x1b\[1A/g) ?? [];
    // ceil(200 / 80) === 3
    expect(upMatches.length).toBe(3);
  });

  it("Branch B (overflow): when streamed lines >= paneRows-2, raw stays + divider + rendered appended below", async () => {
    // PRETTY_PANE_ROWS=10 → safeRewindMax=8. Stream 10 MD lines so we're over the threshold.
    const lines = Array.from({ length: 10 }, (_, i) => `- item ${i + 1}`).join("\n") + "\n";
    const stdin = streamTextBlock([lines]);
    const { stdout } = await runPretty(stdin, {
      PRETTY_PANE_THEME: "codex",
      PRETTY_PANE_COLOR: "never",
      PRETTY_PANE_COLUMNS: "80",
      PRETTY_PANE_ROWS: "10",
    });
    // No rewind sequence in overflow branch.
    expect(stdout).not.toContain("\x1b[1A");
    // Raw items are present.
    expect(stdout).toContain("- item 1");
    expect(stdout).toContain("- item 10");
    // Divider then formatted rendering (marked converts `-` to `*`-style bullets in marked-terminal v7).
    expect(stdout).toContain("── markdown ──");
  });

  it("multi-block lifecycle: two text_start/text_end cycles each rewind independently — content order preserved", async () => {
    const stdin =
      streamTextBlock(["## first\n"], 0) +
      streamTextBlock(["## second\n"], 1);
    const { stdout } = await runPretty(stdin, {
      PRETTY_PANE_THEME: "codex",
      PRETTY_PANE_COLOR: "never",
      PRETTY_PANE_COLUMNS: "80",
      PRETTY_PANE_ROWS: "24",
    });
    expect(stdout).toContain("first");
    expect(stdout).toContain("second");
    // Each block triggers its own rewind → at least 2 cursor-ups total.
    const upMatches = stdout.match(/\x1b\[1A/g) ?? [];
    expect(upMatches.length).toBeGreaterThanOrEqual(2);
    // ORDER: "first" must appear before "second" in the rendered output.
    // This guards against the async-flush-corruption bug where block 0's
    // rewind ran AFTER block 1's deltas, erasing block 1 instead.
    const firstIdx = stdout.indexOf("first");
    const secondIdx = stdout.indexOf("second");
    expect(firstIdx).toBeGreaterThanOrEqual(0);
    expect(secondIdx).toBeGreaterThan(firstIdx);
    // No cross-block carryover: block 1's region (everything after the
    // second's first appearance) must not contain "first". Catches the
    // previous async-flush corruption bug where block 0's deferred
    // rewind would erase block 1's content while leaving block 0's text
    // behind.
    const block1Region = stdout.slice(secondIdx);
    expect(block1Region).not.toContain("first");
    // Per-block in-block count: literal `## first` and `## second` each
    // appear EXACTLY ONCE (the raw stream of their own block only). If
    // the showSectionPrefix=true bug ever returns, these would each
    // double to 2 (raw + rendered).
    expect((stdout.match(/## first/g) ?? []).length).toBe(1);
    expect((stdout.match(/## second/g) ?? []).length).toBe(1);
  });

  it("agent_end mid-stream: defensive flush completes BEFORE the separator + ▌ Completed line is written", async () => {
    // Stream MD without a text_end, then fire agent_end. The flush MUST
    // complete synchronously so the separator and Completed line appear
    // AFTER the rendered MD (not be erased by a deferred rewind).
    const stdin = [
      JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "text_start", contentIndex: 0 } }),
      JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "## hi\n" } }),
      // No text_end — agent_end is the closer.
      JSON.stringify({ type: "agent_end" }),
    ].join("\n") + "\n";
    const { stdout } = await runPretty(stdin, {
      PRETTY_PANE_THEME: "codex",
      PRETTY_PANE_COLOR: "never",
      PRETTY_PANE_COLUMNS: "80",
      PRETTY_PANE_ROWS: "24",
    });
    // The Completed line must be present and AFTER any MD-related output.
    const completedIdx = stdout.indexOf("▌ Completed");
    const sepIdx = stdout.indexOf("────────────────────────────────────────");
    expect(completedIdx).toBeGreaterThan(0);
    expect(sepIdx).toBeGreaterThan(0);
    expect(completedIdx).toBeGreaterThan(sepIdx);
    // The MD body MUST appear BEFORE the separator — guarantees the flush
    // ran synchronously, not after agent_end's writes.
    const hiIdx = stdout.indexOf("hi");
    expect(hiIdx).toBeGreaterThan(0);
    expect(hiIdx).toBeLessThan(sepIdx);
  });

  it("PRETTY_PANE_COLOR=never alone (no NO_COLOR) suppresses MD color escapes", async () => {
    const stdin = streamTextBlock(["# H1\n**bold**\n- a\n"]);
    const { stdout } = await runPretty(stdin, {
      PRETTY_PANE_THEME: "codex",
      PRETTY_PANE_COLOR: "never",
      // NO_COLOR explicitly NOT set.
      PRETTY_PANE_COLUMNS: "80",
      PRETTY_PANE_ROWS: "24",
    });
    const colorOnly = stdout.replace(/\x1b\[(?:1A|2K|J|K|G)/g, "").replace(/\r/g, "");
    expect(colorOnly).not.toMatch(/\x1b\[\d+m/);
  });

  it("heartbeat is suppressed during an active MD stream (no ▌ Working... while text_delta in flight)", async () => {
    const env = {
      PRETTY_PANE_THEME: "codex",
      PRETTY_PANE_COLOR: "never",
      PRETTY_PANE_COLUMNS: "80",
      PRETTY_PANE_ROWS: "24",
      PRETTY_PANE_HEARTBEAT_INTERVAL_MS: "20",
      PRETTY_PANE_HEARTBEAT_THRESHOLD_MS: "60",
    };
    // text_start, then a long quiet gap (>> threshold), then text_delta + text_end.
    const chunks = [
      { content: JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "text_start", contentIndex: 0 } }) + "\n", delayMsAfter: 300 },
      { content: JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "## hi\n" } }) + "\n" },
      { content: JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "text_end", contentIndex: 0 } }) + "\n" },
    ];
    const { stdout } = await runPrettyTimed(chunks, env);
    expect(stdout).not.toContain("Working...");
  });

  it("plain theme regression: text_delta with markdown is NOT rewound or re-rendered under PRETTY_PANE_THEME=plain", async () => {
    const stdin = streamTextBlock(["## Heading\n**bold**\n"]);
    const { stdout } = await runPretty(stdin, { PRETTY_PANE_THEME: "plain", PRETTY_PANE_COLOR: "never" });
    expect(stdout).not.toContain("\x1b[1A");
    expect(stdout).not.toContain("\x1b[J");
    expect(stdout).not.toContain("── markdown ──");
    // The markdown source is present byte-identically.
    expect(stdout).toContain("## Heading");
    expect(stdout).toContain("**bold**");
  });

  it("NO_COLOR is honored in MD render path: no ANSI color escapes leak from marked-terminal", async () => {
    const stdin = streamTextBlock(["# H1\n**bold** *em* `code`\n- a\n- b\n"]);
    const { stdout } = await runPretty(stdin, {
      PRETTY_PANE_THEME: "codex",
      PRETTY_PANE_COLOR: "never",
      NO_COLOR: "1",
      PRETTY_PANE_COLUMNS: "80",
      PRETTY_PANE_ROWS: "24",
    });
    // Strip cursor-control sequences (rewind) — they're allowed; only color escapes are forbidden.
    const colorOnly = stdout.replace(/\x1b\[(?:1A|2K|J|K|G)/g, "").replace(/\r/g, "");
    expect(colorOnly).not.toMatch(/\x1b\[\d+m/);
  });
});

/* ───────────────────── codex thinking-block markdown rendering ─────────────────── */

describe("pretty-pane codex thinking-block MD rendering", () => {
  // Helper for a thinking sequence (start → deltas → end). Mirrors the
  // pi-ai assistantMessageEvent shape (verified at pi-ai/dist/types.d.ts:205-215).
  function streamThinkingBlock(rawChunks: string[], contentIndex = 0): string {
    const events = [JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "thinking_start", contentIndex } })];
    for (const c of rawChunks) {
      events.push(JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", contentIndex, delta: c } }));
    }
    events.push(JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "thinking_end", contentIndex } }));
    return events.join("\n") + "\n";
  }

  it("renders **bold** inside thinking content (codex theme): literal asterisks are removed from output", async () => {
    const stdin = streamThinkingBlock(["**Inspecting relevant files**\n\nbody text follows\n"]);
    const { stdout } = await runPretty(stdin, {
      PRETTY_PANE_THEME: "codex",
      PRETTY_PANE_COLOR: "never",
      PRETTY_PANE_COLUMNS: "80",
      PRETTY_PANE_ROWS: "24",
    });
    expect(stdout).toContain("▌ Thinking");
    // Bold word survives, literal `**` markers do not.
    expect(stdout).toContain("Inspecting relevant files");
    expect(stdout).not.toContain("**Inspecting");
    // Body paragraph still emitted.
    expect(stdout).toContain("body text follows");
  });

  it("renders headings and fenced code blocks inside thinking (no literal markdown markup leaks)", async () => {
    const stdin = streamThinkingBlock(["## Reviewing files\n\n```\nscraper/\nparser.ts\n```\n"]);
    const { stdout } = await runPretty(stdin, {
      PRETTY_PANE_THEME: "codex",
      PRETTY_PANE_COLOR: "never",
      PRETTY_PANE_COLUMNS: "80",
      PRETTY_PANE_ROWS: "24",
    });
    expect(stdout).toContain("Reviewing files");
    expect(stdout).not.toContain("## Reviewing");
    // Fenced content is preserved; the literal triple-backtick fence is dropped by marked.
    expect(stdout).toContain("scraper/");
    expect(stdout).toContain("parser.ts");
    expect(stdout).not.toMatch(/^```/m);
  });

  it("plain-prose thinking (no MD markers) keeps existing writeCodexBlock shape — byte-identical to today", async () => {
    // Existing test fixture lifted from line 204+ of this file: with
    // PRETTY_PANE_COLUMNS=28 and content "alpha beta gamma delta epsilon zeta",
    // writeCodexBlock wraps to two lines indented by two spaces. The new
    // code path MUST detect the absence of MD markers and short-circuit
    // to writeCodexBlock so this fixture stays identical.
    const stdin = streamThinkingBlock(["alpha beta gamma delta epsilon zeta"]);
    const { stdout } = await runPretty(stdin, {
      PRETTY_PANE_THEME: "codex",
      PRETTY_PANE_COLOR: "never",
      PRETTY_PANE_COLUMNS: "28",
    });
    expect(stdout).toBe(
      "▌ Thinking\n" +
        "  alpha beta gamma delta\n" +
        "  epsilon zeta\n",
    );
  });

  it("plain theme thinking with MD content is NOT re-rendered (gate: codex-only)", async () => {
    const stdin = streamThinkingBlock(["**bold**\n\n# heading\n"]);
    const { stdout } = await runPretty(stdin, { PRETTY_PANE_THEME: "plain", PRETTY_PANE_COLOR: "never" });
    // Plain theme keeps the literal markdown source verbatim.
    expect(stdout).toContain("**bold**");
    expect(stdout).toContain("# heading");
  });
});

/* ───────────────────── chunk 1 smoke (deps resolve) ─────────────────── */

describe("pretty-pane MD deps smoke", () => {
  it("marked + marked-terminal resolve in the script's context and parse a heading non-empty", async () => {
    // Spawn a small node script from the same workspace cwd as pretty-pane.mjs to confirm both deps resolve.
    const child = spawn("node", [
      "--input-type=module",
      "-e",
      `import {marked} from 'marked';
       const tt = await import('marked-terminal');
       const factory = tt.markedTerminal ?? tt.default;
       marked.use(factory({unescape: true}));
       const out = marked.parse('# hi');
       process.stdout.write(JSON.stringify({len: out.length, hasH: out.includes('hi')}));`,
    ], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, FORCE_COLOR: "0" },
      cwd: path.resolve(new URL(".", import.meta.url).pathname, ".."),
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (c) => { stdout += c; });
    child.stderr.on("data", (c) => { stderr += c; });
    const code = await new Promise((resolve) => child.on("close", resolve));
    if (code !== 0) {
      throw new Error(`smoke child exited ${code}: ${stderr}`);
    }
    const parsed = JSON.parse(stdout);
    expect(parsed.len).toBeGreaterThan(0);
    expect(parsed.hasH).toBe(true);
  });
});
