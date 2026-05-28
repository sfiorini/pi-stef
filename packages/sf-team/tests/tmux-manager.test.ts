import { existsSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, beforeEach } from "vitest";
// existsSync used by S-506 manager-owned-runId tests.

import {
  ensureLogDir,
  getActiveSession,
  inTmux,
  InvalidSessionNameError,
  isValidLauncherSessionName,
  isValidLogPath,
  isValidTmuxSessionName,
  sanitizePaneTitle,
  TmuxManager,
  type RunResult,
  type TmuxRunner,
} from "../src/tmux/manager";

class SpyRunner implements TmuxRunner {
  calls: string[][] = [];
  responses: Array<{ match: (args: string[]) => boolean; result: RunResult }> = [];
  default: RunResult = { code: 0, stdout: "", stderr: "" };

  run(args: string[]): RunResult {
    this.calls.push([...args]);
    for (const r of this.responses) {
      if (r.match(args)) return r.result;
    }
    return this.default;
  }
}

function tmpSubdir(suffix: string): string {
  return path.join(os.tmpdir(), `tmux-mgr-test-${Date.now()}-${suffix}-${Math.random()}`);
}

/* ───────────────────── S-503 validators ─────────────────────────── */

describe("S-503 validators", () => {
  it("isValidLauncherSessionName: strict prefix + length", () => {
    expect(isValidLauncherSessionName("fh-agent-deadbeef")).toBe(true);
    expect(isValidLauncherSessionName("fh-agent-Aa-Bb_99")).toBe(true);
    expect(isValidLauncherSessionName("fh-agent-")).toBe(false);
    expect(isValidLauncherSessionName("work")).toBe(false);
    expect(isValidLauncherSessionName("fh-agent-; rm -rf /")).toBe(false);
  });

  it("isValidTmuxSessionName: permissive, accepts user sessions", () => {
    expect(isValidTmuxSessionName("work")).toBe(true);
    expect(isValidTmuxSessionName("0")).toBe(true);
    expect(isValidTmuxSessionName("dev.session_1")).toBe(true);
    expect(isValidTmuxSessionName("with space")).toBe(false);
    expect(isValidTmuxSessionName("with;semicolon")).toBe(false);
    expect(isValidTmuxSessionName("with`backtick")).toBe(false);
    expect(isValidTmuxSessionName("")).toBe(false);
  });

  it("isValidLogPath rejects spaces, quotes, semicolons, etc.", () => {
    expect(isValidLogPath("/tmp/sf-team-abc/dev.log")).toBe(true);
    expect(isValidLogPath("/tmp/dir with space/x.log")).toBe(false);
    expect(isValidLogPath("/tmp/a;b")).toBe(false);
    expect(isValidLogPath("/tmp/a\"b")).toBe(false);
  });

  it("`fh-agent-; rm -rf /` rejected by both session validators", () => {
    expect(isValidLauncherSessionName("fh-agent-; rm -rf /")).toBe(false);
    expect(isValidTmuxSessionName("fh-agent-; rm -rf /")).toBe(false);
  });
});

/* ───────────────────── S-501 getActiveSession ─────────────────────── */

