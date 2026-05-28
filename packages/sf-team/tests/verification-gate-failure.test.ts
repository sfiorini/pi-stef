import { describe, expect, it } from "vitest";

import {
  VerificationGateFailure,
  runConfiguredVerification,
  runVerificationStage,
} from "../src/tools/verification-stage";

describe("VerificationGateFailure — typed-error propagation through runConfiguredVerification", () => {
  it("commands-mode failure surfaces VerificationGateFailure with populated fields", async () => {
    let caught: unknown;
    try {
      await runConfiguredVerification({
        toolName: "sf_team_task",
        cwd: process.cwd(),
        phase: "after",
        legacyVerifyCommand: {
          cmd: process.execPath, // node binary
          args: ["-e", "process.stderr.write('SENTINEL_STDERR'); process.exit(7)"],
        },
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(VerificationGateFailure);
    const f = caught as VerificationGateFailure;
    expect(f.toolName).toBe("sf_team_task");
    expect(f.phase).toBe("after");
    expect(f.stageLabel).toBe("custom"); // legacyVerifyCommandToConfig labels as "custom"
    expect(f.command.cmd).toBe(process.execPath);
    expect(f.command.args).toEqual([
      "-e",
      "process.stderr.write('SENTINEL_STDERR'); process.exit(7)",
    ]);
    expect(f.exitCode).toBe(7);
    expect(f.stderrTail).toContain("SENTINEL_STDERR");
    expect(f.attempt).toBeGreaterThanOrEqual(1);
    expect(f.maxAttempts).toBeGreaterThanOrEqual(1);
  });

  it("verifier-agent-mode failure wraps thrown error as VerificationGateFailure with stageLabel='verifier-agent'", async () => {
    let caught: unknown;
    try {
      await runConfiguredVerification({
        toolName: "sf_team_task",
        cwd: process.cwd(),
        phase: "after",
        verification: {
          timing: "after",
          mode: "agent",
          stages: ["test"],
        },
        agent: {
          member: { id: "verifier", model: "stub" } as any,
          spawnAgent: async () => {
            throw new Error("verifier agent rejected the diff: contrived test failure");
          },
        },
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(VerificationGateFailure);
    const f = caught as VerificationGateFailure;
    expect(f.toolName).toBe("sf_team_task");
    expect(f.phase).toBe("after");
    expect(f.stageLabel).toBe("verifier-agent");
    expect(f.command.cmd).toBe("verifier-agent");
    expect(f.stderrTail).toContain("contrived test failure");
  });

  it("stageLabel fallback: stage with no label uses `${cmd} ${args.join(' ')}` truncated to 80 chars", () => {
    let caught: unknown;
    try {
      runVerificationStage(
        "sf_team_task",
        process.cwd(),
        {
          cmd: process.execPath,
          // No label!
          args: [
            "-e",
            "process.exit(1)",
          ],
        },
        { maxAttempts: 1, phase: "after" },
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(VerificationGateFailure);
    const f = caught as VerificationGateFailure;
    // Fallback: ${cmd} ${args.join(" ")} truncated to 80 chars
    const expectedFull = `${process.execPath} -e process.exit(1)`;
    const expected = expectedFull.length > 80 ? expectedFull.slice(0, 80) : expectedFull;
    expect(f.stageLabel).toBe(expected);
    expect(f.stageLabel.length).toBeLessThanOrEqual(80);
  });
});
