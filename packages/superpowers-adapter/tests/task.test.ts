import { describe, it, expect } from "vitest";
import { createMockAPI, executeTool, getToolByName } from "./helpers/mock-api.js";
import { registerTaskTool } from "../src/tools/task.js";

describe("Task tool", () => {
  it("registers the tool", () => {
    const mockApi = createMockAPI();
    registerTaskTool(mockApi as any);
    const tool = getToolByName(mockApi, "Task");
    expect(tool).toBeDefined();
    expect(tool!.label).toBe("Task");
  });

  it("returns error when Agent tool is not available", async () => {
    const mockApi = createMockAPI([]); // no tools
    registerTaskTool(mockApi as any);
    const result = await executeTool(mockApi, "Task", {
      subagent_type: "Explore",
      prompt: "Find auth files",
      description: "Find auth files",
    }) as any;

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("pi-subagents");
  });

  it("redirects to Agent tool when available", async () => {
    const mockApi = createMockAPI(["Agent"]); // Agent tool present
    registerTaskTool(mockApi as any);
    const result = await executeTool(mockApi, "Task", {
      subagent_type: "Explore",
      prompt: "Find auth files",
      description: "Find auth files",
    }) as any;

    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain("Agent");
    expect(result.content[0].text).toContain("Explore");
  });
});
