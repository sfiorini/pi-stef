import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const spawnSyncMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawnSync: spawnSyncMock };
});

const { installDependenciesIfMissing } = await import("../src/worktree/install-deps");
const { WorktreeCreationError } = await import("../src/worktree/errors");

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
  withNodeModules?: boolean;
}): { root: string; dispose: () => void } {
  const root = mkdtempSync(path.join(tmpdir(), "install-deps-"));
  if (opts.packageJson !== undefined) {
    writeFileSync(path.join(root, "package.json"), JSON.stringify(opts.packageJson, null, 2));
  }
  for (const f of opts.files ?? []) {
    writeFileSync(path.join(root, f), "");
  }
  if (opts.withNodeModules) {
    mkdirSync(path.join(root, "node_modules"));
  }
  return { root, dispose: () => rmSync(root, { recursive: true, force: true }) };
}

beforeEach(() => {
  spawnSyncMock.mockReset();
  spawnSyncMock.mockReturnValue({ status: 0, stdout: "", stderr: "", error: undefined, signal: null });
  delete process.env.SF_TEAM_SKIP_AUTO_INSTALL;
});

afterEach(() => {
  spawnSyncMock.mockReset();
  delete process.env.SF_TEAM_SKIP_AUTO_INSTALL;
});

describe("installDependenciesIfMissing — H.2: no package.json skips silently", () => {
  it("returns no_package_json with NO console.error when package.json is absent", () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { root, dispose } = makeFixture({}); // no package.json
    try {
      const result = installDependenciesIfMissing(root);
      expect(result).toEqual({ kind: "skipped", reason: "no_package_json" });
      expect(spawnSyncMock).not.toHaveBeenCalled();
      expect(errSpy).not.toHaveBeenCalled();
    } finally {
      errSpy.mockRestore();
      dispose();
    }
  });
});

describe("installDependenciesIfMissing — H.3: existing node_modules skips with log", () => {
  it("returns node_modules_present and logs once when node_modules already exists", () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { root, dispose } = makeFixture({
      packageJson: { packageManager: "npm@10.2.0" },
      withNodeModules: true,
    });
    try {
      const result = installDependenciesIfMissing(root);
      expect(result).toEqual({ kind: "skipped", reason: "node_modules_present" });
      expect(spawnSyncMock).not.toHaveBeenCalled();
      expect(errSpy).toHaveBeenCalledTimes(1);
      expect(String(errSpy.mock.calls[0]?.[0])).toContain(root);
    } finally {
      errSpy.mockRestore();
      dispose();
    }
  });

  it("uses the reporter instead of console.error when one is provided", () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const reporter = {
      message: vi.fn(),
      clearMessage: vi.fn(),
      dispose: vi.fn(),
    };
    const { root, dispose } = makeFixture({
      packageJson: { packageManager: "npm@10.2.0" },
      withNodeModules: true,
    });
    try {
      const result = installDependenciesIfMissing(root, reporter);
      expect(result).toEqual({ kind: "skipped", reason: "node_modules_present" });
      expect(reporter.message).toHaveBeenCalledWith(
        expect.stringContaining("dependencies already present"),
        expect.objectContaining({ level: "info" }),
      );
      expect(errSpy).not.toHaveBeenCalled();
    } finally {
      errSpy.mockRestore();
      dispose();
    }
  });
});