describe("S-501 getActiveSession + inTmux", () => {
  it("env var matches current `#S` → isLauncherSession=true (fresh launcher, not yet renamed)", () => {
    const runner = new SpyRunner();
    runner.responses.push({
      match: (a) => a[0] === "display-message",
      result: { code: 0, stdout: "fh-agent-deadbeef\n", stderr: "" },
    });
    const result = getActiveSession({
      env: { TMUX: "/tmp/tmux-1000/default,1,0", FH_AGENT_TMUX_SESSION: "fh-agent-deadbeef" },
      runner,
    });
    expect(result).toEqual({ sessionName: "fh-agent-deadbeef", isLauncherSession: true });
  });

  it("env var differs from `#S` BUT the current session carries our identity marker → isLauncherSession=true (auto plan→implement chain)", () => {
    const runner = new SpyRunner();
    // Current session has been renamed to sf_team_auto-1 by a prior call.
    runner.responses.push({
      match: (a) => a[0] === "display-message",
      result: { code: 0, stdout: "sf_team_auto-1\n", stderr: "" },
    });
    // Marker on sf_team_auto-1 reports our env value as the original
    // launcher → continuity confirmed.
    runner.responses.push({
      match: (a) => a[0] === "show-option" && a.includes("@sf-team-owner-of") && a.includes("sf_team_auto-1"),
      result: { code: 0, stdout: "fh-agent-deadbeef\n", stderr: "" },
    });
    const result = getActiveSession({
      env: { TMUX: "/tmp/x", FH_AGENT_TMUX_SESSION: "fh-agent-deadbeef" },
      runner,
    });
    expect(result).toEqual({ sessionName: "fh-agent-deadbeef", isLauncherSession: true });
  });

  it("env var differs from `#S` AND current session has NO matching marker → falls back to permissive (env was stale/spoofed)", () => {
    const runner = new SpyRunner();
    runner.responses.push({
      match: (a) => a[0] === "display-message",
      result: { code: 0, stdout: "work\n", stderr: "" },
    });
    // Marker absent on the current session → not ours.
    runner.responses.push({
      match: (a) => a[0] === "show-option",
      result: { code: 0, stdout: "", stderr: "" },
    });
    const result = getActiveSession({
      env: { TMUX: "/tmp/x", FH_AGENT_TMUX_SESSION: "fh-agent-deadbeef" },
      runner,
    });
    // Falls back to the current session, treated as a user session.
    expect(result).toEqual({ sessionName: "work", isLauncherSession: false });
  });

  it("env var differs from `#S` AND marker on current session is a DIFFERENT launcher's id → falls back to permissive (no hijack)", () => {
    const runner = new SpyRunner();
    runner.responses.push({
      match: (a) => a[0] === "display-message",
      result: { code: 0, stdout: "sf_team_auto-1\n", stderr: "" },
    });
    // Marker reports a different launcher's identity.
    runner.responses.push({
      match: (a) => a[0] === "show-option" && a.includes("@sf-team-owner-of"),
      result: { code: 0, stdout: "fh-agent-aabbccdd\n", stderr: "" },
    });
    const result = getActiveSession({
      env: { TMUX: "/tmp/x", FH_AGENT_TMUX_SESSION: "fh-agent-deadbeef" },
      runner,
    });
    // We do NOT claim launcher status. Treat current session as user
    // session — orchestrator will skip decoration entirely.
    expect(result).toEqual({ sessionName: "sf_team_auto-1", isLauncherSession: false });
  });

  it("invalid env var → permissive fallback used (strips trailing newline only)", () => {
    const runner = new SpyRunner();
    runner.responses.push({
      match: (a) => a[0] === "display-message",
      result: { code: 0, stdout: "work\n", stderr: "" },
    });
    const result = getActiveSession({
      env: { TMUX: "/tmp/x", FH_AGENT_TMUX_SESSION: "; injected" },
      runner,
    });
    expect(result).toEqual({ sessionName: "work", isLauncherSession: false });
    expect(runner.calls[0]).toEqual(["display-message", "-p", "#S"]);
  });

  it("fallback rejects whitespace-padded session names (NOT trimmed)", () => {
    const runner = new SpyRunner();
    runner.responses.push({
      match: (a) => a[0] === "display-message",
      result: { code: 0, stdout: "  work  \n", stderr: "" }, // leading+trailing spaces around 'work'
    });
    expect(getActiveSession({ env: { TMUX: "/tmp/x" }, runner })).toBeNull();
  });

  it("env-var FH_AGENT_TMUX_SESSION with embedded whitespace is rejected (no trim)", () => {
    const runner = new SpyRunner();
    runner.responses.push({
      match: (a) => a[0] === "display-message",
      result: { code: 1, stdout: "", stderr: "no current target" },
    });
    expect(
      getActiveSession({
        env: { TMUX: "/tmp/x", FH_AGENT_TMUX_SESSION: " fh-agent-deadbeef " },
        runner,
      }),
    ).toBeNull();
  });

  it("user session 'work' accepted via fallback (no env var)", () => {
    const runner = new SpyRunner();
    runner.responses.push({
      match: (a) => a[0] === "display-message",
      result: { code: 0, stdout: "work", stderr: "" },
    });
    const result = getActiveSession({ env: { TMUX: "/tmp/x" }, runner });
    expect(result).toEqual({ sessionName: "work", isLauncherSession: false });
  });

  it("env var missing BUT current `#S` matches launcher pattern → isLauncherSession=true (env stripped by parent shell/IDE)", () => {
    // Reproduces the live-run case where `scripts/fh-agent` created
    // the tmux session, but FH_AGENT_TMUX_SESSION did not propagate
    // through to pi (intermediate shell wrapper, IDE-integrated
    // terminal, etc.). The session name is the only signal we have,
    // and `sf-team-<hex>` is a shape only the launcher generates.
    const runner = new SpyRunner();
    runner.responses.push({
      match: (a) => a[0] === "display-message",
      result: { code: 0, stdout: "fh-agent-e3e11585\n", stderr: "" },
    });
    const result = getActiveSession({ env: { TMUX: "/tmp/x" }, runner });
    expect(result).toEqual({ sessionName: "fh-agent-e3e11585", isLauncherSession: true });
    // No show-option call needed when the name itself proves launcher status.
    expect(runner.calls.some((c) => c[0] === "show-option")).toBe(false);
  });

  it("env var missing BUT current session carries our owner marker → isLauncherSession=true (subsequent run after rename)", () => {
    // Reproduces the case where `prepareSession` previously renamed
    // the launcher session to a tool alias (e.g. `sf_team_auto-1`),
    // and a follow-up run loses the env var. The name no longer
    // matches the launcher pattern, but the marker proves we own
    // the session. Marker presence alone is sufficient because ONLY
    // this codebase ever sets the `@sf-team-owner-of` user-option.
    const runner = new SpyRunner();
    runner.responses.push({
      match: (a) => a[0] === "display-message",
      result: { code: 0, stdout: "sf_team_auto-1\n", stderr: "" },
    });
    runner.responses.push({
      match: (a) => a[0] === "show-option" && a.includes("@sf-team-owner-of"),
      result: { code: 0, stdout: "fh-agent-deadbeef\n", stderr: "" },
    });
    const result = getActiveSession({ env: { TMUX: "/tmp/x" }, runner });
    expect(result).toEqual({ sessionName: "sf_team_auto-1", isLauncherSession: true });
  });

  it("env var missing AND current session has no marker AND name is generic → isLauncherSession=false", () => {
    // The env-missing fallbacks must NOT promote a generic user
    // session to launcher status. Pattern doesn't match, marker is
    // absent → user session.
    const runner = new SpyRunner();
    runner.responses.push({
      match: (a) => a[0] === "display-message",
      result: { code: 0, stdout: "work\n", stderr: "" },
    });
    runner.responses.push({
      match: (a) => a[0] === "show-option",
      result: { code: 0, stdout: "", stderr: "" },
    });
    const result = getActiveSession({ env: { TMUX: "/tmp/x" }, runner });
    expect(result).toEqual({ sessionName: "work", isLauncherSession: false });
  });

  it("env-missing fallback DOES NOT apply when env var IS set but mismatches (no-hijack guarantee preserved)", () => {
    // Even though the current session carries a marker, the env var
    // is set with a different identity. The relaxed env-missing
    // fallback must NOT kick in — that would re-introduce the
    // hijack risk path #1's marker check was designed to prevent.
    const runner = new SpyRunner();
    runner.responses.push({
      match: (a) => a[0] === "display-message",
      result: { code: 0, stdout: "shared-alias-1\n", stderr: "" },
    });
    runner.responses.push({
      match: (a) => a[0] === "show-option" && a.includes("@sf-team-owner-of"),
      result: { code: 0, stdout: "fh-agent-aabbccdd\n", stderr: "" },
    });
    const result = getActiveSession({
      env: { TMUX: "/tmp/x", FH_AGENT_TMUX_SESSION: "fh-agent-deadbeef" },
      runner,
    });
    // Env identity is `fh-agent-deadbeef` but the marker says the
    // session belongs to `fh-agent-aabbccdd`. We refuse to claim
    // launcher status. Note: the legacy permissive fallback returns
    // the session under its current name with `isLauncherSession=false`.
    expect(result).toEqual({ sessionName: "shared-alias-1", isLauncherSession: false });
    // Exactly ONE show-option call (path #1's marker check). The
    // env-missing fallback path's marker query MUST NOT fire when env
    // is set.
    expect(runner.calls.filter((c) => c[0] === "show-option").length).toBe(1);
  });

  it("user session containing ';' rejected (returns null)", () => {
    const runner = new SpyRunner();
    runner.responses.push({
      match: (a) => a[0] === "display-message",
      result: { code: 0, stdout: "evil; rm", stderr: "" },
    });
    expect(getActiveSession({ env: { TMUX: "/tmp/x" }, runner })).toBeNull();
  });

  it("$TMUX unset → null (no tmux call)", () => {
    const runner = new SpyRunner();
    expect(getActiveSession({ env: {}, runner })).toBeNull();
    expect(runner.calls).toHaveLength(0);
  });

  it("inTmux is a thin wrapper over getActiveSession", () => {
    const runner = new SpyRunner();
    expect(inTmux({ env: {}, runner })).toBe(false);
    // For the truthy assertion we need a runner that returns a valid
    // current session matching the env name.
    const runner2 = new SpyRunner();
    runner2.responses.push({
      match: (a) => a[0] === "display-message",
      result: { code: 0, stdout: "fh-agent-aabbccdd\n", stderr: "" },
    });
    expect(
      inTmux({ env: { TMUX: "/tmp/x", FH_AGENT_TMUX_SESSION: "fh-agent-aabbccdd" }, runner: runner2 }),
    ).toBe(true);
  });
});

/* ───────────────────── S-505 ensureLogDir ─────────────────────── */

