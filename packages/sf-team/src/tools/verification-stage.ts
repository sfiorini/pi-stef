import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import {
  formatCommand as formatVerificationCommand,
  resolveVerificationConfig,
  runVerificationPolicy,
  runVerifierAgent,
  type ResolvedVerificationConfig,
  type VerificationCommand,
  type VerificationConfigInput,
  type VerificationPhase,
  type VerificationRunCache,
  type VerificationStageSpec,
  type WorkflowCheckpointRuntime,
  type WorkflowReporter,
} from "@pi-stef/agent-workflows";

import type { ResolvedDefaults } from "../config/schema";
import { DEFAULT_CONFIG } from "../config/schema";
import { detectPackageManager, packageScriptsAt } from "../runtime/package-manager";
import type { AgentRun, AgentTask, TeamMember } from "../runtime/types";

export interface VerificationStage {
  cmd: string;
  args: string[];
  label?: string;
  script?: string;
}

export interface VerificationStageOptions {
  maxAttempts?: number;
  reporter?: WorkflowReporter;
  checkpoints?: WorkflowCheckpointRuntime;
  /**
   * Phase the stage runs in. Forwarded to the typed
   * {@link VerificationGateFailure} thrown on failure so the gate-loop
   * helper can tell after-gates from before-gates. Defaults to "after".
   */
  phase?: "before" | "after";
}

/**
 * Structured fields carried by {@link VerificationGateFailure}. Used by
 * the verification-gate fix-loop helper to synthesize a P0 reviewer
 * finding without re-parsing the prose `.message`.
 */
export interface VerificationGateFailureFields {
  toolName: string;
  phase: "before" | "after";
  stageLabel: string;
  command: { cmd: string; args: string[] };
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdoutTail: string;
  stderrTail: string;
  diagnosticsPath?: string;
  attempt: number;
  maxAttempts: number;
}

/**
 * Typed error thrown by {@link runVerificationStage} (and propagated by
 * {@link runConfiguredVerification}) when a verification command fails.
 *
 * Extends `Error` so existing catch-all sites continue to work; the
 * `.message` matches {@link formatVerificationFailure}'s output for
 * commands-mode failures (best-effort for verifier-agent failures, since
 * those go through `runVerifierAgent`'s own throw which doesn't use the
 * formatter).
 */
export class VerificationGateFailure extends Error {
  readonly toolName: string;
  readonly phase: "before" | "after";
  readonly stageLabel: string;
  readonly command: { cmd: string; args: string[] };
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdoutTail: string;
  readonly stderrTail: string;
  readonly diagnosticsPath?: string;
  readonly attempt: number;
  readonly maxAttempts: number;

  constructor(message: string, fields: VerificationGateFailureFields) {
    super(message);
    this.name = "VerificationGateFailure";
    this.toolName = fields.toolName;
    this.phase = fields.phase;
    this.stageLabel = fields.stageLabel;
    this.command = fields.command;
    this.exitCode = fields.exitCode;
    this.signal = fields.signal;
    this.stdoutTail = fields.stdoutTail;
    this.stderrTail = fields.stderrTail;
    this.diagnosticsPath = fields.diagnosticsPath;
    this.attempt = fields.attempt;
    this.maxAttempts = fields.maxAttempts;
  }
}

const MAX_BUFFER_BYTES = 50 * 1024 * 1024;
const OUTPUT_TAIL_CHARS = 4000;
const DEFAULT_MAX_ATTEMPTS = 1;
const DEFAULT_CONFIGURED_MAX_ATTEMPTS = 2;

export type SfTeamVerificationToolName =
  | "sf_team_plan"
  | "sf_team_implement"
  | "sf_team_task"
  | "sf_team_auto"
  | "sf_team_followup";

export type SfTeamVerificationConfigInput = VerificationConfigInput & {
  /** Config-file-friendly alias. Normalized to maxAttempts before shared resolution. */
  max_attempts?: number;
};

export interface RunConfiguredVerificationOptions {
  toolName: SfTeamVerificationToolName;
  cwd: string;
  phase: VerificationPhase;
  verification?: SfTeamVerificationConfigInput;
  /** Backward-compatible prompt/input override. false disables the gate; command runs as the only command. */
  legacyVerifyCommand?: { cmd: string; args: string[] } | false;
  reporter?: WorkflowReporter;
  checkpoints?: WorkflowCheckpointRuntime;
  cache?: VerificationRunCache;
  /** Absolute plan-folder cache path supplied by the orchestrator for persistent caches. */
  persistentCachePath?: string;
  agent?: {
    member: TeamMember;
    spawnAgent: (member: TeamMember, task: AgentTask) => Promise<AgentRun>;
  };
}