describe("installDependenciesIfMissing — H.4: install runs with detected PM (npm via packageManager field)", () => {
  it("calls spawnSync('npm', ['install']) with maxBuffer and returns installed pm=npm on success", () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { root, dispose } = makeFixture({
      packageJson: { packageManager: "npm@10.2.0" },
    });
    try {
      const result = installDependenciesIfMissing(root);
      expect(result).toEqual({ kind: "installed", pm: "npm" });
      expect(spawnSyncMock).toHaveBeenCalledTimes(1);
      const [cmd, args, opts] = spawnSyncMock.mock.calls[0]!;
      expect(cmd).toBe("npm");
      expect(args).toEqual(["install"]);
      expect(opts).toMatchObject({ cwd: root, encoding: "utf8" });
      expect((opts as { maxBuffer?: number }).maxBuffer).toBeGreaterThanOrEqual(50 * 1024 * 1024);
      expect(errSpy).toHaveBeenCalledTimes(1);
      expect(String(errSpy.mock.calls[0]?.[0])).toContain("installing dependencies via npm install");
      expect(String(errSpy.mock.calls[0]?.[0])).toContain(root);
    } finally {
      errSpy.mockRestore();
      dispose();
    }
  });
});

describe("installDependenciesIfMissing — H.5: non-zero exit throws WorktreeCreationError(install)", () => {
  it("includes the cmd, args, exit status, and truncated stderr in the message", () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    spawnSyncMock.mockReturnValue({ status: 1, stdout: "", stderr: "boom-err", error: undefined, signal: null });
    const { root, dispose } = makeFixture({
      packageJson: { packageManager: "npm@10.2.0" },
    });
    try {
      let thrown: unknown = null;
      try {
        installDependenciesIfMissing(root);
      } catch (e) {
        thrown = e;
      }
      expect(thrown).toBeInstanceOf(WorktreeCreationError);
      const err = thrown as InstanceType<typeof WorktreeCreationError>;
      expect(err.stage).toBe("install");
      expect(err.message).toMatch(/^sf_team: npm install exited 1/);
      expect(err.message).toContain("boom-err");
    } finally {
      errSpy.mockRestore();
      dispose();
    }
  });

  it("truncates stderr to 2 KB", () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const longErr = "x".repeat(4096);
    spawnSyncMock.mockReturnValue({ status: 2, stdout: "", stderr: longErr, error: undefined, signal: null });
    const { root, dispose } = makeFixture({
      packageJson: { packageManager: "npm@10.2.0" },
    });
    try {
      let thrown: unknown = null;
      try {
        installDependenciesIfMissing(root);
      } catch (e) {
        thrown = e;
      }
      expect(thrown).toBeInstanceOf(WorktreeCreationError);
      const err = thrown as InstanceType<typeof WorktreeCreationError>;
      // Should contain ~2 KB of x's, NOT the full 4 KB. Allow a small margin
      // around the 2048-byte target since the exact slice length is an
      // implementation detail; the contract is "truncated, not full input".
      const xCount = (err.message.match(/x/g) ?? []).length;
      expect(xCount).toBeLessThanOrEqual(2100);
      expect(xCount).toBeGreaterThanOrEqual(2000);
      // Strong invariant: the full 4096 input did NOT survive.
      expect(xCount).toBeLessThan(4096);
    } finally {
      errSpy.mockRestore();
      dispose();
    }
  });
});

describe("installDependenciesIfMissing — H.6: signal interruption throws with signal info", () => {
  it("throws when r.status === null and r.signal is set", () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    spawnSyncMock.mockReturnValue({ status: null, stdout: "", stderr: "", error: undefined, signal: "SIGINT" });
    const { root, dispose } = makeFixture({
      packageJson: { packageManager: "npm@10.2.0" },
    });
    try {
      let thrown: unknown = null;
      try {
        installDependenciesIfMissing(root);
      } catch (e) {
        thrown = e;
      }
      expect(thrown).toBeInstanceOf(WorktreeCreationError);
      const err = thrown as InstanceType<typeof WorktreeCreationError>;
      expect(err.stage).toBe("install");
      expect(err.message).toContain("interrupted");
      expect(err.message).toContain("SIGINT");
    } finally {
      errSpy.mockRestore();
      dispose();
    }
  });
});

