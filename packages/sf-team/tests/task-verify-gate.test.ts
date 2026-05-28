import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const spawnSyncMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawnSync: spawnSyncMock };
});

const { runVerification } = await import("../src/tools/task");

interface CapturedCall {
  cmd: string;
  args: string[];
}

function capturedCalls(): CapturedCall[] {
  return spawnSyncMock.mock.calls.map(([cmd, args]) => ({
    cmd: cmd as string,
    args: (args as string[]) ?? [],
  }));
}

function makeFixture(opts: {
  packageJson?: Record<string, unknown> | undefined;
  files?: string[];
}): { root: string; dispose: () => void } {
  const root = mkdtempSync(path.join(tmpdir(), "task-verify-gate-"));
  if (opts.packageJson !== undefined) {
    writeFileSync(path.join(root, "package.json"), JSON.stringify(opts.packageJson, null, 2));
  }
  for (const f of opts.files ?? []) {
    writeFileSync(path.join(root, f), "");
  }
  return { root, dispose: () => rmSync(root, { recursive: true, force: true }) };
}

beforeEach(() => {
  spawnSyncMock.mockReset();
  spawnSyncMock.mockReturnValue({ status: 0, stdout: "", stderr: "" });
});

afterEach(() => {
  spawnSyncMock.mockReset();
});

describe("sf_team_task runVerification: package-manager auto-detection", () => {
  it("uses npm run <script> when package.json has packageManager: 'npm@...'", () => {
    const { root, dispose } = makeFixture({
      packageJson: { packageManager: "npm@10.2.0", scripts: { typecheck: "true", test: "true" } },
    });
    try {
      runVerification(root, undefined);
      expect(capturedCalls()).toEqual([
        { cmd: "npm", args: ["run", "typecheck"] },
        { cmd: "npm", args: ["run", "test"] },
      ]);
    } finally {
      dispose();
    }
  });

  it("uses pnpm run <script> when only pnpm-lock.yaml is present", () => {
    const { root, dispose } = makeFixture({
      packageJson: { scripts: { typecheck: "true", test: "true" } },
      files: ["pnpm-lock.yaml"],
    });
    try {
      runVerification(root, undefined);
      expect(capturedCalls().map((c) => c.cmd)).toEqual(["pnpm", "pnpm"]);
      expect(capturedCalls().map((c) => c.args)).toEqual([
        ["run", "typecheck"],
        ["run", "test"],
      ]);
    } finally {
      dispose();
    }
  });

  it("uses yarn run <script> when only yarn.lock is present", () => {
    const { root, dispose } = makeFixture({
      packageJson: { scripts: { typecheck: "true", test: "true" } },
      files: ["yarn.lock"],
    });
    try {
      runVerification(root, undefined);
      expect(capturedCalls()).toEqual([
        { cmd: "yarn", args: ["run", "typecheck"] },
        { cmd: "yarn", args: ["run", "test"] },
      ]);
    } finally {
      dispose();
    }
  });

  it("uses bun run <script> when only bun.lock is present", () => {
    const { root, dispose } = makeFixture({
      packageJson: { scripts: { typecheck: "true", test: "true" } },
      files: ["bun.lock"],
    });
    try {
      runVerification(root, undefined);
      expect(capturedCalls()).toEqual([
        { cmd: "bun", args: ["run", "typecheck"] },
        { cmd: "bun", args: ["run", "test"] },
      ]);
    } finally {
      dispose();
    }
  });

  it("uses npm run <script> when only package-lock.json is present", () => {
    const { root, dispose } = makeFixture({
      packageJson: { scripts: { typecheck: "true", test: "true" } },
      files: ["package-lock.json"],
    });
    try {
      runVerification(root, undefined);
      expect(capturedCalls()).toEqual([
        { cmd: "npm", args: ["run", "typecheck"] },
        { cmd: "npm", args: ["run", "test"] },
      ]);
    } finally {
      dispose();
    }
  });

  it("falls back to pnpm when no detection signals are present (no packageManager, no lockfile)", () => {
    const { root, dispose } = makeFixture({
      packageJson: { scripts: { typecheck: "true", test: "true" } },
    });
    try {
      runVerification(root, undefined);
      expect(capturedCalls()).toEqual([
        { cmd: "pnpm", args: ["run", "typecheck"] },
        { cmd: "pnpm", args: ["run", "test"] },
      ]);
    } finally {
      dispose();
    }
  });
});

