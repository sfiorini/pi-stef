import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock runConfiguredVerification so the helper sees scripted gate
// outcomes. The helper imports `runConfiguredVerification` from
// "./verification-stage", so we mock that exact module path. The
// VerificationGateFailure class is also re-exported from there; we keep
// the actual class so `instanceof` works in the helper.
vi.mock("../src/tools/verification-stage", async () => {
  const actual = await vi.importActual<typeof import("../src/tools/verification-stage")>(
    "../src/tools/verification-stage",
  );
  return {
    ...actual,
    runConfiguredVerification: vi.fn(),
  };
});

import {
  runVerificationGateWithFixLoop,
  VerificationGateFixUnapprovedError,
  type ReviewerCheck,
} from "../src/tools/verification-gate-loop";
import {
  runConfiguredVerification,
  VerificationGateFailure,
  type RunConfiguredVerificationOptions,
} from "../src/tools/verification-stage";
import type { ReviewerVerdict } from "../src/review/parse";
import type { TranscriptHandle } from "../src/orchestrator/transcript";

const mockedGate = vi.mocked(runConfiguredVerification);

function makeFailure(stderr = "AssertionError: expected x to equal y"): VerificationGateFailure {
  return new VerificationGateFailure("verification gate failed", {
    toolName: "sf_team_task",
    phase: "after",
    stageLabel: "test",
    command: { cmd: "pnpm", args: ["test"] },
    exitCode: 1,
    signal: null,
    stdoutTail: "",
    stderrTail: stderr,
    attempt: 1,
    maxAttempts: 1,
  });
}

function makeApprovedVerdict(): ReviewerVerdict {
  return {
    summary: "ok",
    findings: { P0: [], P1: [], P2: [], P3: [] },
    verdict: "APPROVED",
  };
}

function makeReviseVerdict(p0Note: string): ReviewerVerdict {
  return {
    summary: "still issues",
    findings: { P0: [p0Note], P1: [], P2: [], P3: [] },
    verdict: "REVISE",
  };
}

function makeTranscript(): TranscriptHandle {
  const records: any[] = [];
  return {
    record: vi.fn().mockImplementation(async (entry) => {
      records.push(entry);
      return undefined;
    }),
    setPhase: vi.fn(),
    folder: vi.fn().mockReturnValue("/tmp/transcript"),
    // Test-only escape hatch
    __records: records,
  } as unknown as TranscriptHandle;
}

const FAKE_GATE: RunConfiguredVerificationOptions = {
  toolName: "sf_team_task",
  cwd: "/tmp",
  phase: "after",
};

