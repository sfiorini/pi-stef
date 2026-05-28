import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { detectPackageManager, runVerification } from "../src/tools/implement";

function makeRepo(scripts: Record<string, string> | undefined): { root: string; dispose: () => void } {
  const root = mkdtempSync(path.join(tmpdir(), "verify-gate-"));
  if (scripts !== undefined) {
    writeFileSync(
      path.join(root, "package.json"),
      JSON.stringify({ name: "fixture", scripts }, null, 2),
    );
  }
  return { root, dispose: () => rmSync(root, { recursive: true, force: true }) };
}

describe("runVerification: skips missing default pnpm scripts (don't fail when script doesn't exist)", () => {
  let errSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
  });
  afterEach(() => {
    errSpy.mockRestore();
  });

  it("no-ops silently when package.json is missing entirely", () => {
    const { root, dispose } = makeRepo(undefined);
    try {
      // Two skip notices: typecheck + test
      expect(() => runVerification(root, undefined)).not.toThrow();
      expect(errSpy).toHaveBeenCalledTimes(2);
      expect(errSpy.mock.calls[0][0]).toMatch(/skipped — no `typecheck` script/);
      expect(errSpy.mock.calls[1][0]).toMatch(/skipped — no `test` script/);
    } finally {
      dispose();
    }
  });

  it("no-ops silently when package.json has no `scripts` field", () => {
    const { root, dispose } = makeRepo({});
    try {
      expect(() => runVerification(root, undefined)).not.toThrow();
      expect(errSpy).toHaveBeenCalledTimes(2);
    } finally {
      dispose();
    }
  });

  it("skips only the missing script and runs the present one (typecheck only)", () => {
    // package.json defines typecheck but NOT test → only typecheck runs.
    const { root, dispose } = makeRepo({ typecheck: "node -e \"process.exit(0)\"" });
    try {
      expect(() => runVerification(root, undefined)).not.toThrow();
      // One skip notice for the missing `test` script.
      expect(errSpy).toHaveBeenCalledTimes(1);
      expect(errSpy.mock.calls[0][0]).toMatch(/skipped — no `test` script/);
    } finally {
      dispose();
    }
  });

  it("explicit verifyCommand bypasses the package.json probe (always runs)", () => {
    // No package.json at all, but verifyCommand is provided → should run it.
    const { root, dispose } = makeRepo(undefined);
    try {
      expect(() =>
        runVerification(root, { cmd: process.execPath, args: ["-e", "process.exit(0)"] }),
      ).not.toThrow();
      expect(errSpy).not.toHaveBeenCalled();
    } finally {
      dispose();
    }
  });

  it("explicit verifyCommand still fails on non-zero exit", () => {
    const { root, dispose } = makeRepo(undefined);
    try {
      expect(() =>
        runVerification(root, { cmd: process.execPath, args: ["-e", "process.exit(7)"] }),
      ).toThrow(/verification gate failed.*exited 7/);
    } finally {
      dispose();
    }
  });

  it("explicit verifyCommand failure includes cwd and command output for diagnostics", () => {
    const { root, dispose } = makeRepo(undefined);
    try {
      let thrown: Error | null = null;
      try {
        runVerification(root, {
          cmd: process.execPath,
          args: ["-e", "console.error('impl stderr marker'); console.log('impl stdout marker'); process.exit(7)"],
        });
      } catch (e) {
        thrown = e instanceof Error ? e : new Error(String(e));
      }
      expect(thrown).not.toBeNull();
      expect(thrown!.message).toContain(root);
      expect(thrown!.message).toContain("impl stderr marker");
      expect(thrown!.message).toContain("impl stdout marker");
    } finally {
      dispose();
    }
  });

  it("verifyCommand=false short-circuits everything", () => {
    const { root, dispose } = makeRepo(undefined);
    try {
      expect(() => runVerification(root, false)).not.toThrow();
      expect(errSpy).not.toHaveBeenCalled();
    } finally {
      dispose();
    }
  });

  it("present default script that fails still throws (regression guard)", () => {
    const { root, dispose } = makeRepo({ typecheck: "node -e \"process.exit(3)\"" });
    try {
      // Form is now `<pm> run <script>` (uniform across pm); no lockfile in
      // the tmp repo so detection falls through to the default `pnpm`.
      expect(() => runVerification(root, undefined)).toThrow(
        /verification gate failed.*pnpm run typecheck.*exited 3/,
      );
    } finally {
      dispose();
    }
  });

  it("malformed package.json THROWS — broken manifest must not silently skip the gate", () => {
    const root = mkdtempSync(path.join(tmpdir(), "verify-gate-bad-"));
    try {
      writeFileSync(path.join(root, "package.json"), "{ this is not json");
      expect(() => runVerification(root, undefined)).toThrow(
        /not valid JSON.*refusing to skip the verification gate/,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("test-only: only the present default runs (test, not typecheck)", () => {
    const { root, dispose } = makeRepo({ test: "node -e \"process.exit(0)\"" });
    try {
      expect(() => runVerification(root, undefined)).not.toThrow();
      // One skip notice for the missing typecheck script.
      expect(errSpy).toHaveBeenCalledTimes(1);
      expect(errSpy.mock.calls[0][0]).toMatch(/skipped — no `typecheck` script/);
    } finally {
      dispose();
    }
  });

  it("both default scripts present and passing: no skip notices, no throw", () => {
    const { root, dispose } = makeRepo({
      typecheck: "node -e \"process.exit(0)\"",
      test: "node -e \"process.exit(0)\"",
    });
    try {
      expect(() => runVerification(root, undefined)).not.toThrow();
      expect(errSpy).not.toHaveBeenCalled();
    } finally {
      dispose();
    }
  });

  it("scripts is non-object (e.g. array) is tolerated as 'no scripts'", () => {
    // Valid JSON with an unusual `scripts` shape — manifest itself isn't broken
    // (parses), so we don't throw; we just treat it as "no scripts available".
    const root = mkdtempSync(path.join(tmpdir(), "verify-gate-arr-"));
    try {
      writeFileSync(
        path.join(root, "package.json"),
        JSON.stringify({ name: "x", scripts: ["typecheck", "test"] }),
      );
      expect(() => runVerification(root, undefined)).not.toThrow();
      expect(errSpy).toHaveBeenCalledTimes(2);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("detectPackageManager", () => {
  // The previous sf-team verification gate hardcoded `pnpm typecheck` /
  // `pnpm test`. Repos with npm-flavored layouts (root `workspaces`
  // field, package-lock.json) failed the gate even when the project
  // was healthy because pnpm couldn't resolve workspace deps. This
  // detector picks the right pm from the worktree itself.

  function tmpRepo(files: Record<string, string>): { root: string; dispose: () => void } {
    const root = mkdtempSync(path.join(tmpdir(), "pm-detect-"));
    for (const [rel, body] of Object.entries(files)) {
      writeFileSync(path.join(root, rel), body);
    }
    return { root, dispose: () => rmSync(root, { recursive: true, force: true }) };
  }

  it("default to pnpm when no lockfile and no packageManager field is present (preserves prior behavior)", () => {
    const { root, dispose } = tmpRepo({});
    try {
      expect(detectPackageManager(root)).toBe("pnpm");
    } finally {
      dispose();
    }
  });

  it("default to pnpm when package.json has no packageManager field and no lockfile", () => {
    const { root, dispose } = tmpRepo({ "package.json": JSON.stringify({ name: "x" }) });
    try {
      expect(detectPackageManager(root)).toBe("pnpm");
    } finally {
      dispose();
    }
  });

  it("pnpm-lock.yaml → pnpm", () => {
    const { root, dispose } = tmpRepo({ "pnpm-lock.yaml": "lockfileVersion: '6.0'\n" });
    try {
      expect(detectPackageManager(root)).toBe("pnpm");
    } finally {
      dispose();
    }
  });

  it("yarn.lock → yarn", () => {
    const { root, dispose } = tmpRepo({ "yarn.lock": "# yarn lockfile v1\n" });
    try {
      expect(detectPackageManager(root)).toBe("yarn");
    } finally {
      dispose();
    }
  });

  it("bun.lock (text, Bun ≥1.2 default since Jan 2025) → bun", () => {
    // The original PR shipped only bun.lockb detection. Bun 1.2 made
    // bun.lock (text) the default; bun-flavored projects created since
    // Jan 2025 do NOT have bun.lockb, only bun.lock. Without this case
    // they'd fall through to the pnpm default and re-introduce the bug
    // we're fixing.
    const { root, dispose } = tmpRepo({ "bun.lock": "# bun lockfile\n" });
    try {
      expect(detectPackageManager(root)).toBe("bun");
    } finally {
      dispose();
    }
  });

  it("bun.lockb (legacy binary lockfile, Bun ≤1.1) → bun", () => {
    const { root, dispose } = tmpRepo({ "bun.lockb": "" });
    try {
      expect(detectPackageManager(root)).toBe("bun");
    } finally {
      dispose();
    }
  });

  it("when both bun lockfiles coexist (mid-upgrade repo) → bun", () => {
    const { root, dispose } = tmpRepo({ "bun.lock": "x", "bun.lockb": "" });
    try {
      expect(detectPackageManager(root)).toBe("bun");
    } finally {
      dispose();
    }
  });

  it("package-lock.json → npm (the original sf-team bug — npm-flavored repos hit the verification gate)", () => {
    const { root, dispose } = tmpRepo({ "package-lock.json": '{"lockfileVersion":3}' });
    try {
      expect(detectPackageManager(root)).toBe("npm");
    } finally {
      dispose();
    }
  });

  it("package.json#workspaces (npm-style array) with NO lockfile → npm", () => {
    // Live failure 2026-05-08: a weather-app project with
    // `"workspaces": ["shared", "server", "client"]` and no committed
    // lockfile fell through to the pnpm default. pnpm install warns
    // about the unsupported `workspaces` field, installs only root
    // deps, leaves workspace `node_modules` empty, and the verification
    // gate blows up with `vitest: command not found` (exit 127). pnpm
    // declares its own workspaces via pnpm-workspace.yaml, so the
    // package.json `workspaces` field is a strong npm/yarn signal.
    const { root, dispose } = tmpRepo({
      "package.json": JSON.stringify({ name: "weather-app", workspaces: ["shared", "server", "client"] }),
    });
    try {
      expect(detectPackageManager(root)).toBe("npm");
    } finally {
      dispose();
    }
  });

  it("package.json#workspaces (object form, npm 7+ extension) with NO lockfile → npm", () => {
    // npm 7+ also supports `workspaces: { packages: [...] }` for parity
    // with yarn classic. Same signal — pnpm doesn't use it.
    const { root, dispose } = tmpRepo({
      "package.json": JSON.stringify({ name: "x", workspaces: { packages: ["packages/*"] } }),
    });
    try {
      expect(detectPackageManager(root)).toBe("npm");
    } finally {
      dispose();
    }
  });

  it("pnpm-workspace.yaml present → pnpm (even with no lockfile)", () => {
    // pnpm uses this file to declare workspaces; presence is a strong
    // pnpm-only signal that should beat the workspaces-→-npm fallback.
    const { root, dispose } = tmpRepo({
      "package.json": JSON.stringify({ name: "x" }),
      "pnpm-workspace.yaml": "packages:\n  - 'packages/*'\n",
    });
    try {
      expect(detectPackageManager(root)).toBe("pnpm");
    } finally {
      dispose();
    }
  });

  it("pnpm-workspace.yaml beats package.json#workspaces (mixed-config repo)", () => {
    // Defensive: a repo that has BOTH (perhaps mid-migration) should
    // resolve to pnpm. Without this rule, the workspaces-→-npm
    // fallback would hijack a pnpm project.
    const { root, dispose } = tmpRepo({
      "package.json": JSON.stringify({ name: "x", workspaces: ["pkgs/*"] }),
      "pnpm-workspace.yaml": "packages:\n  - 'pkgs/*'\n",
    });
    try {
      expect(detectPackageManager(root)).toBe("pnpm");
    } finally {
      dispose();
    }
  });

  it("empty workspaces array does NOT trigger the npm fallback (no actual workspaces declared)", () => {
    const { root, dispose } = tmpRepo({
      "package.json": JSON.stringify({ name: "x", workspaces: [] }),
    });
    try {
      expect(detectPackageManager(root)).toBe("pnpm");
    } finally {
      dispose();
    }
  });

  it("packageManager: 'npm@10.2.0' (Corepack) overrides any lockfile presence", () => {
    // Author has explicitly declared npm via Corepack, even though a
    // pnpm-lock.yaml is present (could be a leftover). Trust the
    // declaration.
    const { root, dispose } = tmpRepo({
      "package.json": JSON.stringify({ name: "x", packageManager: "npm@10.2.0" }),
      "pnpm-lock.yaml": "lockfileVersion: '6.0'\n",
    });
    try {
      expect(detectPackageManager(root)).toBe("npm");
    } finally {
      dispose();
    }
  });

  it("packageManager: 'yarn@4.0.0' overrides lockfile", () => {
    const { root, dispose } = tmpRepo({
      "package.json": JSON.stringify({ name: "x", packageManager: "yarn@4.0.0" }),
      "package-lock.json": '{"lockfileVersion":3}',
    });
    try {
      expect(detectPackageManager(root)).toBe("yarn");
    } finally {
      dispose();
    }
  });

  it("packageManager: 'pnpm@9.0.0' is a no-op when lockfiles already match", () => {
    const { root, dispose } = tmpRepo({
      "package.json": JSON.stringify({ name: "x", packageManager: "pnpm@9.0.0" }),
      "pnpm-lock.yaml": "lockfileVersion: '6.0'\n",
    });
    try {
      expect(detectPackageManager(root)).toBe("pnpm");
    } finally {
      dispose();
    }
  });

  it("packageManager: 'bun@1.1.0' overrides lockfile", () => {
    const { root, dispose } = tmpRepo({
      "package.json": JSON.stringify({ name: "x", packageManager: "bun@1.1.0" }),
      "yarn.lock": "# yarn lockfile v1\n",
    });
    try {
      expect(detectPackageManager(root)).toBe("bun");
    } finally {
      dispose();
    }
  });

  it("malformed package.json falls through to lockfile detection without crashing", () => {
    // Detector swallows JSON parse errors so the verification gate isn't
    // doubly punished by a malformed manifest (packageScriptsAt is the
    // single source of truth for that escalation).
    const { root, dispose } = tmpRepo({
      "package.json": "{ this is not json",
      "package-lock.json": '{"lockfileVersion":3}',
    });
    try {
      expect(detectPackageManager(root)).toBe("npm");
    } finally {
      dispose();
    }
  });

  it("unknown packageManager prefix falls through to lockfile detection (forward-compat)", () => {
    // A future PM the detector doesn't know yet should not freeze
    // verification — we still detect via lockfile and pick the best
    // known PM available.
    const { root, dispose } = tmpRepo({
      "package.json": JSON.stringify({ name: "x", packageManager: "futurepm@2.0.0" }),
      "package-lock.json": '{"lockfileVersion":3}',
    });
    try {
      expect(detectPackageManager(root)).toBe("npm");
    } finally {
      dispose();
    }
  });

  it("priority order: pnpm-lock.yaml > yarn.lock > bun.lock > bun.lockb > package-lock.json", () => {
    // When ALL lockfiles coexist (multi-PM repo with no Corepack
    // packageManager field), the detector picks pnpm first to preserve
    // the prior default. Pinning the full chain ensures a future
    // contributor can't accidentally reorder without failing this test.
    const { root, dispose } = tmpRepo({
      "pnpm-lock.yaml": "x",
      "yarn.lock": "x",
      "bun.lock": "x",
      "bun.lockb": "x",
      "package-lock.json": "x",
    });
    try {
      expect(detectPackageManager(root)).toBe("pnpm");
    } finally {
      dispose();
    }
  });

  it("priority: yarn.lock + bun.lock + package-lock.json (no pnpm) → yarn", () => {
    const { root, dispose } = tmpRepo({
      "yarn.lock": "x",
      "bun.lock": "x",
      "package-lock.json": "x",
    });
    try {
      expect(detectPackageManager(root)).toBe("yarn");
    } finally {
      dispose();
    }
  });

  it("priority: bun.lock + package-lock.json (no pnpm/yarn) → bun", () => {
    const { root, dispose } = tmpRepo({
      "bun.lock": "x",
      "package-lock.json": "x",
    });
    try {
      expect(detectPackageManager(root)).toBe("bun");
    } finally {
      dispose();
    }
  });

  // --- Stale-pnpm-lock-in-an-npm-workspaces-repo guard ----------------------
  //
  // Live failure 2026-05-08: a followup run produced a worktree with BOTH
  // `pnpm-lock.yaml` (stale, written by an earlier sf-team run that ran
  // `pnpm install` against an npm-style project) AND `package-lock.json`,
  // alongside `package.json#workspaces: [...]` and NO `pnpm-workspace.yaml`.
  // The detector returned `pnpm` because pnpm-lock.yaml beat the workspaces
  // fallback. pnpm doesn't honor `package.json#workspaces`; it warns, leaves
  // workspace `node_modules` empty, and the verification gate fails with
  // `vitest: command not found`. Fix: when `package.json#workspaces` is
  // non-empty AND `pnpm-workspace.yaml` is absent, the `pnpm-lock.yaml`
  // step is treated as stale and we fall through to other lockfile checks
  // and the npm fallback.

  it("(a) red: pnpm-lock.yaml + package-lock.json + workspaces array, no pnpm-workspace.yaml → npm (stale pnpm-lock)", () => {
    // The exact live-failure shape. Without the gate, the existing detector
    // returns `pnpm` and the verification gate blows up downstream.
    const { root, dispose } = tmpRepo({
      "package.json": JSON.stringify({
        name: "weather-app",
        workspaces: ["shared", "server", "client"],
      }),
      "pnpm-lock.yaml": "lockfileVersion: '6.0'\n",
      "package-lock.json": '{"lockfileVersion":3}',
    });
    try {
      expect(detectPackageManager(root)).toBe("npm");
    } finally {
      dispose();
    }
  });

  it("(d) red: pnpm-lock.yaml + workspaces object form, no pnpm-workspace.yaml → npm", () => {
    // Same gate, but the workspaces field is in the npm 7+ object form.
    const { root, dispose } = tmpRepo({
      "package.json": JSON.stringify({
        name: "x",
        workspaces: { packages: ["packages/*"] },
      }),
      "pnpm-lock.yaml": "lockfileVersion: '6.0'\n",
    });
    try {
      expect(detectPackageManager(root)).toBe("npm");
    } finally {
      dispose();
    }
  });

  it("(b) regression pin: pnpm-workspace.yaml beats the workspaces-stale-lock gate (declared pnpm wins)", () => {
    // Defensive: even if a misconfigured pnpm repo also sets the npm-style
    // `workspaces` field, the canonical pnpm-workspace.yaml declaration must
    // still win. This already passes today (priority 2 short-circuit).
    const { root, dispose } = tmpRepo({
      "package.json": JSON.stringify({ name: "x", workspaces: ["a"] }),
      "pnpm-workspace.yaml": "packages:\n  - 'a'\n",
      "pnpm-lock.yaml": "lockfileVersion: '6.0'\n",
    });
    try {
      expect(detectPackageManager(root)).toBe("pnpm");
    } finally {
      dispose();
    }
  });

  it("(c) regression pin: yarn.lock + workspaces array, no pnpm-workspace.yaml → yarn (yarn honors workspaces natively)", () => {
    // yarn classic and yarn 4 both legitimately use `package.json#workspaces`
    // alongside yarn.lock. The gate must NOT misclassify this as npm.
    const { root, dispose } = tmpRepo({
      "package.json": JSON.stringify({ name: "x", workspaces: ["pkgs/*"] }),
      "yarn.lock": "# yarn lockfile v1\n",
    });
    try {
      expect(detectPackageManager(root)).toBe("yarn");
    } finally {
      dispose();
    }
  });

  it("(e) regression pin: bun.lock + workspaces array, no pnpm-workspace.yaml → bun (bun honors workspaces natively)", () => {
    // bun also natively honors `package.json#workspaces`. Same guard as (c).
    const { root, dispose } = tmpRepo({
      "package.json": JSON.stringify({ name: "x", workspaces: ["pkgs/*"] }),
      "bun.lock": "# bun lockfile\n",
    });
    try {
      expect(detectPackageManager(root)).toBe("bun");
    } finally {
      dispose();
    }
  });
});