export function resolveToolVerificationConfig(
  toolName: SfTeamVerificationToolName,
  config?: SfTeamVerificationConfigInput,
  override?: SfTeamVerificationConfigInput,
): ResolvedVerificationConfig {
  return resolveVerificationConfig(toolName, normalizeFhVerificationConfig(config), normalizeFhVerificationConfig(override));
}

export function verificationDefaultsForPlanPhase(
  defaults: ResolvedDefaults = DEFAULT_CONFIG,
  opts: { invokedByAuto: boolean },
): ResolvedDefaults {
  if (!opts.invokedByAuto) return defaults;
  return {
    ...defaults,
    plan: {
      ...defaults.plan,
      verification: { ...(defaults.plan.verification ?? {}), timing: "off" },
    },
  };
}

export function verificationDefaultsForAutoImplement(
  defaults: ResolvedDefaults = DEFAULT_CONFIG,
  inputOverride?: SfTeamVerificationConfigInput,
): ResolvedDefaults {
  // When `sf_team_auto` calls `implementTool` internally it passes
  // `toolName: "sf_team_implement"`, so implement reads its config from
  // `implement.*`. We map auto.* knobs onto the implement.* surface here
  // so behavior overrides land on the right keys: verification (M2
  // legacy), empty_diff_retries / empty_diff_retry_model (M3).
  return {
    ...defaults,
    implement: {
      ...defaults.implement,
      verification: normalizeFhVerificationConfig(inputOverride) ?? defaults.auto.verification,
      empty_diff_retries: defaults.auto.empty_diff_retries,
      empty_diff_retry_model: defaults.auto.empty_diff_retry_model,
    },
  };
}

export async function runConfiguredVerification(opts: RunConfiguredVerificationOptions): Promise<void> {
  const override = legacyVerifyCommandToConfig(opts.legacyVerifyCommand);
  const config = withPersistentCachePath(
    resolveToolVerificationConfig(opts.toolName, opts.verification, override),
    opts.persistentCachePath,
  );
  if (!shouldRunPhase(config, opts.phase)) return;
  const commands = resolveVerificationCommands(opts.toolName, opts.cwd, config, opts.reporter);

  // The shared `runVerificationPolicy` rewraps any executor-thrown error
  // as a generic `Error` before re-throwing. To preserve type fidelity
  // for `runVerificationGateWithFixLoop`, capture the last typed failure
  // in a closure and rethrow it from the outer try/catch around
  // `runVerificationPolicy`. Same pattern for the verifier-agent branch.
  let lastTypedFailure: VerificationGateFailure | undefined;

  if (config.mode === "commands" || config.mode === "commands-and-agent") {
    // Retry and checkpoint behavior stays in runVerificationStage so existing
    // diagnostics and M4 checkpoint semantics are preserved while the shared
    // runner owns timing + cache decisions.
    try {
      await runVerificationPolicy({
        toolName: opts.toolName,
        cwd: opts.cwd,
        phase: opts.phase,
        config: { ...config, maxAttempts: 1 },
        commands,
        cache: opts.cache,
        reporter: opts.reporter,
        executor: async (command) => {
          try {
            runVerificationStage(opts.toolName, opts.cwd, command, {
              maxAttempts: config.maxAttempts,
              reporter: opts.reporter,
              checkpoints: opts.checkpoints,
              phase: opts.phase,
            });
          } catch (error) {
            if (error instanceof VerificationGateFailure) {
              lastTypedFailure = error;
            }
            return { status: 1, stdout: "", stderr: error instanceof Error ? error.message : String(error) };
          }
          return { status: 0, stdout: "", stderr: "" };
        },
      });
    } catch (policyError) {
      if (lastTypedFailure) throw lastTypedFailure;
      throw policyError;
    }
  }

  if (config.mode === "agent" || config.mode === "commands-and-agent") {
    if (!opts.agent) {
      throw new Error(`${opts.toolName}: verification mode '${config.mode}' requires a verifier agent`);
    }
    try {
      await runVerificationPolicy({
        toolName: opts.toolName,
        cwd: opts.cwd,
        phase: opts.phase,
        config: { ...config, mode: "commands", maxAttempts: 1 },
        commands: [{
          label: "verifier-agent",
          cmd: "sf-team-verifier-agent",
          args: [config.mode, ...commands.map(formatVerificationCommand)],
        }],
        cache: opts.cache,
        reporter: opts.reporter,
        executor: async () => {
          try {
            await runVerifierAgent(
              {
                toolName: opts.toolName,
                cwd: opts.cwd,
                phase: opts.phase,
                commands,
              },
              (task) => opts.agent!.spawnAgent(opts.agent!.member, task),
            );
          } catch (error) {
            // `runVerifierAgent` throws its own Error today. Wrap as a
            // VerificationGateFailure so the gate-loop helper sees the
            // same typed shape regardless of mode. Best-effort message
            // compatibility (the legacy path didn't go through
            // formatVerificationFailure, so callers that string-matched
            // on `.message` need a smoke check).
            const message = error instanceof Error ? error.message : String(error);
            const wrapped = new VerificationGateFailure(message, {
              toolName: opts.toolName,
              phase: opts.phase as "before" | "after",
              stageLabel: "verifier-agent",
              command: { cmd: "verifier-agent", args: [] },
              exitCode: null,
              signal: null,
              stdoutTail: "",
              stderrTail: tailBytes(message, 4 * 1024),
              attempt: 1,
              maxAttempts: 1,
            });
            lastTypedFailure = wrapped;
            return { status: 1, stdout: "", stderr: wrapped.message };
          }
          return { status: 0, stdout: "", stderr: "" };
        },
      });
    } catch (policyError) {
      if (lastTypedFailure) throw lastTypedFailure;
      throw policyError;
    }
  }
}

