import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadFinanceConfig } from "./config";
import { createFinanceClient } from "./client";
import { formatHoldings, formatDrift, formatSuggestions, formatGeneric } from "./output";

const NEVER_RECOMPUTE_GUIDELINE = "These numbers are computed by the service. Never recompute prices, allocations, or drift yourself — cite the returned values verbatim. When recommending an instrument, justify it against the engine's gap.";

export function registerFinanceTools(pi: ExtensionAPI): void {
  // Helper to get client
  async function getClient() {
    const config = await loadFinanceConfig();
    return createFinanceClient({ apiUrl: config.apiUrl, token: config.token });
  }

  // Market Status
  pi.registerTool({
    name: "sf_fin_market_status",
    label: "Market Status",
    description: "Get current US market session (pre/intraday/post/closed)",
    parameters: {},
    promptSnippet: "Check if the US stock market is currently open.",
    promptGuidelines: [NEVER_RECOMPUTE_GUIDELINE],
    execute: async () => {
      const client = await getClient();
      const data = await client.callOp<{ session: string; timestamp: number }>("market_status");
      return { content: [{ type: "text", text: `Market session: ${data.session}` }], details: { implemented: true } };
    },
  });

  // Get Holdings
  pi.registerTool({
    name: "sf_fin_get_holdings",
    label: "Get Holdings",
    description: "Get all account holdings with quantities and asset classes",
    parameters: {},
    promptSnippet: "Retrieve current portfolio holdings across all accounts.",
    promptGuidelines: [NEVER_RECOMPUTE_GUIDELINE],
    execute: async () => {
      const client = await getClient();
      const data = await client.callOp("get_holdings");
      return { content: [{ type: "text", text: formatHoldings(data as Parameters<typeof formatHoldings>[0]) }], details: { implemented: true } };
    },
  });

  // Get Net Worth
  pi.registerTool({
    name: "sf_fin_get_net_worth",
    label: "Get Net Worth",
    description: "Get total portfolio value across all accounts",
    parameters: {},
    promptSnippet: "Calculate total portfolio value.",
    promptGuidelines: [NEVER_RECOMPUTE_GUIDELINE],
    execute: async () => {
      const client = await getClient();
      const data = await client.callOp<{ netWorth: number; accountCount: number }>("get_net_worth");
      return { content: [{ type: "text", text: `Net Worth: $${data.netWorth.toLocaleString()} (${data.accountCount} accounts)` }], details: { implemented: true } };
    },
  });

  // Get Drift
  pi.registerTool({
    name: "sf_fin_get_drift",
    label: "Get Drift",
    description: "Get allocation drift vs target",
    parameters: {},
    promptSnippet: "Check portfolio drift from target allocation.",
    promptGuidelines: [NEVER_RECOMPUTE_GUIDELINE],
    execute: async () => {
      const client = await getClient();
      const data = await client.callOp("get_drift");
      return { content: [{ type: "text", text: formatDrift(data as Parameters<typeof formatDrift>[0]) }], details: { implemented: true } };
    },
  });

  // Get Allocation
  pi.registerTool({
    name: "sf_fin_get_allocation",
    label: "Get Allocation",
    description: "Get current asset allocation by class",
    parameters: {},
    promptSnippet: "View current asset allocation breakdown.",
    promptGuidelines: [NEVER_RECOMPUTE_GUIDELINE],
    execute: async () => {
      const client = await getClient();
      const data = await client.callOp<{ allocation: Record<string, number>; totalValue: number }>("get_allocation");
      const lines = Object.entries(data.allocation).map(([cls, pct]) => `  ${cls}: ${(pct * 100).toFixed(1)}%`);
      return { content: [{ type: "text", text: `Asset Allocation (Total: $${data.totalValue.toLocaleString()}):\n${lines.join("\n")}` }], details: { implemented: true } };
    },
  });

  // List Goals
  pi.registerTool({
    name: "sf_fin_list_goals",
    label: "List Goals",
    description: "List investment goals with target allocations",
    parameters: {},
    promptSnippet: "View configured investment goals.",
    promptGuidelines: [NEVER_RECOMPUTE_GUIDELINE],
    execute: async () => {
      const client = await getClient();
      const data = await client.callOp<{ goals: { id: string; name: string; targetAllocation: Record<string, number> }[] }>("list_goals");
      if (data.goals.length === 0) return { content: [{ type: "text", text: "No goals configured" }], details: { implemented: true } };
      const lines = data.goals.map((g) => `${g.name}: ${JSON.stringify(g.targetAllocation)}`);
      return { content: [{ type: "text", text: `Investment Goals:\n${lines.join("\n")}` }], details: { implemented: true } };
    },
  });

  // Set Target
  pi.registerTool({
    name: "sf_fin_set_target",
    label: "Set Target",
    description: "Create or update an investment goal",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string", description: "Goal ID" },
        name: { type: "string", description: "Goal name" },
        targetAllocation: { type: "object", description: "Target allocation by asset class (must sum to ~1.0)" },
        riskLimits: { type: "object", description: "Risk limits (e.g., maxSinglePosition, maxCashDrag)" },
        horizonYears: { type: "number", description: "Investment horizon in years" },
      },
      required: ["id", "name", "targetAllocation"],
    },
    promptSnippet: "Create or update an investment goal with target allocation.",
    promptGuidelines: [NEVER_RECOMPUTE_GUIDELINE],
    execute: async (params) => {
      const client = await getClient();
      const data = await client.callOp<{ id: string }>("set_target", params as Record<string, unknown>);
      return { content: [{ type: "text", text: `Goal ${data.id} saved` }], details: { implemented: true } };
    },
  });

  // Get Suggestions
  pi.registerTool({
    name: "sf_fin_get_suggestions",
    label: "Get Suggestions",
    description: "Get pending investment suggestions from the quant engine",
    parameters: {},
    promptSnippet: "Retrieve deterministic suggestions from the quant engine.",
    promptGuidelines: [NEVER_RECOMPUTE_GUIDELINE],
    execute: async () => {
      const client = await getClient();
      const data = await client.callOp("get_suggestions");
      return { content: [{ type: "text", text: formatSuggestions(data as Parameters<typeof formatSuggestions>[0]) }], details: { implemented: true } };
    },
  });

  // Dismiss Suggestion
  pi.registerTool({
    name: "sf_fin_dismiss_suggestion",
    label: "Dismiss Suggestion",
    description: "Dismiss a pending suggestion",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string", description: "Suggestion ID to dismiss" },
      },
      required: ["id"],
    },
    promptSnippet: "Dismiss a suggestion that's been addressed.",
    promptGuidelines: [NEVER_RECOMPUTE_GUIDELINE],
    execute: async (params) => {
      const client = await getClient();
      await client.callOp("dismiss_suggestion", params as Record<string, unknown>);
      return { content: [{ type: "text", text: `Suggestion dismissed` }], details: { implemented: true } };
    },
  });

  // Sync Now
  pi.registerTool({
    name: "sf_fin_sync_now",
    label: "Sync Now",
    description: "Trigger immediate data sync from all providers",
    parameters: {},
    promptSnippet: "Force an immediate sync of account data.",
    promptGuidelines: [NEVER_RECOMPUTE_GUIDELINE],
    execute: async () => {
      const client = await getClient();
      const data = await client.callOp<{ message: string }>("sync_now");
      return { content: [{ type: "text", text: data.message }], details: { implemented: true } };
    },
  });

  // Import File
  pi.registerTool({
    name: "sf_fin_import_file",
    label: "Import File",
    description: "Import holdings from a CSV/OFX file",
    parameters: {
      type: "object",
      properties: {
        filePath: { type: "string", description: "Path to CSV/OFX file" },
      },
      required: ["filePath"],
    },
    promptSnippet: "Import holdings from a file export.",
    promptGuidelines: [NEVER_RECOMPUTE_GUIDELINE],
    execute: async (params) => {
      const client = await getClient();
      const data = await client.callOp<{ message: string; filePath: string }>("import_file", params as Record<string, unknown>);
      return { content: [{ type: "text", text: `${data.message}: ${data.filePath}` }], details: { implemented: true } };
    },
  });

  // History
  pi.registerTool({
    name: "sf_fin_history",
    label: "Price History",
    description: "Get price history for a symbol",
    parameters: {
      type: "object",
      properties: {
        symbol: { type: "string", description: "Ticker symbol (e.g., AAPL, CRYPTO:BTC)" },
        accountId: { type: "string", description: "Optional account ID filter" },
      },
      required: ["symbol"],
    },
    promptSnippet: "View price history for a security.",
    promptGuidelines: [NEVER_RECOMPUTE_GUIDELINE],
    execute: async (params) => {
      const client = await getClient();
      const data = await client.callOp("history", params as Record<string, unknown>);
      return { content: [{ type: "text", text: formatGeneric(data) }], details: { implemented: true } };
    },
  });
}