describe("S-505 ensureLogDir", () => {
  let dirs: string[] = [];
  beforeEach(() => {
    dirs = [];
  });
  function tmpDir(): string {
    const d = tmpSubdir("ensureLogDir");
    dirs.push(d);
    return d;
  }
  function cleanup(): void {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  }

  it("launcher session + UUID: deterministic safe directory; runId-suffix preserved", () => {
    try {
      const tmp = tmpDir();
      const out = ensureLogDir("fh-agent-deadbeef", "0123-4567-89ab-cdef", { tmpDir: tmp });
      expect(existsSync(out)).toBe(true);
      expect(out.startsWith(tmp)).toBe(true);
      // Shape: sf-team-<8 hex>-<safe runId>.
      const base = path.basename(out);
      expect(base).toMatch(/^sf-team-[a-f0-9]{8}-0123-4567-89ab-cdef$/);
    } finally {
      cleanup();
    }
  });

  it("user session 'work' + UUID: also produces safe directory (no shell-special chars)", () => {
    try {
      const tmp = tmpDir();
      const out = ensureLogDir("work", "abc-def", { tmpDir: tmp });
      const base = path.basename(out);
      expect(base).toMatch(/^sf-team-[a-f0-9]{8}-abc-def$/);
      expect(existsSync(out)).toBe(true);
    } finally {
      cleanup();
    }
  });

  it("two consecutive runs in the SAME session yield DIFFERENT directories (proves stale-tail-output fix)", () => {
    try {
      const tmp = tmpDir();
      const a = ensureLogDir("fh-agent-aabbcc11", "run-1", { tmpDir: tmp });
      const b = ensureLogDir("fh-agent-aabbcc11", "run-2", { tmpDir: tmp });
      expect(a).not.toBe(b);
    } finally {
      cleanup();
    }
  });

  it("injection attempts on session name are rejected before hashing", () => {
    expect(() => ensureLogDir("; rm -rf /", "uuid", { tmpDir: tmpSubdir("rej") })).toThrow(
      InvalidSessionNameError,
    );
    expect(() => ensureLogDir("with space", "uuid", { tmpDir: tmpSubdir("rej") })).toThrow();
    expect(() => ensureLogDir("with`tick", "uuid", { tmpDir: tmpSubdir("rej") })).toThrow();
  });

  it("runId is sanitized: chars outside [A-Za-z0-9_-] are stripped (UUID dashes preserved)", () => {
    try {
      const tmp = tmpDir();
      const out = ensureLogDir("fh-agent-aabbccdd", "abc;injected", { tmpDir: tmp });
      const base = path.basename(out);
      // Semicolon was stripped — `abcinjected` remains.
      expect(base).toMatch(/^sf-team-[a-f0-9]{8}-abcinjected$/);
    } finally {
      cleanup();
    }
  });

  it("runId that produces empty string after sanitization is rejected", () => {
    expect(() => ensureLogDir("fh-agent-aabbcc11", ";;;;;", { tmpDir: tmpSubdir("rej") })).toThrow();
  });
});

/* ───────────────────── S-509 sanitizePaneTitle ─────────────────────── */

describe("S-509 sanitizePaneTitle", () => {
  it("strips control characters \\x00-\\x1F\\x7F", () => {
    const raw = `dev\x00with\x01control\x1Fchars\x7F`;
    const out = sanitizePaneTitle(raw);
    expect(out).toBe("devwithcontrolchars");
    // Post-sanitize string MUST NOT contain any control bytes.
    expect(/[\x00-\x1F\x7F]/.test(out)).toBe(false);
  });

  it("caps at 80 chars", () => {
    const out = sanitizePaneTitle("x".repeat(200));
    expect(out.length).toBe(80);
  });

  it("property: random Unicode + full control-char set produces a clean string", () => {
    let raw = "";
    for (let i = 0; i < 200; i++) {
      const cp = Math.random() < 0.5 ? Math.floor(Math.random() * 0x80) : Math.floor(0x80 + Math.random() * 0x500);
      raw += String.fromCodePoint(cp);
    }
    const out = sanitizePaneTitle(raw);
    expect(out.length).toBeLessThanOrEqual(80);
    expect(/[\x00-\x1F\x7F]/.test(out)).toBe(false);
  });
});

/* ───────────────────── prepareSession + nextSessionAlias ─────────────── */

describe("nextSessionAlias (Issue 3)", () => {
  it("returns `<toolName>-1` when no existing sessions match the prefix", () => {
    const runner = new SpyRunner();
    runner.responses.push({
      match: (a) => a[0] === "list-sessions",
      result: { code: 0, stdout: "main\nwork\nfh-agent-deadbeef\n", stderr: "" },
    });
    const mgr = new TmuxManager({ runner });
    expect(mgr.nextSessionAlias("sf_team_auto")).toBe("sf_team_auto-1");
  });

  it("returns the smallest unused N when sessions for the prefix exist", () => {
    const runner = new SpyRunner();
    runner.responses.push({
      match: (a) => a[0] === "list-sessions",
      result: { code: 0, stdout: "sf_team_auto-1\nsf_team_auto-3\nother\n", stderr: "" },
    });
    const mgr = new TmuxManager({ runner });
    // 1 and 3 are taken; smallest unused is 2.
    expect(mgr.nextSessionAlias("sf_team_auto")).toBe("sf_team_auto-2");
  });

  it("rejects malformed toolName before any tmux call", () => {
    const runner = new SpyRunner();
    const mgr = new TmuxManager({ runner });
    expect(() => mgr.nextSessionAlias("bad name with space")).toThrow(/Invalid toolName/);
    expect(runner.calls).toHaveLength(0);
  });
});

