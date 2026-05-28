import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import {
  readWorkflowMetadata,
  readLockMetadata,
  runWorkflow,
  workflowVerificationCachePath,
  type WorkflowReporter,
} from "../src";

function tempRepo(): { root: string; dispose: () => void } {
  const root = mkdtempSync(path.join(tmpdir(), "workflow-runtime-"));
  return { root, dispose: () => rmSync(root, { recursive: true, force: true }) };
}

function reporter(events: string[]): WorkflowReporter {
  return {
    message: (text) => {
      events.push(`message:${text}`);
      return text;
    },
    clearMessage: (id) => {
      events.push(`clear:${id}`);
    },
    dispose: () => {
      events.push("dispose");
    },
  };
}

describe("runWorkflow", () => {
  it("acquires/releases the plan lock, creates shared runtimes, and returns success artifacts", async () => {
    const { root, dispose } = tempRepo();
    try {
      const events: string[] = [];
      const result = await runWorkflow<string, string, { performanceReportPath: string }>(
        {
          repoRoot: root,
          slug: "demo",
          toolName: "sf_team_task",
          useWorktree: false,
          promptForResume: async () => ({ resume: true }),
          createReporter: () => reporter(events),
          resolveBaseline: async () => "baseline",
          onSuccess: async (ctx, bodyResult: string) => {
            expect(ctx.baseline).toBe("baseline");
            expect(ctx.verificationCachePath).toBe(workflowVerificationCachePath(root, "demo"));
            expect(ctx.verificationCache.has("x")).toBe(false);
            ctx.verificationCache.add("x");
            expect(ctx.verificationCache.has("x")).toBe(true);
            return { performanceReportPath: `${bodyResult}.json` };
          },
          beforeReporterDispose: () => {
            events.push("before-dispose");
          },
          afterReporterDispose: () => {
            events.push("after-dispose");
          },
          afterLockRelease: async () => {
            events.push("after-release");
          },
        },
        async (ctx) => {
          expect(ctx.lock.slug).toBe("demo");
          expect(await readLockMetadata(root, "demo")).toBeDefined();
          ctx.reporter.message("running");
          return "ok";
        },
      );

      expect(result).toEqual({ result: "ok", artifacts: { performanceReportPath: "ok.json" } });
      expect(await readLockMetadata(root, "demo")).toBeUndefined();
      expect(events).toEqual(["message:running", "before-dispose", "dispose", "after-dispose", "after-release"]);
    } finally {
      dispose();
    }
  });

  it("writes workflow metadata at start and marks it completed on success", async () => {
    const { root, dispose } = tempRepo();
    try {
      await runWorkflow(
        {
          repoRoot: root,
          slug: "metadata-success",
          toolName: "sf_team_task",
          useWorktree: false,
          promptForResume: async () => ({ resume: true }),
          createReporter: () => reporter([]),
        },
        async () => {
          const duringRun = await readWorkflowMetadata(root, "metadata-success");
          expect(duringRun).toMatchObject({
            slug: "metadata-success",
            ownerTool: "sf_team_task",
            currentTool: "sf_team_task",
            status: "running",
            phase: "running",
          });
          return "ok";
        },
      );

      await expect(readWorkflowMetadata(root, "metadata-success")).resolves.toMatchObject({
        ownerTool: "sf_team_task",
        currentTool: "sf_team_task",
        status: "completed",
        phase: "running",
      });
    } finally {
      dispose();
    }
  });

  it("updates nested auto metadata without clobbering owner or createdAt", async () => {
    const { root, dispose } = tempRepo();
    try {
      await runWorkflow(
        {
          repoRoot: root,
          slug: "metadata-auto",
          toolName: "sf_team_plan",
          ownerTool: "sf_team_auto",
          useWorktree: true,
          promptForResume: async () => ({ resume: true }),
          createReporter: () => reporter([]),
        },
        async () => "plan",
      );
      const afterPlan = await readWorkflowMetadata(root, "metadata-auto");
      expect(afterPlan).toMatchObject({
        ownerTool: "sf_team_auto",
        currentTool: "sf_team_plan",
        status: "completed",
      });

      await runWorkflow(
        {
          repoRoot: root,
          slug: "metadata-auto",
          toolName: "sf_team_implement",
          ownerTool: "sf_team_auto",
          useWorktree: true,
          promptForResume: async () => ({ resume: true }),
          createReporter: () => reporter([]),
        },
        async () => {
          const duringImplement = await readWorkflowMetadata(root, "metadata-auto");
          expect(duringImplement).toMatchObject({
            ownerTool: "sf_team_auto",
            currentTool: "sf_team_implement",
            status: "running",
          });
          expect(duringImplement?.createdAt).toBe(afterPlan?.createdAt);
          return "implement";
        },
      );

      const afterImplement = await readWorkflowMetadata(root, "metadata-auto");
      expect(afterImplement).toMatchObject({
        ownerTool: "sf_team_auto",
        currentTool: "sf_team_implement",
        status: "completed",
      });
      expect(afterImplement?.createdAt).toBe(afterPlan?.createdAt);
    } finally {
      dispose();
    }
  });

  it("allows an explicit normal handoff to claim a plan-owned folder", async () => {
    const { root, dispose } = tempRepo();
    try {
      await runWorkflow(
        {
          repoRoot: root,
          slug: "metadata-handoff",
          toolName: "sf_team_plan",
          useWorktree: true,
          promptForResume: async () => ({ resume: true }),
          createReporter: () => reporter([]),
        },
        async () => "plan",
      );

      await runWorkflow(
        {
          repoRoot: root,
          slug: "metadata-handoff",
          toolName: "sf_team_implement",
          useWorktree: true,
          allowOwnerTakeoverFrom: ["sf_team_plan"],
          promptForResume: async () => ({ resume: true }),
          createReporter: () => reporter([]),
        },
        async () => "implement",
      );

      await expect(readWorkflowMetadata(root, "metadata-handoff")).resolves.toMatchObject({
        ownerTool: "sf_team_implement",
        currentTool: "sf_team_implement",
        status: "completed",
      });
    } finally {
      dispose();
    }
  });

  it("declines before acquiring a lock or creating a reporter", async () => {
    const { root, dispose } = tempRepo();
    try {
      const createReporter = vi.fn(() => reporter([]));
      const body = vi.fn();
      const result = await runWorkflow(
        {
          repoRoot: root,
          slug: "decline",
          toolName: "sf_team_plan",
          useWorktree: true,
          promptForResume: async () => ({ resume: false }),
          createReporter,
        },
        body,
      );

      expect(result.declinedResume).toBe(true);
      expect(createReporter).not.toHaveBeenCalled();
      expect(body).not.toHaveBeenCalled();
      expect(existsSync(path.join(root, "ai_plan", "decline", ".sf-team.lock"))).toBe(false);
    } finally {
      dispose();
    }
  });

  it("runs error hooks, disposes reporter, releases the lock, and rethrows body errors", async () => {
    const { root, dispose } = tempRepo();
    try {
      const events: string[] = [];
      await expect(runWorkflow(
        {
          repoRoot: root,
          slug: "boom",
          toolName: "sf_team_implement",
          useWorktree: true,
          promptForResume: async () => ({ resume: true }),
          createReporter: () => reporter(events),
          onError: async (_ctx, error) => {
            events.push(`error:${error instanceof Error ? error.message : String(error)}`);
          },
          beforeReporterDispose: () => {
            events.push("before-dispose");
          },
          afterReporterDispose: () => {
            events.push("after-dispose");
          },
          afterLockRelease: () => {
            events.push("after-release");
          },
        },
        async () => {
          throw new Error("body failed");
        },
      )).rejects.toThrow("body failed");

      expect(await readLockMetadata(root, "boom")).toBeUndefined();
      expect(events).toEqual(["error:body failed", "before-dispose", "dispose", "after-dispose", "after-release"]);
    } finally {
      dispose();
    }
  });
});
