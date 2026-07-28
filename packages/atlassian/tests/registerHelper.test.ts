import { describe, expect, it } from "vitest";

import { registerTool } from "../src/tools/register-helper";

function fakePi() {
  const tools: Array<{ name: string; execute: (id: string, params: any, signal?: AbortSignal) => Promise<any> }> = [];
  return {
    tools,
    registerTool: (tool: any) => {
      tools.push(tool);
    },
  };
}

describe("registerTool void/204 handling", () => {
  it("returns a success message with the identifier when execute resolves to undefined", async () => {
    const pi = fakePi();
    registerTool(pi as never, "jira_update_issue", "Update a Jira issue.", {}, async () => undefined);

    const tool = pi.tools[0]!;
    const result = await tool.execute("call-1", { issueIdOrKey: "ABC-1" });

    expect(result.content[0].text).toBe("jira_update_issue succeeded (ABC-1).");
    expect(result.details).toBeUndefined();
  });

  it("returns a bare success message when execute resolves to undefined and no identifier is present", async () => {
    const pi = fakePi();
    registerTool(pi as never, "cleanup", "Cleanup.", {}, async () => undefined);

    const tool = pi.tools[0]!;
    const result = await tool.execute("call-2", {});

    expect(result.content[0].text).toBe("cleanup succeeded.");
    expect(result.details).toBeUndefined();
  });

  it("joins array identifiers with a comma when execute resolves to undefined", async () => {
    const pi = fakePi();
    registerTool(pi as never, "rank", "Rank issues.", {}, async () => undefined);

    const tool = pi.tools[0]!;
    const result = await tool.execute("call-3", { issues: ["ABC-1", "ABC-2"] });

    expect(result.content[0].text).toBe("rank succeeded (ABC-1, ABC-2).");
    expect(result.details).toBeUndefined();
  });

  it("JSON-serializes object results and forwards them as details", async () => {
    const pi = fakePi();
    registerTool(pi as never, "jira_get_issue", "Get a Jira issue.", {}, async () => ({ key: "ABC-1" }));

    const tool = pi.tools[0]!;
    const result = await tool.execute("call-4", { issueIdOrKey: "ABC-1" });

    expect(result.content[0].text).toBe(JSON.stringify({ key: "ABC-1" }, null, 2));
    expect(result.details).toEqual({ key: "ABC-1" });
  });

  it("propagates errors thrown by execute", async () => {
    const pi = fakePi();
    registerTool(pi as never, "boom", "Boom.", {}, async () => {
      throw new Error("kaboom");
    });

    const tool = pi.tools[0]!;
    await expect(tool.execute("call-5", {})).rejects.toThrow("kaboom");
  });

  it("stringifies numeric identifiers in the success message", async () => {
    const pi = fakePi();
    registerTool(pi as never, "jira_delete_board", "Delete a board.", {}, async () => undefined);

    const tool = pi.tools[0]!;
    const result = await tool.execute("call-6", { boardId: 7 });

    expect(result.content[0].text).toBe("jira_delete_board succeeded (7).");
    expect(result.details).toBeUndefined();
  });
});