describe("prepareSession (Issue 3)", () => {
  it("renames `sf-team-<hex>` → `<toolName>-<N>` + titles main pane + sets pane-border-status", () => {
    const runner = new SpyRunner();
    // has-session: target alias does NOT exist (rename will succeed).
    runner.responses.push({
      match: (a) => a[0] === "has-session" && a.includes("sf_team_auto-1"),
      result: { code: 1, stdout: "", stderr: "no such session" },
    });
    runner.responses.push({
      match: (a) => a[0] === "rename-session",
      result: { code: 0, stdout: "", stderr: "" },
    });
    runner.responses.push({
      match: (a) => a[0] === "display-message",
      result: { code: 0, stdout: "@7", stderr: "" },
    });
    runner.responses.push({
      match: (a) => a[0] === "list-panes",
      result: { code: 0, stdout: "%1 0\n", stderr: "" }, // pane_id=%1, pane_index=0
    });
    const mgr = new TmuxManager({ runner });
    const r = mgr.prepareSession({ sessionName: "fh-agent-deadbeef", sessionAlias: "sf_team_auto-1" });
    expect(r.sessionName).toBe("sf_team_auto-1");
    expect(r.mainPaneId).toBe("%1");
    expect(r.windowId).toBe("@7");
    // rename-session was called targeting the original.
    expect(runner.calls.some((c) => c[0] === "rename-session" && c.includes("fh-agent-deadbeef") && c.includes("sf_team_auto-1"))).toBe(true);
    // Window renamed to the alias.
    expect(runner.calls.some((c) => c[0] === "rename-window" && c.includes("@7") && c.includes("sf_team_auto-1"))).toBe(true);
    // Main pane titled `Main`, shown as `[Main]` by pane-border-format.
    expect(runner.calls.some((c) => c[0] === "select-pane" && c.includes("%1") && c.includes("Main"))).toBe(true);
    // pane-border-status enabled.
    expect(runner.calls.some((c) => c[0] === "set-option" && c.includes("pane-border-status") && c.includes("top"))).toBe(true);
    expect(runner.calls.some((c) => c[0] === "set-option" && c.includes("pane-border-format") && c.includes("[#{pane_title}]"))).toBe(true);
    // Identity-specific ownership marker stamped: value MUST be the
    // original launcher session name so only a follow-up call from
    // the SAME logical launcher chain can adopt this session.
    expect(runner.calls.some((c) =>
      c[0] === "set-option"
      && c.includes("@sf-team-owner-of")
      && c.includes("fh-agent-deadbeef")
      && c.includes("sf_team_auto-1"),
    )).toBe(true);
  });

  it("decorates a regular tmux session without renaming it", () => {
    const runner = new SpyRunner();
    runner.responses.push({
      match: (a) => a[0] === "display-message" && a.includes("user-work"),
      result: { code: 0, stdout: "@9", stderr: "" },
    });
    runner.responses.push({
      match: (a) => a[0] === "list-panes" && a.includes("@9"),
      result: { code: 0, stdout: "%3 0\n%4 1", stderr: "" },
    });

    const mgr = new TmuxManager({ runner });
    const r = mgr.decorateSession({ sessionName: "user-work" });

    expect(r.sessionName).toBe("user-work");
    expect(r.mainPaneId).toBe("%3");
    expect(r.windowId).toBe("@9");
    expect(runner.calls.filter((c) => c[0] === "rename-session")).toHaveLength(0);
    expect(runner.calls.some((c) => c[0] === "select-pane" && c.includes("%3") && c.includes("Main"))).toBe(true);
    expect(runner.calls.some((c) => c[0] === "set-option" && c.includes("pane-border-status") && c.includes("top"))).toBe(true);
    expect(runner.calls.some((c) => c[0] === "set-option" && c.includes("pane-border-format") && c.includes("[#{pane_title}]"))).toBe(true);
  });

  it("does NOT hijack a user's unrelated session when alias collides (ownership marker absent on alias)", () => {
    const runner = new SpyRunner();
    runner.responses.push({
      match: (a) => a[0] === "has-session" && a.includes("sf_team_auto-1"),
      result: { code: 0, stdout: "", stderr: "" },
    });
    // Ownership marker: absent on the user's alias → not ours → don't adopt.
    runner.responses.push({
      match: (a) => a[0] === "show-option" && a.includes("@sf-team-owner-of") && a.includes("sf_team_auto-1"),
      result: { code: 0, stdout: "", stderr: "" },
    });
    runner.responses.push({
      match: (a) => a[0] === "display-message" && a.includes("fh-agent-deadbeef"),
      result: { code: 0, stdout: "@7", stderr: "" },
    });
    runner.responses.push({
      match: (a) => a[0] === "list-panes",
      result: { code: 0, stdout: "%1 0", stderr: "" },
    });
    const mgr = new TmuxManager({ runner });
    const r = mgr.prepareSession({ sessionName: "fh-agent-deadbeef", sessionAlias: "sf_team_auto-1" });
    expect(r.sessionName).toBe("fh-agent-deadbeef");
    expect(runner.calls.filter((c) => c[0] === "rename-session")).toHaveLength(0);
    // Marker stamped on the original session (value = original session
    // name) — never touched the user's alias.
    expect(runner.calls.some((c) =>
      c[0] === "set-option"
      && c.includes("@sf-team-owner-of")
      && c.includes("fh-agent-deadbeef")
      && !c.includes("sf_team_auto-1"),
    )).toBe(true);
    expect(runner.calls.some((c) =>
      c[0] === "set-option" && c.includes("@sf-team-owner-of") && c.includes("sf_team_auto-1"),
    )).toBe(false);
  });

  it("does NOT adopt an alias session when the marker belongs to a DIFFERENT launcher (round-3 race scenario)", () => {
    // Adversarial scenario from round-3 review: a different
    // sf-team launcher (with its own `sf-team-<hex>`) already
    // renamed its session to `sf_team_auto-1` and stamped the marker
    // with ITS OWN identity. Our launcher is `fh-agent-deadbeef`.
    // The identity-specific marker means we MUST NOT adopt the other
    // launcher's session.
    const runner = new SpyRunner();
    runner.responses.push({
      match: (a) => a[0] === "has-session" && a.includes("sf_team_auto-1"),
      result: { code: 0, stdout: "", stderr: "" },
    });
    // Marker on the alias session reports a DIFFERENT launcher's id.
    runner.responses.push({
      match: (a) => a[0] === "show-option" && a.includes("@sf-team-owner-of") && a.includes("sf_team_auto-1"),
      result: { code: 0, stdout: "fh-agent-aabbccdd\n", stderr: "" },
    });
    runner.responses.push({
      match: (a) => a[0] === "display-message" && a.includes("fh-agent-deadbeef"),
      result: { code: 1, stdout: "", stderr: "session not found" },
    });
    const mgr = new TmuxManager({ runner });
    expect(() =>
      mgr.prepareSession({ sessionName: "fh-agent-deadbeef", sessionAlias: "sf_team_auto-1" }),
    ).toThrow(/display-message failed/);
    // Never targeted the OTHER launcher's session.
    expect(runner.calls.some((c) => c[0] === "display-message" && c.includes("sf_team_auto-1"))).toBe(false);
    expect(runner.calls.filter((c) => c[0] === "rename-session")).toHaveLength(0);
    expect(runner.calls.some((c) =>
      c[0] === "set-option" && c.includes("@sf-team-owner-of") && c.includes("sf_team_auto-1"),
    )).toBe(false);
  });

  it("ADOPTS the alias as sessionName when the alias carries OUR identity-specific marker", () => {
    // Scenario: sf_team_auto's plan phase already renamed
    // `fh-agent-deadbeef` → `sf_team_auto-1` AND stamped the
    // identity-specific marker (value = our launcher session name).
    // Now the implement phase calls prepareSession with the stale
    // `fh-agent-deadbeef` and the same alias. The manager reads
    // the marker via `show-option`, confirms it matches our identity,
    // and adopts the alias.
    const runner = new SpyRunner();
    runner.responses.push({
      match: (a) => a[0] === "has-session" && a.includes("sf_team_auto-1"),
      result: { code: 0, stdout: "", stderr: "" },
    });
    // Identity-specific marker: equals OUR original session name → adopt.
    runner.responses.push({
      match: (a) => a[0] === "show-option" && a.includes("@sf-team-owner-of") && a.includes("sf_team_auto-1"),
      result: { code: 0, stdout: "fh-agent-deadbeef\n", stderr: "" },
    });
    runner.responses.push({
      match: (a) => a[0] === "display-message" && a.includes("sf_team_auto-1"),
      result: { code: 0, stdout: "@7", stderr: "" },
    });
    runner.responses.push({
      match: (a) => a[0] === "list-panes" && a.includes("@7"),
      result: { code: 0, stdout: "%1 0", stderr: "" },
    });
    const mgr = new TmuxManager({ runner });
    const r = mgr.prepareSession({ sessionName: "fh-agent-deadbeef", sessionAlias: "sf_team_auto-1" });
    expect(r.sessionName).toBe("sf_team_auto-1");
    expect(runner.calls.filter((c) => c[0] === "rename-session")).toHaveLength(0);
    expect(runner.calls.some((c) => c[0] === "display-message" && c.includes("sf_team_auto-1"))).toBe(true);
    // Marker re-stamped on the adopted session (idempotent — same identity).
    expect(runner.calls.some((c) =>
      c[0] === "set-option"
      && c.includes("@sf-team-owner-of")
      && c.includes("fh-agent-deadbeef")
      && c.includes("sf_team_auto-1"),
    )).toBe(true);
  });

  it("does NOT adopt an alias session when the ownership marker is missing (alias is user-owned, original was killed for unrelated reasons)", () => {
    // Adversarial scenario the round-2 reviewer flagged: our launcher
    // session was killed (not by our rename); user happens to have a
    // pre-existing `sf_team_auto-1` session. The marker is absent on
    // that session, so we MUST NOT touch it. We fall through with the
    // original sessionName; the subsequent display-message will fail
    // and prepareSessionOnce will surface a graceful error.
    const runner = new SpyRunner();
    runner.responses.push({
      match: (a) => a[0] === "has-session" && a.includes("sf_team_auto-1"),
      result: { code: 0, stdout: "", stderr: "" },
    });
    // Ownership marker: ABSENT (show-option returns empty stdout, exit 0).
    runner.responses.push({
      match: (a) => a[0] === "show-option" && a.includes("@sf-team-owner"),
      result: { code: 0, stdout: "", stderr: "" },
    });
    // display-message against the (gone) original fails — surfaces error.
    runner.responses.push({
      match: (a) => a[0] === "display-message" && a.includes("fh-agent-deadbeef"),
      result: { code: 1, stdout: "", stderr: "session not found" },
    });
    const mgr = new TmuxManager({ runner });
    expect(() =>
      mgr.prepareSession({ sessionName: "fh-agent-deadbeef", sessionAlias: "sf_team_auto-1" }),
    ).toThrow(/display-message failed/);
    // No display-message targeting the user-owned alias (hijack guard).
    expect(runner.calls.some((c) => c[0] === "display-message" && c.includes("sf_team_auto-1"))).toBe(false);
    // No rename-session, no set-option on the user-owned alias.
    expect(runner.calls.filter((c) => c[0] === "rename-session")).toHaveLength(0);
    expect(runner.calls.some((c) => c[0] === "set-option" && c.includes("sf_team_auto-1"))).toBe(false);
  });

  it("rejects invalid session name AND invalid alias", () => {
    const runner = new SpyRunner();
    const mgr = new TmuxManager({ runner });
    expect(() =>
      mgr.prepareSession({ sessionName: "with space", sessionAlias: "sf_team_auto-1" }),
    ).toThrow(InvalidSessionNameError);
    expect(() =>
      mgr.prepareSession({ sessionName: "fh-agent-aabbccdd", sessionAlias: "bad alias" }),
    ).toThrow(/Invalid session alias/);
  });
});

