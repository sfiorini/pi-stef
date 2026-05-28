import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import {
  isVerificationEnabledForPhase,
  type ResolvedVerificationConfig,
  type VerificationCommand,
  type VerificationPhase,
} from "./config";
import { fingerprintVerificationInputs } from "./fingerprint";

export type { VerificationCommand } from "./config";

export interface VerificationCommandResult {
  status: number | null;
  stdout?: string | null;
  stderr?: string | null;
  error?: Error;
  signal?: NodeJS.Signals | string | null;
}

export type VerificationCommandExecutor = (command: VerificationCommand) => VerificationCommandResult | Promise<VerificationCommandResult>;

export interface VerificationRunCache {
  has(fingerprint: string): boolean;
  add(fingerprint: string): void;
}

export interface VerificationReporter {
  message(message: string, opts?: { level?: "info" | "warning" | "error" }): void;
}

export interface RunVerificationPolicyOptions {
  toolName: string;
  cwd: string;
  phase: VerificationPhase;
  config: ResolvedVerificationConfig;
  commands: VerificationCommand[];
  executor: VerificationCommandExecutor;
  cache?: VerificationRunCache;
  reporter?: VerificationReporter;
}

const OUTPUT_TAIL_CHARS = 4000;

export function createVerificationRunCache(): VerificationRunCache {
  const passed = new Set<string>();
  return {
    has: (fingerprint) => passed.has(fingerprint),
    add: (fingerprint) => {
      passed.add(fingerprint);
    },
  };
}

export async function runVerificationPolicy(opts: RunVerificationPolicyOptions): Promise<void> {
  if (!isVerificationEnabledForPhase(opts.config, opts.phase)) return;
  if (opts.config.mode === "agent") return;

  for (const command of opts.commands) {
    const fingerprint = fingerprintVerificationInputs({
      cwd: opts.cwd,
      toolName: opts.toolName,
      phase: opts.phase,
      commands: [command],
    });
    if (await verificationCacheHit(opts, fingerprint)) {
      opts.reporter?.message(`${opts.toolName}: verification cache hit — skipped ${formatCommand(command)}.`, { level: "info" });
      continue;
    }

    await executeWithRetries(opts, command);
    markVerificationPassed(opts, fingerprint);
  }
}

async function executeWithRetries(opts: RunVerificationPolicyOptions, command: VerificationCommand): Promise<void> {
  const maxAttempts = Math.max(1, opts.config.maxAttempts);
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    let result: VerificationCommandResult;
    try {
      result = await opts.executor(command);
    } catch (error) {
      result = { status: null, error: error instanceof Error ? error : new Error(String(error)) };
    }
    if (!result.error && result.status === 0) return;
    if (attempt === maxAttempts) {
      throw new Error(formatVerificationFailure(opts.toolName, opts.cwd, command, result, attempt, maxAttempts));
    }
    opts.reporter?.message(
      `${opts.toolName}: retrying verification gate (${formatCommand(command)} ${formatOutcome(result)}; attempt ${attempt}/${maxAttempts})`,
      { level: "warning" },
    );
  }
}

async function verificationCacheHit(opts: RunVerificationPolicyOptions, fingerprint: string): Promise<boolean> {
  if (opts.config.cache.mode === "off") return false;
  if (opts.cache?.has(fingerprint)) return true;
  if (opts.config.cache.mode !== "persistent") return false;
  return persistentCacheHas(opts.cwd, opts.config.cache.path, fingerprint);
}

function markVerificationPassed(opts: RunVerificationPolicyOptions, fingerprint: string): void {
  if (opts.config.cache.mode === "off") return;
  opts.cache?.add(fingerprint);
  if (opts.config.cache.mode === "persistent") {
    persistentCacheAdd(opts.cwd, opts.config.cache.path, fingerprint, opts.toolName);
  }
}

interface PersistentVerificationCache {
  version: 1;
  passed: Record<string, { passedAt: string; toolName: string }>;
}

function persistentCachePath(cwd: string, configuredPath: string | undefined): string {
  const rel = configuredPath ?? path.join(".sf-workflow", "verification-cache.json");
  return path.isAbsolute(rel) ? rel : path.join(cwd, rel);
}

function readPersistentCache(cwd: string, configuredPath: string | undefined): PersistentVerificationCache | undefined {
  try {
    const parsed = JSON.parse(readFileSync(persistentCachePath(cwd, configuredPath), "utf8")) as PersistentVerificationCache;
    if (parsed.version !== 1 || typeof parsed.passed !== "object" || parsed.passed === null) return undefined;
    return parsed;
  } catch {
    // Cache misses are closed: any missing/unreadable/invalid cache forces a real verification run.
    return undefined;
  }
}

function persistentCacheHas(cwd: string, configuredPath: string | undefined, fingerprint: string): boolean {
  return !!readPersistentCache(cwd, configuredPath)?.passed[fingerprint];
}

function persistentCacheAdd(cwd: string, configuredPath: string | undefined, fingerprint: string, toolName: string): void {
  const filePath = persistentCachePath(cwd, configuredPath);
  const cache = readPersistentCache(cwd, configuredPath) ?? { version: 1, passed: {} };
  cache.passed[fingerprint] = { passedAt: new Date().toISOString(), toolName };
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(cache, null, 2));
}

function formatVerificationFailure(
  toolName: string,
  cwd: string,
  command: VerificationCommand,
  result: VerificationCommandResult,
  attempt: number,
  maxAttempts: number,
): string {
  const lines = [
    `${toolName}: verification gate failed (${formatCommand(command)} ${formatOutcome(result)})`,
    `cwd: ${cwd}`,
    `attempt ${attempt}/${maxAttempts}`,
  ];
  if (result.error) lines.push(`spawn error: ${result.error.message}`);
  const stderr = outputTail(result.stderr);
  if (stderr) lines.push(`stderr:\n${stderr}`);
  const stdout = outputTail(result.stdout);
  if (stdout) lines.push(`stdout:\n${stdout}`);
  return lines.join("\n");
}

function formatOutcome(result: VerificationCommandResult): string {
  if (result.error) return "spawn error";
  if (result.status === null) return `signal ${result.signal ?? "unknown"}`;
  return `exited ${result.status}`;
}

export function formatCommand(command: VerificationCommand): string {
  return [command.cmd, ...command.args].join(" ");
}

function outputTail(output: string | null | undefined): string {
  const text = (output ?? "").trim();
  if (text.length <= OUTPUT_TAIL_CHARS) return text;
  return `[truncated to last ${OUTPUT_TAIL_CHARS} chars]\n${text.slice(-OUTPUT_TAIL_CHARS)}`;
}
