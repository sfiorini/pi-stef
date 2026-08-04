import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// Mock the two collaborators so we test sf_flow_prepare's wiring without git.
vi.mock("../src/worktree/create.js", () => ({ createWorktree: vi.fn() }));
vi.mock("../src/config/load.js", () => ({ loadAndResolveDefaults: vi.fn() }));

import { registerSfFlow } from "../src/register.js";
import { createWorktree } from "../src/worktree/create.js";
import { loadAndResolveDefaults } from "../src/config/load.js";

const mockCreate = vi.mocked(createWorktree);
const mockDefaults = vi.mocked(loadAndResolveDefaults);

function captureTool(name: string) {
  const tools = new Map<string, any>();
  const pi = {
    registerTool: vi.fn((def: any) => tools.set(def.name, def)),
    registerCommand: vi.fn(),
  } as unknown as ExtensionAPI;
  registerSfFlow(pi);
  return tools.get(name);
}

describe("sf_flow_prepare tool", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDefaults.mockResolvedValue({ worktree: { branch_prefix: "flow/" } } as any);
  });

  it("returns the worktree handle (worktreePath/branchName/baseSha) on success", async () => {
    mockCreate.mockResolvedValue({
      worktreePath: "/repo/.worktrees/flow-x",
      branchName: "flow/x",
      baseSha: "abc123",
    });
    const tool = captureTool("sf_flow_prepare");
    const res = await tool.execute("id", { slug: "x" }, undefined, undefined, { cwd: "/repo" });
    expect(res.details).toEqual({
      worktreePath: "/repo/.worktrees/flow-x",
      branchName: "flow/x",
      baseSha: "abc123",
    });
    // ctx.cwd flows through to loadAndResolveDefaults + createWorktree with the configured prefix
    expect(mockDefaults).toHaveBeenCalledWith("/repo");
    expect(mockCreate).toHaveBeenCalledWith({ slug: "x", branchPrefix: "flow/" });
  });

  it("returns a structured error (does not throw) when createWorktree fails", async () => {
    mockCreate.mockRejectedValue(new Error("not a git repo"));
    const tool = captureTool("sf_flow_prepare");
    const res = await tool.execute("id", { slug: "y" }, undefined, undefined, { cwd: "/nope" });
    expect(res.details).toHaveProperty("error");
    expect(JSON.stringify(res.details)).toMatch(/not a git repo/);
  });
});