/* ───────────────────── S-506 openAgentPane ─────────────────────── */

describe("S-506 openAgentPane (caller-owned logPath)", () => {
  it("argv shape: split-window with -t <sidePane> -v -P -F #{pane_id} <tail-cmd>", () => {
    const runner = new SpyRunner();
    runner.responses.push({
      match: (a) => a[0] === "split-window",
      result: { code: 0, stdout: "%9\n", stderr: "" },
    });
    const mgr = new TmuxManager({ runner });
    const r = mgr.openAgentPane({
      sessionName: "fh-agent-aabbccdd",
      agentId: "developer-M1",
      paneTitle: "developer-M1",
      logPath: "/tmp/sf-team-abc/dev.log",
      // Skip pretty-pane filter so the tail command is exactly `tail -F <path>`.
      pretty: false,
    });
    expect(r.paneId).toBe("%9");
    expect(r.logPath).toBe("/tmp/sf-team-abc/dev.log");
    const split = runner.calls.find((c) => c[0] === "split-window")!;
    // First openAgentPane in the session: split the active window
    // horizontally (-h) targeting sessionName. No -t <prevPaneId> yet.
    expect(split).toEqual([
      "split-window",
      "-h",
      "-t",
      "fh-agent-aabbccdd",
      "-P",
      "-F",
      "#{pane_id}",
      "tail -F /tmp/sf-team-abc/dev.log",
    ]);
    const title = runner.calls.find((c) => c[0] === "select-pane")!;
    expect(title).toEqual(["select-pane", "-t", "%9", "-T", "developer-M1"]);
  });

  it("second openAgentPane stacks below the first via `-v -t <lastAgentPaneId>`", () => {
    let n = 0;
    const runner: TmuxRunner = {
      run(args) {
        if (args[0] === "split-window") { n += 1; return { code: 0, stdout: `%${10 + n}`, stderr: "" }; }
        return { code: 0, stdout: "", stderr: "" };
      },
    };
    // Spy passthrough — we want to inspect the args used.
    const calls: string[][] = [];
    const spy: TmuxRunner = {
      run(args) {
        calls.push([...args]);
        return runner.run(args);
      },
    };
    const mgr = new TmuxManager({ runner: spy });
    mgr.openAgentPane({
      sessionName: "fh-agent-aabbccdd",
      agentId: "researcher-1",
      paneTitle: "researcher-1",
      logPath: "/tmp/r.log",
      pretty: false,
    });
    mgr.openAgentPane({
      sessionName: "fh-agent-aabbccdd",
      agentId: "developer-1",
      paneTitle: "developer-1",
      logPath: "/tmp/d.log",
      pretty: false,
    });
    const splits = calls.filter((c) => c[0] === "split-window");
    expect(splits).toHaveLength(2);
    // First: -h -t <sessionName>
    expect(splits[0].slice(0, 4)).toEqual(["split-window", "-h", "-t", "fh-agent-aabbccdd"]);
    // Second: -v -t %11 (the first pane's id from our stub).
    expect(splits[1].slice(0, 4)).toEqual(["split-window", "-v", "-t", "%11"]);
  });

  it("3-pane survivor: closing the latest pane reflows so the next pane stacks on the most recent survivor", () => {
    let n = 0;
    const calls: string[][] = [];
    const runner: TmuxRunner = {
      run(args) {
        calls.push([...args]);
        if (args[0] === "split-window") { n += 1; return { code: 0, stdout: `%${10 + n}`, stderr: "" }; }
        return { code: 0, stdout: "", stderr: "" };
      },
    };
    const mgr = new TmuxManager({ runner });
    // Open 3 panes — they should stack: first via -h, next two via -v.
    const a = mgr.openAgentPane({ sessionName: "fh-agent-aabbccdd", agentId: "a1", paneTitle: "a-1", logPath: "/tmp/a.log", pretty: false });
    const b = mgr.openAgentPane({ sessionName: "fh-agent-aabbccdd", agentId: "b1", paneTitle: "b-1", logPath: "/tmp/b.log", pretty: false });
    const c = mgr.openAgentPane({ sessionName: "fh-agent-aabbccdd", agentId: "c1", paneTitle: "c-1", logPath: "/tmp/c.log", pretty: false });
    expect(a.paneId).toBe("%11");
    expect(b.paneId).toBe("%12");
    expect(c.paneId).toBe("%13");
    // Close the LATEST pane (%13). The lastAgentPaneId tracker must
    // fall back to the most recent survivor (%12), NOT to undefined,
    // so the NEXT openAgentPane keeps stacking inside the right
    // column instead of creating a new horizontal split.
    mgr.closeAgentPane(c.paneId);
    const d = mgr.openAgentPane({ sessionName: "fh-agent-aabbccdd", agentId: "d1", paneTitle: "d-1", logPath: "/tmp/d.log", pretty: false });
    const splits = calls.filter((s) => s[0] === "split-window");
    expect(splits).toHaveLength(4);
    // 4th split MUST be -v -t %12 (most recent survivor), not -h -t <sessionName>.
    expect(splits[3].slice(0, 4)).toEqual(["split-window", "-v", "-t", "%12"]);
    expect(d.paneId).toBe("%14");
  });

  it("3-pane survivor: closing ALL panes resets so the next pane creates a fresh right column", () => {
    let n = 0;
    const calls: string[][] = [];
    const runner: TmuxRunner = {
      run(args) {
        calls.push([...args]);
        if (args[0] === "split-window") { n += 1; return { code: 0, stdout: `%${10 + n}`, stderr: "" }; }
        return { code: 0, stdout: "", stderr: "" };
      },
    };
    const mgr = new TmuxManager({ runner });
    const a = mgr.openAgentPane({ sessionName: "fh-agent-aabbccdd", agentId: "a1", paneTitle: "a-1", logPath: "/tmp/a.log", pretty: false });
    const b = mgr.openAgentPane({ sessionName: "fh-agent-aabbccdd", agentId: "b1", paneTitle: "b-1", logPath: "/tmp/b.log", pretty: false });
    mgr.closeAgentPane(b.paneId);
    mgr.closeAgentPane(a.paneId);
    // No survivors. Next openAgentPane must create a fresh -h split.
    mgr.openAgentPane({ sessionName: "fh-agent-aabbccdd", agentId: "c1", paneTitle: "c-1", logPath: "/tmp/c.log", pretty: false });
    const splits = calls.filter((s) => s[0] === "split-window");
    expect(splits).toHaveLength(3);
    expect(splits[2].slice(0, 4)).toEqual(["split-window", "-h", "-t", "fh-agent-aabbccdd"]);
  });

  it("`pretty=true` (default) pipes the log through pretty-pane.mjs", () => {
    const runner = new SpyRunner();
    runner.responses.push({
      match: (a) => a[0] === "split-window",
      result: { code: 0, stdout: "%9", stderr: "" },
    });
    const mgr = new TmuxManager({ runner });
    mgr.openAgentPane({
      sessionName: "fh-agent-aabbccdd",
      agentId: "researcher-1",
      paneTitle: "researcher-1",
      logPath: "/tmp/r.log",
      // pretty defaults to true
    });
    const split = runner.calls.find((c) => c[0] === "split-window")!;
    const cmd = split[split.length - 1];
    expect(cmd).toMatch(/^tail -F \/tmp\/r\.log \| PRETTY_PANE_THEME=codex node .+\/pretty-pane\.mjs$/);
  });

  it("uses SF_TEAM_PANE_THEME as the pretty-pane theme override when set", () => {
    const original = process.env.SF_TEAM_PANE_THEME;
    process.env.SF_TEAM_PANE_THEME = "plain";
    try {
      const runner = new SpyRunner();
      runner.responses.push({
        match: (a) => a[0] === "split-window",
        result: { code: 0, stdout: "%9", stderr: "" },
      });
      const mgr = new TmuxManager({ runner });
      mgr.openAgentPane({
        sessionName: "fh-agent-aabbccdd",
        agentId: "researcher-1",
        paneTitle: "researcher-1",
        logPath: "/tmp/r.log",
      });
      const split = runner.calls.find((c) => c[0] === "split-window")!;
      expect(split[split.length - 1]).toMatch(/^tail -F \/tmp\/r\.log \| PRETTY_PANE_THEME=plain node /);
    } finally {
      if (original === undefined) delete process.env.SF_TEAM_PANE_THEME;
      else process.env.SF_TEAM_PANE_THEME = original;
    }
  });

  it("opens story panes vertically inside a grouped milestone lane", () => {
    let n = 0;
    const calls: string[][] = [];
    const runner: TmuxRunner = {
      run(args) {
        calls.push([...args]);
        if (args[0] === "split-window") {
          n += 1;
          return { code: 0, stdout: `%${10 + n}`, stderr: "" };
        }
        return { code: 0, stdout: "", stderr: "" };
      },
    };
    const mgr = new TmuxManager({ runner });
    mgr.openAgentPane({
      sessionName: "fh-agent-aabbccdd",
      agentId: "developer-M1",
      paneTitle: "developer-M1",
      logPath: "/tmp/m1.log",
      pretty: false,
      groupId: "M1",
      groupTitle: "M1",
      layoutRole: "milestone",
    });
    mgr.openAgentPane({
      sessionName: "fh-agent-aabbccdd",
      agentId: "developer-M1-S101",
      paneTitle: "developer-M1-S101",
      logPath: "/tmp/s101.log",
      pretty: false,
      groupId: "M1",
      parentGroupId: "M1",
      storyId: "S-101",
      layoutRole: "story",
    });
    mgr.openAgentPane({
      sessionName: "fh-agent-aabbccdd",
      agentId: "developer-M1-S102",
      paneTitle: "developer-M1-S102",
      logPath: "/tmp/s102.log",
      pretty: false,
      groupId: "M1",
      parentGroupId: "M1",
      storyId: "S-102",
      layoutRole: "story",
    });
    const splits = calls.filter((c) => c[0] === "split-window");
    expect(splits[0].slice(0, 4)).toEqual(["split-window", "-h", "-t", "fh-agent-aabbccdd"]);
    expect(splits[1].slice(0, 4)).toEqual(["split-window", "-v", "-t", "%11"]);
    expect(splits[2].slice(0, 4)).toEqual(["split-window", "-v", "-t", "%12"]);
  });

  it("opens reviewer lanes as horizontal siblings instead of vertical story panes", () => {
    let n = 0;
    const calls: string[][] = [];
    const runner: TmuxRunner = {
      run(args) {
        calls.push([...args]);
        if (args[0] === "split-window") {
          n += 1;
          return { code: 0, stdout: `%${10 + n}`, stderr: "" };
        }
        return { code: 0, stdout: "", stderr: "" };
      },
    };
    const mgr = new TmuxManager({ runner });
    mgr.openAgentPane({
      sessionName: "fh-agent-aabbccdd",
      agentId: "developer-M1",
      paneTitle: "developer-M1",
      logPath: "/tmp/m1.log",
      pretty: false,
      groupId: "M1",
      layoutRole: "milestone",
    });
    mgr.openAgentPane({
      sessionName: "fh-agent-aabbccdd",
      agentId: "reviewer-M1",
      paneTitle: "reviewer-M1",
      logPath: "/tmp/r1.log",
      pretty: false,
      groupId: "review-M1",
      parentGroupId: "M1",
      layoutRole: "reviewer",
    });
    const splits = calls.filter((c) => c[0] === "split-window");
    expect(splits[0].slice(0, 4)).toEqual(["split-window", "-h", "-t", "fh-agent-aabbccdd"]);
    expect(splits[1].slice(0, 4)).toEqual(["split-window", "-h", "-t", "fh-agent-aabbccdd"]);
  });

  it("targets the prepared main pane when opening multiple milestone/reviewer lanes", () => {
    let n = 0;
    const runner = new SpyRunner();
    runner.responses.push({
      match: (a) => a[0] === "has-session",
      result: { code: 1, stdout: "", stderr: "no such session" },
    });
    runner.responses.push({
      match: (a) => a[0] === "rename-session",
      result: { code: 0, stdout: "", stderr: "" },
    });
    runner.responses.push({
      match: (a) => a[0] === "display-message",
      result: { code: 0, stdout: "@7", stderr: "" },
    });
    runner.responses.push({
      match: (a) => a[0] === "list-panes",
      result: { code: 0, stdout: "%1 0\n", stderr: "" },
    });
    runner.responses.push({
      match: (a) => a[0] === "split-window",
      result: { code: 0, get stdout() { n += 1; return `%${10 + n}`; }, stderr: "" },
    });
    const mgr = new TmuxManager({ runner });
    const prepared = mgr.prepareSession({ sessionName: "fh-agent-aabbccdd", sessionAlias: "sf_team_auto-1" });
    mgr.openAgentPane({
      sessionName: prepared.sessionName,
      agentId: "developer-M1",
      paneTitle: "developer-M1",
      logPath: "/tmp/m1.log",
      pretty: false,
      groupId: "M1",
      layoutRole: "milestone",
    });
    mgr.openAgentPane({
      sessionName: prepared.sessionName,
      agentId: "reviewer-M1",
      paneTitle: "reviewer-M1",
      logPath: "/tmp/r1.log",
      pretty: false,
      groupId: "review-M1",
      layoutRole: "reviewer",
    });
    const splits = runner.calls.filter((c) => c[0] === "split-window");
    expect(splits[0].slice(0, 4)).toEqual(["split-window", "-h", "-t", "%1"]);
    expect(splits[1].slice(0, 4)).toEqual(["split-window", "-h", "-t", "%1"]);
  });

  it("recomputes grouped story insertion target after a story pane closes", () => {
    let n = 0;
    const calls: string[][] = [];
    const runner: TmuxRunner = {
      run(args) {
        calls.push([...args]);
        if (args[0] === "split-window") {
          n += 1;
          return { code: 0, stdout: `%${10 + n}`, stderr: "" };
        }
        return { code: 0, stdout: "", stderr: "" };
      },
    };
    const mgr = new TmuxManager({ runner });
    mgr.openAgentPane({ sessionName: "fh-agent-aabbccdd", agentId: "developer-M1", paneTitle: "developer-M1", logPath: "/tmp/m1.log", pretty: false, groupId: "M1", layoutRole: "milestone" });
    const story1 = mgr.openAgentPane({ sessionName: "fh-agent-aabbccdd", agentId: "developer-M1-S101", paneTitle: "developer-M1-S101", logPath: "/tmp/s101.log", pretty: false, parentGroupId: "M1", storyId: "S-101", layoutRole: "story" });
    const story2 = mgr.openAgentPane({ sessionName: "fh-agent-aabbccdd", agentId: "developer-M1-S102", paneTitle: "developer-M1-S102", logPath: "/tmp/s102.log", pretty: false, parentGroupId: "M1", storyId: "S-102", layoutRole: "story" });
    mgr.closeAgentPane(story1.paneId);
    mgr.openAgentPane({ sessionName: "fh-agent-aabbccdd", agentId: "developer-M1-S103", paneTitle: "developer-M1-S103", logPath: "/tmp/s103.log", pretty: false, parentGroupId: "M1", storyId: "S-103", layoutRole: "story" });
    const splits = calls.filter((c) => c[0] === "split-window");
    expect(story2.paneId).toBe("%13");
    expect(splits[3].slice(0, 4)).toEqual(["split-window", "-v", "-t", "%13"]);
  });

  it("keeps ungrouped insertion target stable when a grouped pane closes", () => {
    let n = 0;
    const calls: string[][] = [];
    const runner: TmuxRunner = {
      run(args) {
        calls.push([...args]);
        if (args[0] === "split-window") {
          n += 1;
          return { code: 0, stdout: `%${10 + n}`, stderr: "" };
        }
        return { code: 0, stdout: "", stderr: "" };
      },
    };
    const mgr = new TmuxManager({ runner });
    const milestone = mgr.openAgentPane({ sessionName: "fh-agent-aabbccdd", agentId: "developer-M1", paneTitle: "developer-M1", logPath: "/tmp/m1.log", pretty: false, groupId: "M1", layoutRole: "milestone" });
    const ungrouped = mgr.openAgentPane({ sessionName: "fh-agent-aabbccdd", agentId: "developer-plain", paneTitle: "developer-plain", logPath: "/tmp/u.log", pretty: false });
    mgr.closeAgentPane(milestone.paneId);
    mgr.openAgentPane({ sessionName: "fh-agent-aabbccdd", agentId: "developer-next", paneTitle: "developer-next", logPath: "/tmp/next.log", pretty: false });
    const splits = calls.filter((c) => c[0] === "split-window");
    expect(ungrouped.paneId).toBe("%12");
    expect(splits[2].slice(0, 4)).toEqual(["split-window", "-v", "-t", "%12"]);
  });

  it("throws when select-pane (set agent-pane title) fails after creating the split", () => {
    const runner = new SpyRunner();
    runner.responses.push({
      match: (a) => a[0] === "split-window",
      result: { code: 0, stdout: "%9", stderr: "" },
    });
    runner.responses.push({
      match: (a) => a[0] === "select-pane",
      result: { code: 1, stdout: "", stderr: "title rejected" },
    });
    const mgr = new TmuxManager({ runner });
    expect(() =>
      mgr.openAgentPane({
        sessionName: "fh-agent-aabbccdd",
        agentId: "developer-M1",
        paneTitle: "title",
        logPath: "/tmp/x.log",
      }),
    ).toThrow(/select-pane \(set agent-pane title\) failed.*title rejected/);
  });

  it("rejects invalid log path before invoking tmux", () => {
    const runner = new SpyRunner();
    const mgr = new TmuxManager({ runner });
    expect(() =>
      mgr.openAgentPane({
        sessionName: "fh-agent-aabbccdd",
        agentId: "x",
        paneTitle: "t",
        logPath: "/tmp/path with space/log",
      }),
    ).toThrow();
    expect(runner.calls).toHaveLength(0);
  });

  it("tracks paneId for later closeAgentPane lookup", () => {
    const runner = new SpyRunner();
    runner.responses.push({
      match: (a) => a[0] === "split-window",
      result: { code: 0, stdout: "%11", stderr: "" },
    });
    const mgr = new TmuxManager({ runner });
    mgr.openAgentPane({
      sessionName: "fh-agent-aabbccdd",
      agentId: "developer-M1",
      paneTitle: "title",
      logPath: "/tmp/x.log",
    });
    expect(mgr.trackedPaneIds()).toEqual(["%11"]);
    expect(mgr.trackedAgentIds()).toEqual(["developer-M1"]);
  });
});