describe("sf_team_task runVerification: existing-behavior preservation", () => {
  it("passes through an explicit verifyCommand without invoking package-manager detection", () => {
    const { root, dispose } = makeFixture({
      // Repo claims pnpm; the explicit verifyCommand should win and the resolved
      // cmd should be the caller's choice ("node"), not a pnpm-derived one.
      packageJson: { packageManager: "pnpm@9.0.0" },
      files: ["pnpm-lock.yaml"],
    });
    try {
      runVerification(root, { cmd: "node", args: ["-e", "process.exit(0)"] });
      expect(capturedCalls()).toEqual([{ cmd: "node", args: ["-e", "process.exit(0)"] }]);
    } finally {
      dispose();
    }
  });

  it("skips entirely when verifyCommand === false (no spawn)", () => {
    const { root, dispose } = makeFixture({ packageJson: {}, files: ["pnpm-lock.yaml"] });
    try {
      runVerification(root, false);
      expect(spawnSyncMock).not.toHaveBeenCalled();
    } finally {
      dispose();
    }
  });

  it("skips typecheck stage with a console notice when only the test script is present", () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { root, dispose } = makeFixture({
      packageJson: { packageManager: "npm@10.2.0", scripts: { test: "true" } },
    });
    try {
      runVerification(root, undefined);
      expect(capturedCalls()).toEqual([{ cmd: "npm", args: ["run", "test"] }]);
      expect(errSpy).toHaveBeenCalledTimes(1);
      expect(errSpy.mock.calls[0]?.[0]).toBe(
        `sf_team_task: verification gate skipped — no \`typecheck\` script in ${root}/package.json.`,
      );
    } finally {
      errSpy.mockRestore();
      dispose();
    }
  });

  it("skips test stage with a console notice when only the typecheck script is present", () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { root, dispose } = makeFixture({
      packageJson: { packageManager: "npm@10.2.0", scripts: { typecheck: "true" } },
    });
    try {
      runVerification(root, undefined);
      expect(capturedCalls()).toEqual([{ cmd: "npm", args: ["run", "typecheck"] }]);
      expect(errSpy).toHaveBeenCalledTimes(1);
      expect(errSpy.mock.calls[0]?.[0]).toBe(
        `sf_team_task: verification gate skipped — no \`test\` script in ${root}/package.json.`,
      );
    } finally {
      errSpy.mockRestore();
      dispose();
    }
  });

  it("emits two skip notices and never spawns when both default scripts are missing", () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { root, dispose } = makeFixture({
      packageJson: { packageManager: "npm@10.2.0", scripts: {} },
    });
    try {
      runVerification(root, undefined);
      expect(spawnSyncMock).not.toHaveBeenCalled();
      expect(errSpy).toHaveBeenCalledTimes(2);
      expect(errSpy.mock.calls[0]?.[0]).toMatch(/no `typecheck` script/);
      expect(errSpy.mock.calls[1]?.[0]).toMatch(/no `test` script/);
    } finally {
      errSpy.mockRestore();
      dispose();
    }
  });

  it("emits two skip notices when package.json is missing entirely (ENOENT)", () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { root, dispose } = makeFixture({ packageJson: undefined });
    try {
      runVerification(root, undefined);
      expect(spawnSyncMock).not.toHaveBeenCalled();
      expect(errSpy).toHaveBeenCalledTimes(2);
    } finally {
      errSpy.mockRestore();
      dispose();
    }
  });

  it("throws with sf_team_task prefix (NOT sf_team_implement) on malformed package.json", () => {
    const root = mkdtempSync(path.join(tmpdir(), "task-verify-gate-malformed-"));
    writeFileSync(path.join(root, "package.json"), "{ this is not json");
    try {
      let thrown: Error | null = null;
      try {
        runVerification(root, undefined);
      } catch (e) {
        thrown = e instanceof Error ? e : new Error(String(e));
      }
      expect(thrown).not.toBeNull();
      expect(thrown!.message).toMatch(/^sf_team_task: /);
      expect(thrown!.message).toContain("is not valid JSON");
      expect(thrown!.message).not.toContain("sf_team_implement");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("throws on non-zero exit with the resolved cmd, args, cwd, exit status, and stderr/stdout snippet", () => {
    const { root, dispose } = makeFixture({
      packageJson: { packageManager: "npm@10.2.0", scripts: { typecheck: "true", test: "true" } },
    });
    try {
      spawnSyncMock.mockReturnValue({ status: 7, stdout: "boom-out", stderr: "boom-err" });
      let thrown: Error | null = null;
      try {
        runVerification(root, undefined);
      } catch (e) {
        thrown = e instanceof Error ? e : new Error(String(e));
      }
      expect(thrown).not.toBeNull();
      const msg = thrown!.message;
      expect(msg).toMatch(/^sf_team_task: verification gate failed \(/);
      expect(msg).toContain("npm");
      expect(msg).toContain("run typecheck");
      expect(msg).toContain(root);
      expect(msg).toContain("exited 7");
      expect(msg).toContain("boom-err");
      expect(msg).toContain("boom-out");
    } finally {
      dispose();
    }
  });
});
