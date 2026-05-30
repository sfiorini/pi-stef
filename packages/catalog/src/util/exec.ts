import { execFile } from "node:child_process";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Options for shell command execution. */
export interface ExecOptions {
  /** Kill the process after this many milliseconds. */
  timeout?: number;
  /** Working directory for the child process. */
  cwd?: string;
  /** Environment variables to merge into the child process. */
  env?: Record<string, string>;
}

/** Result of a successful command execution. */
export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/**
 * Error thrown when a child process exits with a non-zero code or is killed.
 * Carries captured stdout/stderr for diagnostics.
 */
export class ExecError extends Error {
  stdout: string;
  stderr: string;
  exitCode: number;

  constructor(
    message: string,
    stdout: string,
    stderr: string,
    exitCode: number,
  ) {
    super(message);
    this.name = "ExecError";
    this.stdout = stdout;
    this.stderr = stderr;
    this.exitCode = exitCode;
  }
}

// ---------------------------------------------------------------------------
// Core execution helper
// ---------------------------------------------------------------------------

/**
 * Execute a command via `execFile`, returning a promise that resolves with
 * `{ stdout, stderr, exitCode }` on success or rejects with an `ExecError`
 * on failure.
 */
export function execCommand(
  command: string,
  args: string[],
  options?: ExecOptions,
): Promise<ExecResult> {
  return new Promise<ExecResult>((resolve, reject) => {
    const spawnOptions: import("node:child_process").ExecFileOptions = {
      timeout: options?.timeout,
      cwd: options?.cwd,
      env: options?.env
        ? { ...process.env, ...options.env }
        : undefined,
      maxBuffer: 1024 * 1024, // 1 MB
    };

    execFile(
      command,
      args,
      spawnOptions,
      (error, stdout, stderr) => {
        const out = stdout ?? "";
        const err = stderr ?? "";

        if (error) {
          const isTimeout =
            error.killed === true ||
            error.message.toLowerCase().includes("timed out");

          if (isTimeout) {
            reject(
              new ExecError(
                `Command "${command}" timed out after ${options?.timeout ?? "unknown"}ms`,
                out,
                err,
                -1,
              ),
            );
          } else {
            // Node sets error.code to a string errno like 'ENOENT' for
            // spawn failures; numeric exit codes are on error.status.
            const exitCode =
              typeof (error as NodeJS.ErrnoException).status === "number"
                ? (error as NodeJS.ErrnoException).status!
                : 1;
            reject(
              new ExecError(
                `Command "${command}" failed: ${error.message}`,
                out,
                err,
                exitCode,
              ),
            );
          }
          return;
        }

        resolve({ stdout: out, stderr: err, exitCode: 0 });
      },
    );
  });
}

// ---------------------------------------------------------------------------
// Pi convenience wrappers
// ---------------------------------------------------------------------------

/** Options specific to pi install/uninstall. */
export interface PiExecOptions extends ExecOptions {
  /** If true, suppress interactive prompts. */
  nonInteractive?: boolean;
}

/**
 * Install a pi package from the given source.
 *
 * Runs `pi install <source>`.
 */
export function piInstall(
  source: string,
  options?: PiExecOptions,
): Promise<ExecResult> {
  return execCommand("pi", ["install", source], options);
}

/**
 * Uninstall a pi package by name.
 *
 * Runs `pi uninstall <packageName>`.
 */
export function piUninstall(
  packageName: string,
  options?: PiExecOptions,
): Promise<ExecResult> {
  return execCommand("pi", ["uninstall", packageName], options);
}