describe("S-506 openAgentPane (manager-owned runId — log dir creation)", () => {
  it("with `runId`: manager generates and creates the per-run log path; returns it", () => {
    const runner = new SpyRunner();
    runner.responses.push({
      match: (a) => a[0] === "split-window",
      result: { code: 0, stdout: "%9", stderr: "" },
    });
    const mgr = new TmuxManager({ runner });
    const r = mgr.openAgentPane({
      sessionName: "fh-agent-aabbccdd",
      agentId: "developer-M1",
      paneTitle: "title",
      runId: "run-uuid-1",
    });
    // The manager-derived path lives under os.tmpdir/sf-team-<8hex>-<runId>/<agentId>.log
    expect(r.logPath).toMatch(/sf-team-[a-f0-9]{8}-run-uuid-1\/developer-M1\.log$/);
    // The dir must exist on disk now (ensureLogDir creates it).
    expect(existsSync(path.dirname(r.logPath))).toBe(true);
  });

  it("two consecutive openAgentPane calls in the SAME (session, runId) reuse the SAME log dir", () => {
    const runner = new SpyRunner();
    runner.responses.push({
      match: (a) => a[0] === "split-window",
      result: { code: 0, stdout: "%1", stderr: "" },
    });
    const mgr = new TmuxManager({ runner });
    const a = mgr.openAgentPane({
      sessionName: "fh-agent-aabbccdd",
      agentId: "dev",
      paneTitle: "t",
      runId: "uuid-x",
    });
    const b = mgr.openAgentPane({
      sessionName: "fh-agent-aabbccdd",
      agentId: "rev",
      paneTitle: "t",
      runId: "uuid-x",
    });
    expect(path.dirname(a.logPath)).toBe(path.dirname(b.logPath));
    expect(a.logPath).not.toBe(b.logPath); // different filenames per agentId
  });

  it("rejects when both `logPath` and `runId` are provided", () => {
    const runner = new SpyRunner();
    const mgr = new TmuxManager({ runner });
    expect(() =>
      mgr.openAgentPane({
        sessionName: "fh-agent-aabbccdd",
        agentId: "x",
        paneTitle: "t",
        logPath: "/tmp/a.log",
        runId: "uuid",
      }),
    ).toThrow(/exactly one/);
  });

  it("rejects when neither `logPath` nor `runId` is provided", () => {
    const runner = new SpyRunner();
    const mgr = new TmuxManager({ runner });
    expect(() =>
      mgr.openAgentPane({
        sessionName: "fh-agent-aabbccdd",
        agentId: "x",
        paneTitle: "t",
      }),
    ).toThrow(/required/);
  });
});