beforeEach(() => {
  mockedGate.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("runVerificationGateWithFixLoop", () => {
  it("case 1: gate passes first try — dev/reviewer never called, roundsUsed=0", async () => {
    mockedGate.mockResolvedValueOnce(undefined);
    const callbacks = {
      runDeveloperRevise: vi.fn(),
      runReviewer: vi.fn(),
      transcript: makeTranscript(),
    };
    const result = await runVerificationGateWithFixLoop({
      gate: FAKE_GATE,
      lastApprovedPayload: "summary",
      remainingRounds: 5,
      callbacks,
    });
    expect(result.roundsUsed).toBe(0);
    expect(callbacks.runDeveloperRevise).not.toHaveBeenCalled();
    expect(callbacks.runReviewer).not.toHaveBeenCalled();
    expect(mockedGate).toHaveBeenCalledTimes(1);
  });

  it("case 2: gate fails once, dev fixes, reviewer approves, gate passes — roundsUsed=1", async () => {
    mockedGate.mockRejectedValueOnce(makeFailure());
    mockedGate.mockResolvedValueOnce(undefined);
    const callbacks = {
      runDeveloperRevise: vi.fn().mockResolvedValue("fixed-summary"),
      runReviewer: vi.fn().mockResolvedValue({
        verdict: makeApprovedVerdict(),
        verdictText: "VERDICT: APPROVED",
      }),
      transcript: makeTranscript(),
    };
    const result = await runVerificationGateWithFixLoop({
      gate: FAKE_GATE,
      lastApprovedPayload: "summary",
      remainingRounds: 5,
      callbacks,
    });
    expect(result.roundsUsed).toBe(1);
    expect(callbacks.runDeveloperRevise).toHaveBeenCalledTimes(1);
    // Synthetic P0 propagated through to dev's findings
    const devCallArg = callbacks.runDeveloperRevise.mock.calls[0]![0];
    expect(devCallArg.findings.findings.P0.length).toBe(1);
    expect(devCallArg.findings.findings.P0[0]).toContain("AssertionError");
    expect(callbacks.runReviewer).toHaveBeenCalledTimes(1);
    expect(mockedGate).toHaveBeenCalledTimes(2);
  });

  it("case 3: gate keeps failing past remainingRounds — rethrows the LAST VerificationGateFailure (after dev's last approved fix is also retested)", async () => {
    // remaining=2 means the dev/reviewer pair gets 2 fix rounds total.
    // Each fix round happens after a gate failure and ends with the gate
    // re-running. So the loop sees:
    //   gate1 fails (A) → dev fix → reviewer APPROVE (round 1, remaining→1)
    //   gate2 fails (B) → dev fix → reviewer APPROVE (round 2, remaining→0)
    //   gate3 fails (C) → top-of-loop sees remaining<=0 → throw lastFailure=C
    // The test pins the contract that the LAST gate failure is the one
    // surfaced (verified by distinct stderr per call).
    mockedGate.mockRejectedValueOnce(makeFailure("FAIL_A"));
    mockedGate.mockRejectedValueOnce(makeFailure("FAIL_B"));
    mockedGate.mockRejectedValueOnce(makeFailure("FAIL_C"));
    const callbacks = {
      runDeveloperRevise: vi.fn().mockResolvedValue("fixed"),
      runReviewer: vi.fn().mockResolvedValue({
        verdict: makeApprovedVerdict(),
        verdictText: "VERDICT: APPROVED",
      }),
      transcript: makeTranscript(),
    };
    let caught: unknown;
    try {
      await runVerificationGateWithFixLoop({
        gate: FAKE_GATE,
        lastApprovedPayload: "summary",
        remainingRounds: 2,
        callbacks,
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(VerificationGateFailure);
    expect((caught as VerificationGateFailure).stderrTail).toContain("FAIL_C");
    expect((caught as VerificationGateFailure).stderrTail).not.toContain("FAIL_A");
    expect((caught as VerificationGateFailure).stderrTail).not.toContain("FAIL_B");
    expect(mockedGate).toHaveBeenCalledTimes(3);
    expect(callbacks.runDeveloperRevise).toHaveBeenCalledTimes(2);
  });

  it("case 4: reviewer rejects gate-fix mid-loop — throws VerificationGateFixUnapprovedError, gate not re-run", async () => {
    mockedGate.mockRejectedValueOnce(makeFailure("FAIL_A"));
    const callbacks = {
      runDeveloperRevise: vi.fn().mockResolvedValue("fixed"),
      // Reviewer always REVISE → inner loop exhausts before any gate re-run
      runReviewer: vi.fn().mockResolvedValue({
        verdict: makeReviseVerdict("not addressed"),
        verdictText: "VERDICT: REVISE",
      }),
      transcript: makeTranscript(),
    };
    let caught: unknown;
    try {
      await runVerificationGateWithFixLoop({
        gate: FAKE_GATE,
        lastApprovedPayload: "summary",
        remainingRounds: 3,
        callbacks,
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(VerificationGateFixUnapprovedError);
    const gateErr = caught as VerificationGateFixUnapprovedError;
    expect(gateErr.cause).toBeInstanceOf(VerificationGateFailure);
    expect(gateErr.cause.stderrTail).toContain("FAIL_A");
    expect(gateErr.lastReviewerVerdict?.verdict).toBe("REVISE");
    // Critical: gate is called exactly ONCE (the initial failure). It is
    // NOT re-run after the inner loop fails.
    expect(mockedGate).toHaveBeenCalledTimes(1);
    // Inner loop ran 3 rounds before exhausting
    expect(callbacks.runDeveloperRevise).toHaveBeenCalledTimes(3);
    expect(callbacks.runReviewer).toHaveBeenCalledTimes(3);
  });

  it("case 6: transcript meta.stage uses the sanitized + redacted stage label (no secret leak in transcript headers)", async () => {
    // The transcript metadata is rendered as visible markdown header
    // lines, so a stageLabel containing `Authorization: Bearer ...` or
    // `API_KEY=...` (or embedded newlines) must be redacted/sanitized
    // before it lands in transcript/.../verification-gate-failed*.md.
    const failure = new VerificationGateFailure("verification gate failed", {
      toolName: "sf_team_task",
      phase: "after",
      stageLabel: "Authorization: Bearer header-secret-123",
      command: { cmd: "pnpm", args: ["test"] },
      exitCode: 1,
      signal: null,
      stdoutTail: "",
      stderrTail: "ok",
      attempt: 1,
      maxAttempts: 1,
    });
    mockedGate.mockRejectedValueOnce(failure);
    const transcript = makeTranscript();
    const callbacks = {
      runDeveloperRevise: vi.fn(),
      runReviewer: vi.fn(),
      transcript,
    };
    try {
      await runVerificationGateWithFixLoop({
        gate: FAKE_GATE,
        lastApprovedPayload: "summary",
        remainingRounds: 0, // no fix loop; we only care about the transcript record made before rethrow
        callbacks,
      });
    } catch {
      /* expected: VerificationGateFailure rethrown after transcript write */
    }
    // Transcript was NEVER touched in this scenario because remaining=0
    // takes the immediate-rethrow branch BEFORE recording. Re-run with
    // remaining=1 so the helper records the entry.
    mockedGate.mockReset();
    mockedGate.mockRejectedValueOnce(failure);
    mockedGate.mockResolvedValueOnce(undefined);
    callbacks.runDeveloperRevise = vi.fn().mockResolvedValue("fixed");
    callbacks.runReviewer = vi.fn().mockResolvedValue({
      verdict: makeApprovedVerdict(),
      verdictText: "VERDICT: APPROVED",
    });
    const transcript2 = makeTranscript();
    callbacks.transcript = transcript2;
    await runVerificationGateWithFixLoop({
      gate: FAKE_GATE,
      lastApprovedPayload: "summary",
      remainingRounds: 1,
      callbacks,
    });
    const records = (transcript2 as any).__records as Array<any>;
    const failedEntry = records.find((r: any) => r.label === "verification-gate-failed");
    expect(failedEntry).toBeDefined();
    expect(JSON.stringify(failedEntry.meta)).not.toContain("header-secret-123");
    expect(JSON.stringify(failedEntry.meta)).toContain("[REDACTED auth-header line]");
  });

  it("case 5: remainingRounds === 0 on entry, gate fails — immediately rethrows without inner loop", async () => {
    mockedGate.mockRejectedValueOnce(makeFailure("FAIL_BUDGET_ZERO"));
    const callbacks = {
      runDeveloperRevise: vi.fn(),
      runReviewer: vi.fn(),
      transcript: makeTranscript(),
    };
    let caught: unknown;
    try {
      await runVerificationGateWithFixLoop({
        gate: FAKE_GATE,
        lastApprovedPayload: "summary",
        remainingRounds: 0,
        callbacks,
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(VerificationGateFailure);
    expect((caught as VerificationGateFailure).stderrTail).toContain("FAIL_BUDGET_ZERO");
    expect(callbacks.runDeveloperRevise).not.toHaveBeenCalled();
    expect(callbacks.runReviewer).not.toHaveBeenCalled();
  });
});
