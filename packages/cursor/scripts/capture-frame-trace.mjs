#!/usr/bin/env node

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

function parseArgs(argv) {
  const args = {
    delayMs: 130_000,
    outDir: "packages/cursor-provider/tests/fixtures/bridge-frame-traces",
    timeoutMs: 180_000,
    allowCi: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--model") args.model = argv[++i];
    else if (arg === "--delay-ms") args.delayMs = Number(argv[++i]);
    else if (arg === "--out-dir") args.outDir = argv[++i];
    else if (arg === "--timeout-ms") args.timeoutMs = Number(argv[++i]);
    else if (arg === "--allow-ci") args.allowCi = true;
    else if (arg === "--help") args.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return args;
}

function usage() {
  return [
    "Usage: pnpm exec tsx packages/cursor-provider/scripts/capture-frame-trace.mjs --model <cursor-model>",
    "",
    "Options:",
    "  --delay-ms <ms>    Delay between toolUse and tool result continuation (default: 130000)",
    "  --timeout-ms <ms>  Abort each stream turn after this duration (default: 180000)",
    "  --out-dir <path>   Directory for sanitized trace fixtures",
    "  --allow-ci         Bypass the CI=1 refusal (requires real Cursor credentials; see docs)",
  ].join("\n");
}

function isCiEnvSet() {
  const raw = process.env.CI?.trim().toLowerCase();
  return !!raw && raw !== "0" && raw !== "false" && raw !== "off";
}

function readCursorAccessToken() {
  const envToken = process.env.CURSOR_ACCESS_TOKEN?.trim();
  if (envToken) return { token: envToken, source: "env" };

  const authPath = join(homedir(), ".pi", "agent", "auth.json");
  let raw;
  try {
    raw = readFileSync(authPath, "utf8");
  } catch (error) {
    if (error && error.code === "ENOENT") {
      throw new Error(
        "No Cursor access token found in CURSOR_ACCESS_TOKEN or ~/.pi/agent/auth.json",
      );
    }
    throw error;
  }
  const auth = JSON.parse(raw);
  const token = auth?.cursor?.access;
  if (typeof token === "string" && token.trim()) {
    return { token: token.trim(), source: "auth_file" };
  }
  throw new Error("No Cursor access token found in CURSOR_ACCESS_TOKEN or ~/.pi/agent/auth.json");
}

function makeCursorModel(id) {
  return {
    id,
    name: id,
    api: "cursor-native",
    provider: "cursor",
    baseUrl: "https://api2.cursor.sh",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200_000,
    maxTokens: 64_000,
  };
}

function makeTool() {
  return {
    name: "phase0_echo",
    description: "Echoes a short diagnostic string for cursor-provider phase 0 tracing.",
    parameters: {
      type: "object",
      properties: {
        text: { type: "string" },
      },
      required: ["text"],
      additionalProperties: false,
    },
  };
}

function makeInitialContext() {
  return {
    systemPrompt:
      "You are running a cursor-provider diagnostic. You must call the available phase0_echo tool exactly once before producing any final answer.",
    tools: [makeTool()],
    messages: [
      {
        role: "user",
        content:
          "Call phase0_echo with text set to 'phase0'. Do not answer directly before the tool call.",
        timestamp: Date.now(),
      },
    ],
  };
}

function withToolResult(context, assistant, toolCall, delayMs) {
  return {
    ...context,
    messages: [
      ...context.messages,
      assistant,
      {
        role: "toolResult",
        toolCallId: toolCall.id,
        toolName: toolCall.name,
        content: [
          {
            type: "text",
            text: `phase0 tool output after ${delayMs}ms delay`,
          },
        ],
        isError: false,
        timestamp: Date.now(),
      },
    ],
  };
}

async function runWithTimeout(streamSimple, model, context, options, timeoutMs, label) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  try {
    const stream = streamSimple(model, context, { ...options, signal: controller.signal });
    return await stream.result();
  } catch (error) {
    return {
      role: "assistant",
      content: [],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "error",
      errorMessage: `${label} failed: ${error instanceof Error ? error.message : String(error)}`,
      timestamp: Date.now(),
    };
  } finally {
    clearTimeout(timer);
  }
}