export function runLegacyVerificationSync(
  toolName: SfTeamVerificationToolName,
  cwd: string,
  verifyCommand: { cmd: string; args: string[] } | false | undefined,
  reporter?: WorkflowReporter,
  checkpoints?: WorkflowCheckpointRuntime,
): void {
  if (verifyCommand === false) return;
  if (verifyCommand) {
    runVerificationStage(toolName, cwd, verifyCommand, { maxAttempts: DEFAULT_CONFIGURED_MAX_ATTEMPTS, reporter, checkpoints });
    return;
  }
  const pm = detectPackageManager(cwd);
  const present = packageScriptsAt(cwd, toolName);
  const stages: VerificationCommand[] = [
    { label: "typecheck", script: "typecheck", cmd: pm, args: ["run", "typecheck"] },
    { label: "test", script: "test", cmd: pm, args: ["run", "test"] },
  ];
  for (const stage of stages) {
    if (!present.has(stage.script ?? "")) {
      reportVerificationNotice(
        `${toolName}: verification gate skipped — no \`${stage.script}\` script in ${cwd}/package.json.`,
        reporter,
      );
      continue;
    }
    runVerificationStage(toolName, cwd, stage, { maxAttempts: DEFAULT_CONFIGURED_MAX_ATTEMPTS, reporter, checkpoints });
  }
}

export function runVerificationStage(
  toolName: string,
  cwd: string,
  stage: VerificationStage,
  opts: VerificationStageOptions = {},
): void {
  if (opts.checkpoints) {
    opts.checkpoints.runVoidStepSync(
      `verification:${toolName}:${formatCommand(stage).replace(/[^A-Za-z0-9._-]+/g, "-")}`,
      { toolName, cwd, stage },
      () => runVerificationStageUncheckpointed(toolName, cwd, stage, opts),
    );
    return;
  }
  runVerificationStageUncheckpointed(toolName, cwd, stage, opts);
}

function runVerificationStageUncheckpointed(
  toolName: string,
  cwd: string,
  stage: VerificationStage,
  opts: VerificationStageOptions = {},
): void {
  const maxAttempts = resolveMaxAttempts(opts.maxAttempts);
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const result = spawnSync(stage.cmd, stage.args, {
      cwd,
      encoding: "utf8",
      // Verification output is diagnostic data, not the pass/fail condition.
      // Keep the buffer high enough that chatty test runners do not fail only
      // because Node hit its default 1 MiB spawnSync capture limit.
      maxBuffer: MAX_BUFFER_BYTES,
    });

    if (!result.error && result.status === 0) {
      return;
    }

    if (!isRetryableFailure(result) || attempt === maxAttempts) {
      const stageLabel = stage.label ?? truncate(`${stage.cmd} ${stage.args.join(" ")}`, 80);
      throw new VerificationGateFailure(
        formatVerificationFailure(toolName, cwd, stage, result, attempt, maxAttempts),
        {
          toolName,
          phase: opts.phase ?? "after",
          stageLabel,
          command: { cmd: stage.cmd, args: [...stage.args] },
          exitCode: result.status,
          signal: result.signal,
          stdoutTail: tailBytes(result.stdout ?? "", 4 * 1024),
          stderrTail: tailBytes(result.stderr ?? "", 4 * 1024),
          attempt,
          maxAttempts,
        },
      );
    }

    reportVerificationNotice(
      `${toolName}: retrying verification gate (${formatCommand(stage)} ${formatOutcome(result)}; attempt ${attempt}/${maxAttempts})`,
      opts.reporter,
      "warning",
    );
  }
}

export function reportVerificationNotice(
  message: string,
  reporter: WorkflowReporter | undefined,
  level: "info" | "warning" | "error" = "info",
): void {
  if (reporter) {
    reporter.message(message, { level });
    return;
  }
  console.error(message);
}

function resolveMaxAttempts(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_MAX_ATTEMPTS;
  return Math.max(1, Math.floor(value));
}

