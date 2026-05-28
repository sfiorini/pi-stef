import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { fingerprintVerificationInputs } from "../src/verification/fingerprint";

function makeRepo(): { root: string; dispose: () => void } {
  const root = mkdtempSync(path.join(tmpdir(), "workflow-verification-fp-"));
  spawnSync("git", ["init", "-q", "-b", "main"], { cwd: root });
  spawnSync("git", ["config", "user.email", "a@b"], { cwd: root });
  spawnSync("git", ["config", "user.name", "tester"], { cwd: root });
  writeFileSync(path.join(root, "package.json"), JSON.stringify({ scripts: { test: "node test.js" } }, null, 2));
  writeFileSync(path.join(root, "test.js"), "process.exit(0)\n");
  spawnSync("git", ["add", "."], { cwd: root });
  spawnSync("git", ["commit", "-q", "-m", "init"], { cwd: root });
  return { root, dispose: () => rmSync(root, { recursive: true, force: true }) };
}

describe("verification fingerprinting", () => {
  it("changes when command inputs or staged source changes change", () => {
    const { root, dispose } = makeRepo();
    try {
      const base = fingerprintVerificationInputs({
        cwd: root,
        toolName: "sf_team_task",
        phase: "after",
        commands: [{ label: "test", cmd: "pnpm", args: ["run", "test"] }],
      });
      const commandChanged = fingerprintVerificationInputs({
        cwd: root,
        toolName: "sf_team_task",
        phase: "after",
        commands: [{ label: "typecheck", cmd: "pnpm", args: ["run", "typecheck"] }],
      });
      expect(commandChanged).not.toBe(base);

      writeFileSync(path.join(root, "test.js"), "process.exit(1)\n");
      spawnSync("git", ["add", "test.js"], { cwd: root });
      const stagedChanged = fingerprintVerificationInputs({
        cwd: root,
        toolName: "sf_team_task",
        phase: "after",
        commands: [{ label: "test", cmd: "pnpm", args: ["run", "test"] }],
      });
      expect(stagedChanged).not.toBe(base);
    } finally {
      dispose();
    }
  });

  it("includes package-manager lock and install-state files when present", () => {
    const { root, dispose } = makeRepo();
    try {
      const before = fingerprintVerificationInputs({
        cwd: root,
        toolName: "sf_team_implement",
        phase: "after",
        commands: [{ label: "test", cmd: "pnpm", args: ["run", "test"] }],
      });
      writeFileSync(path.join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
      mkdirSync(path.join(root, "node_modules"), { recursive: true });
      writeFileSync(path.join(root, "node_modules", ".modules.yaml"), "layoutVersion: 5\n");
      const after = fingerprintVerificationInputs({
        cwd: root,
        toolName: "sf_team_implement",
        phase: "after",
        commands: [{ label: "test", cmd: "pnpm", args: ["run", "test"] }],
      });
      expect(after).not.toBe(before);
    } finally {
      dispose();
    }
  });

  it("changes when untracked file contents change", () => {
    const { root, dispose } = makeRepo();
    try {
      writeFileSync(path.join(root, "generated.txt"), "first\n");
      const before = fingerprintVerificationInputs({
        cwd: root,
        toolName: "sf_team_task",
        phase: "after",
        commands: [{ label: "test", cmd: "pnpm", args: ["run", "test"] }],
      });
      writeFileSync(path.join(root, "generated.txt"), "second\n");
      const after = fingerprintVerificationInputs({
        cwd: root,
        toolName: "sf_team_task",
        phase: "after",
        commands: [{ label: "test", cmd: "pnpm", args: ["run", "test"] }],
      });
      expect(after).not.toBe(before);
    } finally {
      dispose();
    }
  });
});