/* ───────────────────── S-507 closeAgentPane ─────────────────────── */

describe("S-507 closeAgentPane", () => {
  function withOpenedPane(runner: SpyRunner): TmuxManager {
    runner.responses.push({
      match: (a) => a[0] === "split-window",
      result: { code: 0, stdout: "%9", stderr: "" },
    });
    const mgr = new TmuxManager({ runner });
    mgr.openAgentPane({
      sessionName: "fh-agent-aabbcc11",
      agentId: "developer-M1",
      paneTitle: "title",
      logPath: "/tmp/x.log",
    });
    return mgr;
  }

  it("happy path: kills pane and removes from tracking (called with paneId — M5 contract)", () => {
    const runner = new SpyRunner();
    const mgr = withOpenedPane(runner);
    mgr.closeAgentPane("%9");
    expect(mgr.trackedAgentIds()).toEqual([]);
    const kill = runner.calls.find((c) => c[0] === "kill-pane");
    expect(kill).toEqual(["kill-pane", "-t", "%9"]);
  });

  it("ergonomic alias: also accepts agentId (callers that prefer their own key)", () => {
    const runner = new SpyRunner();
    const mgr = withOpenedPane(runner);
    mgr.closeAgentPane("developer-M1");
    expect(mgr.trackedAgentIds()).toEqual([]);
    const kill = runner.calls.find((c) => c[0] === "kill-pane");
    expect(kill).toEqual(["kill-pane", "-t", "%9"]);
  });

  it("swallows 'can't find pane' stderr (pane already closed)", () => {
    const runner = new SpyRunner();
    runner.responses.push({
      match: (a) => a[0] === "kill-pane",
      result: { code: 1, stdout: "", stderr: "can't find pane: %9" },
    });
    const mgr = withOpenedPane(runner);
    expect(() => mgr.closeAgentPane("%9")).not.toThrow();
    expect(mgr.trackedAgentIds()).toEqual([]);
  });

  it("rethrows non-not-found stderr", () => {
    const runner = new SpyRunner();
    runner.responses.push({
      match: (a) => a[0] === "kill-pane",
      result: { code: 1, stdout: "", stderr: "permission denied" },
    });
    const mgr = withOpenedPane(runner);
    expect(() => mgr.closeAgentPane("%9")).toThrow(/permission denied/);
  });

  it("no-op when paneId/agentId is unknown", () => {
    const runner = new SpyRunner();
    const mgr = new TmuxManager({ runner });
    expect(() => mgr.closeAgentPane("does-not-exist")).not.toThrow();
    expect(runner.calls).toHaveLength(0);
  });
});

