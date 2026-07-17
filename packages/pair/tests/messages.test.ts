import { describe, it, expect } from "vitest";
import { buildImplementReadyMessage, skillDocPath } from "../src/messages";

describe("buildImplementReadyMessage", () => {
  const base = {
    reviewerModel: "anthropic/claude-opus-4-8",
    planPath: "2026-06-21-digeng-8131-smb",
    worktreePath: "/Users/me/proj/pair-digeng",
    branchName: "pair/digeng",
    baseSha: "6a31cae",
  };

  it("leads with a continue-now directive, not status", () => {
    const msg = buildImplementReadyMessage(base);
    // The first line must be the directive; the factual context must not lead.
    expect(msg.startsWith("Continue executing now")).toBe(true);
    expect(msg.startsWith("Reviewer configured")).toBe(false);
  });

  it("includes the literal cd command with the worktree path", () => {
    const msg = buildImplementReadyMessage(base);
    expect(msg).toContain("cd /Users/me/proj/pair-digeng");
  });

  it("tells the agent to read and execute the sf-pair-implement skill file in full", () => {
    const msg = buildImplementReadyMessage(base);
    expect(msg).toContain(skillDocPath("sf-pair-implement"));
    expect(msg).toMatch(/do not stop between milestones|do not ask for confirmation/i);
  });

  it("includes the sf_pair_finalize hint with the worktree path", () => {
    const msg = buildImplementReadyMessage(base);
    expect(msg).toContain("sf_pair_finalize");
    expect(msg).toContain('worktree_path "/Users/me/proj/pair-digeng"');
  });

  it("demotes factual context to a Context block (model, path, branch, base)", () => {
    const msg = buildImplementReadyMessage(base);
    expect(msg).toContain("Context:");
    expect(msg).toContain("- Reviewer model: anthropic/claude-opus-4-8");
    expect(msg).toContain("- Plan path: 2026-06-21-digeng-8131-smb");
    expect(msg).toContain("- Branch: pair/digeng (base 6a31cae)");
  });

  it("appends an Agent warning block when warnings are provided", () => {
    const msg = buildImplementReadyMessage({ ...base, warnings: ["stale reviewer.md"] });
    expect(msg).toContain("⚠️ Agent warning:");
    expect(msg).toContain("- stale reviewer.md");
  });

  it("omits the warning block when no warnings are provided", () => {
    const msg = buildImplementReadyMessage(base);
    expect(msg).not.toContain("⚠️ Agent warning:");
  });
});
