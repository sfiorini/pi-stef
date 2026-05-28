import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runOrchestrator } from "../../src/orchestrator/run";
import { TmuxManager } from "../../src/tmux/manager";

/* M8 S-803: end-to-end pane lifecycle through `runOrchestrator`. Inject a
 * stub `TmuxManager` that records calls AND writes the agent log file
 * locally so the test can assert content. Run two milestones-worth of
 * subscribes; assert open/close/closeAll calls are emitted in order
 * AND the per-agent raw log file contains expected bytes. */

function makeRepo(): { root: string; dispose: () => void } {
  const root = mkdtempSync(path.join(tmpdir(), "ct-e2e-tmux-"));
  spawnSync("git", ["init", "-q", "-b", "main"], { cwd: root });
  spawnSync("git", ["config", "user.email", "a@b"], { cwd: root });
  spawnSync("git", ["config", "user.name", "tester"], { cwd: root });
  return { root, dispose: () => rmSync(root, { recursive: true, force: true }) };
}

interface StubResult {
  mgr: TmuxManager;
  logDir: string;
  calls: string[];
  agentLog(id: string): string;
  cleanup: () => void;
}

function makeStubTmux(): StubResult {
  const fs = require("node:fs") as typeof import("node:fs");
  const logDir = mkdtempSync(path.join(tmpdir(), "ct-e2e-logs-"));
  const calls: string[] = [];
  const stub = {
    nextSessionAlias(toolName: string) {
      calls.push(`nextSessionAlias:${toolName}`);
      return `${toolName}-1`;
    },
    prepareSession(args: { sessionName: string; sessionAlias: string }) {
      calls.push(`prepareSession:${args.sessionName}->${args.sessionAlias}`);
      return {
        sessionName: args.sessionAlias,
        mainPaneId: "%1",
        windowId: "@1",
      };
    },
    openAgentPane(args: { agentId: string; paneTitle: string; runId?: string; logPath?: string }) {
      calls.push(`openAgentPane:${args.agentId}`);
      const logPath = path.join(logDir, `${args.agentId}.log`);
      fs.writeFileSync(logPath, `STARTED ${args.agentId} title="${args.paneTitle}"\n`);
      return { paneId: `%${args.agentId.length + 10}`, logPath };
    },
    closeAgentPane(idOrAgentId: string) {
      calls.push(`closeAgentPane:${idOrAgentId}`);
    },
    closeAllPanes(name?: string) {
      calls.push(`closeAllPanes:${name ?? "<undef>"}`);
    },
    trackedAgentIds: () => [],
    trackedPaneIds: () => [],
  } as unknown as TmuxManager;
  return {
    mgr: stub,
    logDir,
    calls,
    agentLog: (id) => path.join(logDir, `${id}.log`),
    cleanup: () => rmSync(logDir, { recursive: true, force: true }),
  };
}

describe("S-803 e2e tmux pane lifecycle (prepareSession → openAgentPane × N → closeAgentPane × N → closeAllPanes)", () => {
  let repo: ReturnType<typeof makeRepo>;
  let stub: ReturnType<typeof makeStubTmux>;
  beforeEach(() => {
    repo = makeRepo();
    stub = makeStubTmux();
  });
  afterEach(() => {
    repo.dispose();
    stub.cleanup();
  });

  it("two-milestone simulation: open/close pairs fire IN ORDER + closeAllPanes fires at finally", async () => {
    const fs = require("node:fs") as typeof import("node:fs");
    await runOrchestrator(
      {
        repoRoot: repo.root,
        slug: "tmux-e2e-lifecycle",
        toolName: "sf_team_implement",
        useWorktree: true,
        tmuxManager: stub.mgr,
      },
      async (bodyCtx) => {
        const sub1 = bodyCtx.subscribeAgent({ role: "developer", model: "m" }, "developer-M1");
        // Append real bytes to the manager-provided log file via the
        // raw-log mirroring path. This proves the agent log captures
        // actual subprocess output (the stub seeded the file with a
        // header line; we append one more line through fs to mimic
        // what spawnAgent's data-event mirror would write).
        fs.appendFileSync(sub1.rawLogPath!, "REAL-DEV-OUTPUT-LINE\n");
        // Synthesize the developer's terminal event — this drives
        // closeAgentPane via subscribeAgent's onEvent.
        sub1.onEvent({ kind: "exit", exitCode: 0, signal: null } as never);

        const sub2 = bodyCtx.subscribeAgent({ role: "reviewer", model: "r" }, "reviewer-M1");
        fs.appendFileSync(sub2.rawLogPath!, "REAL-REV-OUTPUT-LINE\n");
        sub2.onEvent({ kind: "exit", exitCode: 0, signal: null } as never);
        return "ok";
      },
    );

    // 1) Session prep fires exactly once (on first subscribe).
    expect(stub.calls.filter((c) => c.startsWith("nextSessionAlias:"))).toHaveLength(1);
    expect(stub.calls.filter((c) => c.startsWith("prepareSession:"))).toHaveLength(1);
    // 2) Two openAgentPane calls.
    expect(stub.calls.filter((c) => c.startsWith("openAgentPane:"))).toHaveLength(2);
    // 3) Two closeAgentPane calls — explicitly required by acceptance.
    const closes = stub.calls.filter((c) => c.startsWith("closeAgentPane:"));
    expect(closes).toHaveLength(2);
    // 4) closeAllPanes fires in the orchestrator's finally block.
    expect(stub.calls.filter((c) => c.startsWith("closeAllPanes:"))).toHaveLength(1);

    // 5) Order: nextSessionAlias → prepareSession → openAgentPane:dev →
    //          closeAgentPane:dev → openAgentPane:rev → closeAgentPane:rev →
    //          closeAllPanes
    const ordered = stub.calls.map((c) => c.split(":")[0]);
    expect(ordered).toEqual([
      "nextSessionAlias",
      "prepareSession",
      "openAgentPane",
      "closeAgentPane",
      "openAgentPane",
      "closeAgentPane",
      "closeAllPanes",
    ]);

    // 6) Per-agent log files contain the bytes WE appended (proves the
    // path the manager hands back is the same one the spawn-helper
    // would feed into spawnAgent's rawLogPath).
    const devLog = readFileSync(stub.agentLog("developer-M1"), "utf8");
    expect(devLog).toContain("REAL-DEV-OUTPUT-LINE");
    const revLog = readFileSync(stub.agentLog("reviewer-M1"), "utf8");
    expect(revLog).toContain("REAL-REV-OUTPUT-LINE");
  });
});
