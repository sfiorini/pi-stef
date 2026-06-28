import { describe, it, expect } from "vitest";
import { registerFinanceTools } from "../src/tools";

// Mock ExtensionAPI that captures registerTool calls
interface ToolRegistration {
  name: string;
  label: string;
  description: string;
  parameters: unknown;
  promptSnippet?: string;
  promptGuidelines?: string[];
  execute: Function;
}

function createMockPi() {
  const tools: ToolRegistration[] = [];
  return {
    registerTool: (tool: ToolRegistration) => { tools.push(tool); },
    getTools: () => tools,
  };
}

describe("tool wiring", () => {
  it("registers all expected sf_fin_* tools", () => {
    const pi = createMockPi();
    registerFinanceTools(pi as never);

    const toolNames = pi.getTools().map((t) => t.name);
    const expectedTools = [
      "sf_fin_market_status",
      "sf_fin_get_holdings",
      "sf_fin_get_net_worth",
      "sf_fin_get_drift",
      "sf_fin_get_allocation",
      "sf_fin_list_goals",
      "sf_fin_set_target",
      "sf_fin_get_suggestions",
      "sf_fin_dismiss_suggestion",
      "sf_fin_sync_now",
      "sf_fin_import_file",
      "sf_fin_history",
    ];

    for (const expected of expectedTools) {
      expect(toolNames).toContain(expected);
    }
  });

  it("each tool has required fields", () => {
    const pi = createMockPi();
    registerFinanceTools(pi as never);

    for (const tool of pi.getTools()) {
      expect(tool.name).toBeTruthy();
      expect(tool.label).toBeTruthy();
      expect(tool.description).toBeTruthy();
      expect(typeof tool.execute).toBe("function");
    }
  });

  it("each tool has promptGuidelines with never-recompute invariant", () => {
    const pi = createMockPi();
    registerFinanceTools(pi as never);

    for (const tool of pi.getTools()) {
      expect(tool.promptGuidelines).toBeDefined();
      expect(tool.promptGuidelines!.length).toBeGreaterThan(0);
      expect(tool.promptGuidelines![0]).toContain("Never recompute");
    }
  });
});
