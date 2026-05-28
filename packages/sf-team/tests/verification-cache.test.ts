import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const spawnSyncMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawnSync: spawnSyncMock };
});

const { createVerificationRunCache } = await import("@pi-stef/agent-workflows");
const { runConfiguredVerification } = await import("../src/tools/verification-stage");

function makeFixture(): { root: string; dispose: () => void } {
  const root = mkdtempSync(path.join(tmpdir(), "sf-team-verification-cache-"));
  writeFileSync(path.join(root, "package.json"), JSON.stringify({
    packageManager: "npm@10.0.0",
    scripts: { typecheck: "true", test: "true" },
  }, null, 2));
  return { root, dispose: () => rmSync(root, { recursive: true, force: true }) };
}

beforeEach(() => {
  spawnSyncMock.mockReset();
  spawnSyncMock.mockReturnValue({ status: 0, stdout: "", stderr: "" });
});

afterEach(() => {
  spawnSyncMock.mockReset();
});

describe("sf-team verification cache", () => {
  function commandCalls(): Array<[unknown, unknown]> {
    return spawnSyncMock.mock.calls
      .filter(([cmd]) => cmd !== "git")
      .map(([cmd, args]) => [cmd, args]);
  }

  it("shares run-scoped cache across repeated tool verification calls", async () => {
    const { root, dispose } = makeFixture();
    try {
      const cache = createVerificationRunCache();
      await runConfiguredVerification({
        toolName: "sf_team_task",
        cwd: root,
        phase: "after",
        verification: { timing: "after", cache: "run" },
        cache,
      });
      await runConfiguredVerification({
        toolName: "sf_team_task",
        cwd: root,
        phase: "after",
        verification: { timing: "after", cache: "run" },
        cache,
      });
      expect(commandCalls()).toEqual([
        ["npm", ["run", "typecheck"]],
        ["npm", ["run", "test"]],
      ]);
    } finally {
      dispose();
    }
  });

  it("runs again when the package verification fingerprint changes", async () => {
    const { root, dispose } = makeFixture();
    try {
      const cache = createVerificationRunCache();
      await runConfiguredVerification({
        toolName: "sf_team_task",
        cwd: root,
        phase: "after",
        verification: { timing: "after", cache: "run", stages: "test" },
        cache,
      });
      writeFileSync(path.join(root, "package.json"), JSON.stringify({
        packageManager: "npm@10.0.0",
        scripts: { test: "node test.js" },
      }, null, 2));
      await runConfiguredVerification({
        toolName: "sf_team_task",
        cwd: root,
        phase: "after",
        verification: { timing: "after", cache: "run", stages: "test" },
        cache,
      });
      expect(commandCalls()).toHaveLength(2);
    } finally {
      dispose();
    }
  });
});