/* ───────────────────── S-508 closeAllPanes ─────────────────────── */

describe("S-508 closeAllPanes (accepts optional sessionName per M5 contract)", () => {
  it("validates sessionName when provided (rejects injection)", () => {
    const runner = new SpyRunner();
    const mgr = new TmuxManager({ runner });
    expect(() => mgr.closeAllPanes("; rm -rf /")).toThrow(InvalidSessionNameError);
    expect(() => mgr.closeAllPanes("with space")).toThrow();
  });

  it("accepts a valid sessionName (no-op when nothing tracked)", () => {
    const runner = new SpyRunner();
    const mgr = new TmuxManager({ runner });
    expect(() => mgr.closeAllPanes("fh-agent-deadbeef")).not.toThrow();
    expect(() => mgr.closeAllPanes("work")).not.toThrow();
    expect(() => mgr.closeAllPanes()).not.toThrow();
  });

  it("closes every tracked pane and clears the map", () => {
    // Make split-window return DIFFERENT pane ids per call so the
    // paneId-keyed tracking Map records both panes.
    let n = 0;
    const runner: TmuxRunner = {
      run(args) {
        if (args[0] === "split-window") {
          n += 1;
          return { code: 0, stdout: `%${n}`, stderr: "" };
        }
        return { code: 0, stdout: "", stderr: "" };
      },
    };
    const mgr = new TmuxManager({ runner });
    for (const agentId of ["dev", "rev"]) {
      mgr.openAgentPane({
        sessionName: "fh-agent-aabbccdd",
        agentId,
        paneTitle: "t",
        logPath: "/tmp/x.log",
      });
    }
    expect(mgr.trackedAgentIds()).toHaveLength(2);
    mgr.closeAllPanes();
    expect(mgr.trackedAgentIds()).toHaveLength(0);
  });

  it("an exception on one pane does not prevent the rest from closing", () => {
    let splitN = 0;
    let killIdx = 0;
    const runner: TmuxRunner = {
      run(args) {
        if (args[0] === "split-window") {
          splitN += 1;
          return { code: 0, stdout: `%${splitN}`, stderr: "" };
        }
        if (args[0] === "kill-pane") {
          killIdx += 1;
          if (killIdx === 1) {
            return { code: 1, stdout: "", stderr: "permission denied" };
          }
          return { code: 0, stdout: "", stderr: "" };
        }
        return { code: 0, stdout: "", stderr: "" };
      },
    };
    const mgr = new TmuxManager({ runner });
    for (const agentId of ["a", "b", "c"]) {
      mgr.openAgentPane({
        sessionName: "fh-agent-aabbccdd",
        agentId,
        paneTitle: "t",
        logPath: "/tmp/x.log",
      });
    }
    mgr.closeAllPanes();
    expect(killIdx).toBe(3);
    expect(mgr.trackedAgentIds()).toHaveLength(0);
  });
});