function parseJsonLines(path) {
  try {
    return readFileSync(path, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

function execCase(entry) {
  return entry?.msg?.message?.value?.message?.case;
}

function summarizeLog(entries) {
  const interestingEvents = new Set([
    "server_message",
    "native.stream.tool_call_pause",
    "native.stream.checkpoint_buffered",
    "native.stream.bridge_close",
    "bridge.died_mid_pause_checkpoint_saved",
    "bridge.died_mid_pause_no_checkpoint",
    "native.tool_resume.start",
    "native.tool_resume.sent_result",
    "native.tool_resume.idle_retry_recovery_skipped",
    "native.tool_resume.idle_retry_recover",
    "native.lost_tool_continuation",
    "native.stream.cursor_error",
    "native.stream.idle_timeout",
  ]);
  const events = entries
    .filter((entry) => interestingEvents.has(entry.event))
    .map((entry, index) => ({
      index,
      ts: entry.ts,
      event: entry.event,
      msgCase: entry.msgCase,
      execCase: execCase(entry),
      modelId: entry.modelId,
      code: entry.code,
      reason: entry.reason ?? entry.skipReason,
      stopReason: entry.stopReason,
      hadStoredCheckpoint: entry.hadStoredCheckpoint,
      pendingToolCallIds: entry.pendingToolCallIds,
      toolResults: entry.toolResults?.map?.((r) => ({ toolCallId: r.toolCallId })),
    }));

  const firstMcpArgsIndex = events.findIndex(
    (entry) => entry.event === "server_message" && entry.msgCase === "execServerMessage" && entry.execCase === "mcpArgs",
  );
  const firstCheckpointIndex = events.findIndex(
    (entry) => entry.event === "server_message" && entry.msgCase === "conversationCheckpointUpdate",
  );

  return {
    events,
    firstMcpArgsIndex,
    firstCheckpointIndex,
    mcpArgsBeforeCheckpoint:
      firstMcpArgsIndex === -1
        ? null
        : firstCheckpointIndex === -1
          ? null
          : firstMcpArgsIndex < firstCheckpointIndex,
  };
}

function findFirstToolCall(assistant) {
  return assistant.content?.find?.((block) => block?.type === "toolCall");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(usage());
    process.exit(0);
  }
  if (isCiEnvSet() && !args.allowCi) {
    console.error(
      "capture-frame-trace refuses to run under CI (CI env is set). Pass --allow-ci only from a trusted manual capture.",
    );
    process.exit(2);
  }
  if (!args.model) {
    console.log(usage());
    process.exit(2);
  }
  if (!Number.isFinite(args.delayMs) || args.delayMs < 0) {
    throw new Error("--delay-ms must be a non-negative number");
  }
  if (!Number.isFinite(args.timeoutMs) || args.timeoutMs <= 0) {
    throw new Error("--timeout-ms must be a positive number");
  }

  const outDir = resolve(args.outDir);
  mkdirSync(outDir, { recursive: true });
  const safeModel = args.model.replace(/[^a-zA-Z0-9._-]+/g, "-");
  const debugFile = join(outDir, `${safeModel}.debug.jsonl`);
  const fixtureFile = join(outDir, `${safeModel}.json`);
  writeFileSync(debugFile, "", "utf8");

  process.env.PI_CURSOR_PROVIDER_DEBUG = "1";
  process.env.PI_CURSOR_PROVIDER_DEBUG_FILE = debugFile;
  // Must be set before the dynamic proxy import below; proxy.ts reads this at module load time.
  process.env.PI_CURSOR_STREAM_IDLE_TIMEOUT_MS ||= "180000";

  const [{ createCursorNativeStream }, tokenInfo] = await Promise.all([
    import("../src/proxy.ts"),
    Promise.resolve(readCursorAccessToken()),
  ]);

  const streamSimple = createCursorNativeStream({
    getAccessToken: async () => tokenInfo.token,
  });
  const model = makeCursorModel(args.model);
  const sessionId = `phase0-${safeModel}-${Date.now()}`;
  const initialContext = makeInitialContext();

  const first = await runWithTimeout(
    streamSimple,
    model,
    initialContext,
    { sessionId },
    args.timeoutMs,
    "initial tool-call turn",
  );
  const toolCall = findFirstToolCall(first);

  let second;
  if (first.stopReason === "toolUse" && toolCall) {
    await sleep(args.delayMs);
    second = await runWithTimeout(
      streamSimple,
      model,
      withToolResult(initialContext, first, toolCall, args.delayMs),
      { sessionId },
      args.timeoutMs,
      "tool-result continuation turn",
    );
  }

  const logEntries = parseJsonLines(debugFile);
  const summary = summarizeLog(logEntries);
  const fixture = {
    capturedAt: new Date().toISOString(),
    model: args.model,
    delayMs: args.delayMs,
    timeoutMs: args.timeoutMs,
    tokenSource: tokenInfo.source,
    firstTurn: {
      stopReason: first.stopReason,
      errorMessage: first.errorMessage,
      toolCall: toolCall
        ? {
            id: toolCall.id,
            name: toolCall.name,
            arguments: toolCall.arguments,
          }
        : undefined,
    },
    secondTurn: second
      ? {
          stopReason: second.stopReason,
          errorMessage: second.errorMessage,
        }
      : undefined,
    trace: summary,
  };

  writeFileSync(fixtureFile, `${JSON.stringify(fixture, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({ fixtureFile, debugFile, result: fixture }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exit(1);
});