describe("installDependenciesIfMissing — H.7: spawn failure (PM binary not found) throws with corepack hint", () => {
  it("throws with hint when r.error is ENOENT", () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const enoent = Object.assign(new Error("spawn npm ENOENT"), { code: "ENOENT" });
    spawnSyncMock.mockReturnValue({ status: null, stdout: "", stderr: "", error: enoent, signal: null });
    const { root, dispose } = makeFixture({
      packageJson: { packageManager: "npm@10.2.0" },
    });
    try {
      let thrown: unknown = null;
      try {
        installDependenciesIfMissing(root);
      } catch (e) {
        thrown = e;
      }
      expect(thrown).toBeInstanceOf(WorktreeCreationError);
      const err = thrown as InstanceType<typeof WorktreeCreationError>;
      expect(err.stage).toBe("install");
      expect(err.message).toMatch(/^sf_team: failed to spawn npm install/);
      expect(err.message).toContain("corepack");
    } finally {
      errSpy.mockRestore();
      dispose();
    }
  });
});

describe("installDependenciesIfMissing — H.8/H.9: per-PM lockfile coverage", () => {
  it("H.8: pnpm-lock.yaml only → spawnSync('pnpm', ['install'])", () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { root, dispose } = makeFixture({ packageJson: {}, files: ["pnpm-lock.yaml"] });
    try {
      const result = installDependenciesIfMissing(root);
      expect(result).toEqual({ kind: "installed", pm: "pnpm" });
      expect(spawnSyncMock.mock.calls[0]?.[0]).toBe("pnpm");
      expect(spawnSyncMock.mock.calls[0]?.[1]).toEqual(["install"]);
    } finally {
      errSpy.mockRestore();
      dispose();
    }
  });

  it("H.9: yarn.lock only → spawnSync('yarn', ['install'])", () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { root, dispose } = makeFixture({ packageJson: {}, files: ["yarn.lock"] });
    try {
      const result = installDependenciesIfMissing(root);
      expect(result).toEqual({ kind: "installed", pm: "yarn" });
      expect(spawnSyncMock.mock.calls[0]?.[0]).toBe("yarn");
      expect(spawnSyncMock.mock.calls[0]?.[1]).toEqual(["install"]);
    } finally {
      errSpy.mockRestore();
      dispose();
    }
  });
});

describe("installDependenciesIfMissing — H.1: SF_TEAM_SKIP_AUTO_INSTALL opt-out", () => {
  const truthy = ["1", "true", "yes", "on", "TRUE", " 1 "];
  for (const v of truthy) {
    it(`skips with reason 'opted_out' when SF_TEAM_SKIP_AUTO_INSTALL=${JSON.stringify(v)}`, () => {
      process.env.SF_TEAM_SKIP_AUTO_INSTALL = v;
      const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
      const { root, dispose } = makeFixture({
        packageJson: { packageManager: "npm@10.2.0" },
        files: ["package-lock.json"],
      });
      try {
        const result = installDependenciesIfMissing(root);
        expect(result).toEqual({ kind: "skipped", reason: "opted_out" });
        expect(spawnSyncMock).not.toHaveBeenCalled();
        expect(errSpy).toHaveBeenCalledTimes(1);
        expect(String(errSpy.mock.calls[0]?.[0])).toContain("SF_TEAM_SKIP_AUTO_INSTALL");
      } finally {
        errSpy.mockRestore();
        dispose();
      }
    });
  }

  const falsey = ["0", "false", "no", "off", "", "anything-else"];
  for (const v of falsey) {
    it(`does NOT short-circuit on opt-out when SF_TEAM_SKIP_AUTO_INSTALL=${JSON.stringify(v)} (falls through to no_package_json)`, () => {
      process.env.SF_TEAM_SKIP_AUTO_INSTALL = v;
      const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
      const { root, dispose } = makeFixture({}); // no package.json
      try {
        const result = installDependenciesIfMissing(root);
        expect(result).toEqual({ kind: "skipped", reason: "no_package_json" });
        expect(spawnSyncMock).not.toHaveBeenCalled();
      } finally {
        errSpy.mockRestore();
        dispose();
      }
    });
  }
});
