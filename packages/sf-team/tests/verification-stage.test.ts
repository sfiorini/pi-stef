import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { runVerificationStage } from "../src/tools/verification-stage";

function tempCwd(): { root: string; dispose: () => void } {
  const root = mkdtempSync(path.join(tmpdir(), "verification-stage-"));
  return { root, dispose: () => rmSync(root, { recursive: true, force: true }) };
}

describe("runVerificationStage", () => {
  it("reports spawn failures with cwd and spawn-error wording", () => {
    const { root, dispose } = tempCwd();
    try {
      let thrown: Error | null = null;
      try {
        runVerificationStage("sf_team_test", root, {
          cmd: "definitely-not-a-real-sf-team-command",
          args: [],
        });
      } catch (e) {
        thrown = e instanceof Error ? e : new Error(String(e));
      }

      expect(thrown).not.toBeNull();
      expect(thrown!.message).toContain("sf_team_test: verification gate failed");
      expect(thrown!.message).toContain("spawn error");
      expect(thrown!.message).toContain(root);
      expect(thrown!.message).toContain("spawn error:");
    } finally {
      dispose();
    }
  });

  it("reports signal termination distinctly from non-zero exits", () => {
    const { root, dispose } = tempCwd();
    try {
      let thrown: Error | null = null;
      try {
        runVerificationStage("sf_team_test", root, {
          cmd: process.execPath,
          args: ["-e", "process.kill(process.pid, 'SIGTERM')"],
        }, { maxAttempts: 1 });
      } catch (e) {
        thrown = e instanceof Error ? e : new Error(String(e));
      }

      expect(thrown).not.toBeNull();
      expect(thrown!.message).toContain("signal SIGTERM");
      expect(thrown!.message).toContain(root);
    } finally {
      dispose();
    }
  });

  it("keeps only the tail of very large stdout and stderr snippets", () => {
    const { root, dispose } = tempCwd();
    try {
      let thrown: Error | null = null;
      try {
        runVerificationStage("sf_team_test", root, {
          cmd: process.execPath,
          args: [
            "-e",
            [
              "const errStart = String.fromCharCode(69, 82, 82, 95, 83, 84, 65, 82, 84)",
              "const outStart = String.fromCharCode(79, 85, 84, 95, 83, 84, 65, 82, 84)",
              "console.error(errStart + 'x'.repeat(4100) + 'ERR_TAIL')",
              "console.log(outStart + 'y'.repeat(4100) + 'OUT_TAIL')",
              "process.exit(7)",
            ].join(";"),
          ],
        }, { maxAttempts: 1 });
      } catch (e) {
        thrown = e instanceof Error ? e : new Error(String(e));
      }

      expect(thrown).not.toBeNull();
      expect(thrown!.message).toContain("[truncated to last 4000 chars]");
      expect(thrown!.message).toContain("ERR_TAIL");
      expect(thrown!.message).toContain("OUT_TAIL");
      expect(thrown!.message).not.toContain("ERR_START");
      expect(thrown!.message).not.toContain("OUT_START");
    } finally {
      dispose();
    }
  });
});