function isRetryableFailure(result: SpawnSyncReturns<string>): boolean {
  return !result.error && result.status !== null && result.status !== 0;
}

function formatVerificationFailure(
  toolName: string,
  cwd: string,
  stage: VerificationStage,
  result: SpawnSyncReturns<string>,
  attempt?: number,
  maxAttempts?: number,
): string {
  const lines = [
    `${toolName}: verification gate failed (${formatCommand(stage)} ${formatOutcome(result)})`,
    `cwd: ${cwd}`,
  ];
  if (attempt !== undefined && maxAttempts !== undefined) {
    lines.push(`attempt ${attempt}/${maxAttempts}`);
  }

  if (result.error) {
    lines.push(`spawn error: ${result.error.message}`);
  }

  const stderr = outputTail(result.stderr);
  if (stderr) {
    lines.push(`stderr:\n${stderr}`);
  }

  const stdout = outputTail(result.stdout);
  if (stdout) {
    lines.push(`stdout:\n${stdout}`);
  }

  return lines.join("\n");
}

function formatOutcome(result: SpawnSyncReturns<string>): string {
  if (result.error) return "spawn error";
  if (result.status === null) return `signal ${result.signal ?? "unknown"}`;
  return `exited ${result.status}`;
}

function formatCommand(stage: VerificationStage): string {
  return [stage.cmd, ...stage.args].join(" ");
}

function outputTail(output: string | null | undefined): string {
  const text = (output ?? "").trim();
  if (text.length <= OUTPUT_TAIL_CHARS) return text;
  return `[truncated to last ${OUTPUT_TAIL_CHARS} chars]\n${text.slice(-OUTPUT_TAIL_CHARS)}`;
}

/**
 * Return the LAST `max` bytes of `s` (UTF-8 byte budget, not JS string
 * length). For diagnostic data we want the tail (assertion failures sit
 * at the end). Uses Buffer length for byte measurement; if the slice
 * lands mid-codepoint the result is decoded with `replacement: �`
 * via Buffer's default decoder, which is acceptable for diagnostic data.
 */
function tailBytes(s: string, max: number): string {
  const buf = Buffer.from(s, "utf8");
  if (buf.byteLength <= max) return s;
  return buf.subarray(buf.byteLength - max).toString("utf8");
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max);
}

function normalizeFhVerificationConfig(
  input: SfTeamVerificationConfigInput | undefined,
): VerificationConfigInput | undefined {
  if (!input) return undefined;
  const { max_attempts, ...rest } = input;
  return {
    ...rest,
    maxAttempts: rest.maxAttempts ?? max_attempts,
  };
}

function legacyVerifyCommandToConfig(
  verifyCommand: RunConfiguredVerificationOptions["legacyVerifyCommand"],
): VerificationConfigInput | undefined {
  if (verifyCommand === false) return { timing: "off" };
  if (!verifyCommand) return undefined;
  return {
    timing: "after",
    mode: "commands",
    stages: [],
    commands: [{ label: "custom", cmd: verifyCommand.cmd, args: verifyCommand.args }],
    cache: "off",
  };
}

function resolveVerificationCommands(
  toolName: SfTeamVerificationToolName,
  cwd: string,
  config: ResolvedVerificationConfig,
  reporter: WorkflowReporter | undefined,
): VerificationCommand[] {
  const commands: VerificationCommand[] = [];
  const pm = detectPackageManager(cwd);
  const present = packageScriptsAt(cwd, toolName);
  for (const stage of config.stages) {
    if (typeof stage === "string") {
      if (!present.has(stage)) {
        reportVerificationNotice(
          `${toolName}: verification gate skipped — no \`${stage}\` script in ${cwd}/package.json.`,
          reporter,
        );
        continue;
      }
      commands.push({ label: stage, script: stage, cmd: pm, args: ["run", stage] });
      continue;
    }
    commands.push(copyCommand(stage));
  }
  commands.push(...config.commands.map(copyCommand));
  return commands;
}

function copyCommand(command: VerificationCommand): VerificationCommand {
  return {
    ...(command.label ? { label: command.label } : {}),
    ...(command.script ? { script: command.script } : {}),
    cmd: command.cmd,
    args: [...command.args],
  };
}

function shouldRunPhase(config: ResolvedVerificationConfig, phase: VerificationPhase): boolean {
  if (config.timing === "off") return false;
  if (config.timing === "both") return true;
  return config.timing === phase;
}

function withPersistentCachePath(
  config: ResolvedVerificationConfig,
  persistentCachePath: string | undefined,
): ResolvedVerificationConfig {
  if (!persistentCachePath || config.cache.mode !== "persistent" || config.cache.path) return config;
  return { ...config, cache: { ...config.cache, path: persistentCachePath } };
}

export { formatVerificationCommand };
