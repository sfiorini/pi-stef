import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import {
  createVerificationRunCache,
  runVerificationPolicy,
  type VerificationCommand,
} from "../src/verification/runner";

function tempCwd(): { root: string; dispose: () => void } {
  const root = mkdtempSync(path.join(tmpdir(), "workflow-verification-runner-"));
  return { root, dispose: () => rmSync(root, { recursive: true, force: true }) };
}

describe("verification runner", () => {
  it("runs only for the configured phase and executes commands in order", async () => {
    const { root, dispose } = tempCwd();
    try {
      const calls: VerificationCommand[] = [];
      const executor = vi.fn(async (command: VerificationCommand) => {
        calls.push(command);
        return { status: 0, stdout: "", stderr: "" };
      });
      await runVerificationPolicy({
        toolName: "sf_team_task",
        cwd: root,
        phase: "before",
        config: { timing: "after", mode: "commands", stages: [], commands: [], cache: { mode: "off" }, maxAttempts: 1 },
        commands: [{ label: "test", cmd: "pnpm", args: ["run", "test"] }],
        executor,
      });
      await runVerificationPolicy({
        toolName: "sf_team_task",
        cwd: root,
        phase: "after",
        config: { timing: "after", mode: "commands", stages: [], commands: [], cache: { mode: "off" }, maxAttempts: 1 },
        commands: [{ label: "test", cmd: "pnpm", args: ["run", "test"] }],
        executor,
      });
      expect(calls.map((call) => call.label)).toEqual(["test"]);
    } finally {
      dispose();
    }
  });

  it("deduplicates unchanged command fingerprints with the run-scoped cache", async () => {
    const { root, dispose } = tempCwd();
    try {
      const executor = vi.fn(async () => ({ status: 0, stdout: "", stderr: "" }));
      const messages: string[] = [];
      const cache = createVerificationRunCache();
      const request = {
        toolName: "sf_team_followup",
        cwd: root,
        phase: "after" as const,
        config: { timing: "after" as const, mode: "commands" as const, stages: [], commands: [], cache: { mode: "run" as const }, maxAttempts: 1 },
        commands: [{ label: "typecheck", cmd: "pnpm", args: ["run", "typecheck"] }],
        executor,
        cache,
        reporter: { message: (msg: string) => messages.push(msg) },
      };
      await runVerificationPolicy(request);
      await runVerificationPolicy(request);
      expect(executor).toHaveBeenCalledTimes(1);
      expect(messages.join("\n")).toMatch(/verification cache hit/);
    } finally {
      dispose();
    }
  });

  it("uses persistent cache only when opted in and treats unreadable/missing cache as a miss", async () => {
    const { root, dispose } = tempCwd();
    try {
      const executor = vi.fn(async () => ({ status: 0, stdout: "", stderr: "" }));
      const cachePath = path.join(root, ".fh-workflow", "verification-cache.json");
      const request = {
        toolName: "sf_team_implement",
        cwd: root,
        phase: "after" as const,
        config: {
          timing: "after" as const,
          mode: "commands" as const,
          stages: [],
          commands: [],
          cache: { mode: "persistent" as const, path: cachePath },
          maxAttempts: 1,
        },
        commands: [{ label: "test", cmd: "pnpm", args: ["run", "test"] }],
        executor,
      };
      await runVerificationPolicy(request);
      await runVerificationPolicy(request);
      expect(executor).toHaveBeenCalledTimes(1);

      const noCacheExecutor = vi.fn(async () => ({ status: 0, stdout: "", stderr: "" }));
      await runVerificationPolicy({
        ...request,
        config: { ...request.config, cache: { mode: "off" as const } },
        executor: noCacheExecutor,
      });
      await runVerificationPolicy({
        ...request,
        config: { ...request.config, cache: { mode: "off" as const } },
        executor: noCacheExecutor,
      });
      expect(noCacheExecutor).toHaveBeenCalledTimes(2);
    } finally {
      dispose();
    }
  });
});
