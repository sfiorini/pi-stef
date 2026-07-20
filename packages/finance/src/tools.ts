import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { loadFinanceConfig, saveProviderConfig } from "./config";
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
    parameters: {
      type: "object",
      properties: {},
    },
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
    description: "All account holdings with quantities, prices, and market values. Supports optional filtering by accountId or symbol.",
    parameters: {
      type: "object",
      properties: {
        accountId: { type: "string", description: "Filter to a single account ID" },
        symbol: { type: "string", description: "Filter to a single ticker symbol (e.g. AAPL) across all accounts" },
      },
      required: [],
    },
    promptSnippet: "Retrieve portfolio holdings with prices and market values, optionally filtered by account or symbol.",
    promptGuidelines: [NEVER_RECOMPUTE_GUIDELINE],
    execute: async (_toolCallId, params) => {
      const p = (params ?? {}) as { accountId?: string; symbol?: string };
      const client = await getClient();
      const data = await client.callOp("get_holdings", { accountId: p.accountId, symbol: p.symbol });
      return { content: [{ type: "text", text: formatHoldings(data as Parameters<typeof formatHoldings>[0]) }], details: { implemented: true } };
    },
  });

  // Get Net Worth
  pi.registerTool({
    name: "sf_fin_get_net_worth",
    label: "Get Net Worth",
    description: "Get total portfolio value across all accounts",
    parameters: {
      type: "object",
      properties: {},
    },
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
    parameters: {
      type: "object",
      properties: {},
    },
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
    parameters: {
      type: "object",
      properties: {},
    },
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
    parameters: {
      type: "object",
      properties: {},
    },
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
    execute: async (_toolCallId, params) => {
      const p = (params ?? {}) as { id?: string; name?: string; targetAllocation?: object; riskLimits?: object; horizonYears?: number };
      const client = await getClient();
      const data = await client.callOp<{ id: string }>("set_target", p as unknown as Record<string, unknown>);
      return { content: [{ type: "text", text: `Goal ${data.id} saved` }], details: { implemented: true } };
    },
  });

  // Get Suggestions
  pi.registerTool({
    name: "sf_fin_get_suggestions",
    label: "Get Suggestions",
    description: "Get pending investment suggestions from the quant engine",
    parameters: {
      type: "object",
      properties: {},
    },
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
    execute: async (_toolCallId, params) => {
      const p = (params ?? {}) as { id?: string };
      const client = await getClient();
      await client.callOp("dismiss_suggestion", { id: p.id });
      return { content: [{ type: "text", text: `Suggestion dismissed` }], details: { implemented: true } };
    },
  });

  // Sync Now
  pi.registerTool({
    name: "sf_fin_sync_now",
    label: "Sync Now",
    description: "Trigger a data sync. Pass provider to sync one provider (e.g. 'snaptrade'); omit to sync all providers.",
    parameters: {
      type: "object",
      properties: {
        provider: { type: "string", description: "Provider ID to sync (e.g. 'snaptrade'). Omit to sync all providers." },
      },
      required: [],
    },
    promptSnippet: "Force an immediate sync of account data.",
    promptGuidelines: [NEVER_RECOMPUTE_GUIDELINE],
    execute: async (_toolCallId, params) => {
      // Diverges from the getClient() helper used by other tools: this tool needs
      // access to config.providers.* to attach per-call credentials.
      const config = await loadFinanceConfig();
      const client = createFinanceClient({ apiUrl: config.apiUrl, token: config.token });
      const body: Record<string, unknown> = {};
      const provider = ((params ?? {}) as { provider?: string })?.provider;
      if (provider) body.providers = [provider];
      // Send credentials for all configured providers
      const credentials: Record<string, unknown> = {};
      if (config.providers?.snaptrade) {
        credentials.snaptrade = config.providers.snaptrade;
      }
      if (config.providers?.simplefin) {
        const sf = config.providers.simplefin;
        credentials.simplefin = sf.setupToken ? { setupToken: sf.setupToken } : sf.accessUrl ? { accessUrl: sf.accessUrl } : {};
      }
      if (Object.keys(credentials).length) {
        body.credentials = credentials;
      }
      const data = await client.callOp<{ message: string; resolvedCredentials?: { simplefin?: { accessUrl?: string } } }>("sync_now", Object.keys(body).length ? body : undefined);
      // Persist resolved credentials (e.g., SimpleFIN accessUrl after setup token exchange)
      if (data.resolvedCredentials?.simplefin?.accessUrl) {
        try {
          await saveProviderConfig("simplefin", { accessUrl: data.resolvedCredentials.simplefin.accessUrl });
        } catch {
          // Best-effort — don't fail the sync if config write fails
        }
      }
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
    execute: async (_toolCallId, params) => {
      const p = (params ?? {}) as { filePath?: string };
      const client = await getClient();
      // Read the file locally (on the machine running pi) and send contents to the server.
      // This supports remote finance-api deployments where the file doesn't exist on the server.
      const { readFile } = await import("node:fs/promises");
      const { basename } = await import("node:path");
      const content = await readFile(p.filePath!, "utf8");
      const filename = basename(p.filePath!);
      const data = await client.callOp<{ message: string; filePath: string }>("import_file", { content, filename });
      return { content: [{ type: "text", text: `${data.message}: ${p.filePath}` }], details: { implemented: true } };
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
    execute: async (_toolCallId, params) => {
      const p = (params ?? {}) as { symbol?: string; accountId?: string };
      const client = await getClient();
      const data = await client.callOp("history", { symbol: p.symbol, accountId: p.accountId });
      return { content: [{ type: "text", text: formatGeneric(data) }], details: { implemented: true } };
    },
  });

  // ── Slash commands: route /sf-fin-* to the sf_fin_* tools ──────────────
  const send =
    typeof pi.sendUserMessage === "function"
      ? pi.sendUserMessage.bind(pi) as ((content: string, opts?: { deliverAs?: "steer" | "followUp" }) => void) | undefined
      : undefined;

  const slashDescriptions: Record<string, string> = {
    sf_fin_market_status: "Get current US market session (pre/intraday/post/closed)",
    sf_fin_get_holdings: "Get all account holdings. Args: optional symbol filter",
    sf_fin_get_net_worth: "Get total portfolio value across all accounts",
    sf_fin_get_drift: "Get allocation drift vs target",
    sf_fin_get_allocation: "Get current asset allocation by class",
    sf_fin_list_goals: "List investment goals with target allocations",
    sf_fin_set_target: "Create or update an investment goal (wizard — agent gathers params)",
    sf_fin_get_suggestions: "Get pending suggestions from the quant engine",
    sf_fin_dismiss_suggestion: "Dismiss a pending suggestion. Args: suggestion ID",
    sf_fin_sync_now: "Trigger a data sync. Args: optional provider (snaptrade, simplefin)",
    sf_fin_import_file: "Import holdings from a CSV/OFX file. Args: file path",
    sf_fin_history: "Get price history for a symbol. Args: ticker symbol (e.g. AAPL)",
  };

  // Tools that take no parameters — the slash command just delegates.
  const NO_ARG_TOOLS = new Set([
    "sf_fin_market_status",
    "sf_fin_get_net_worth",
    "sf_fin_get_drift",
    "sf_fin_get_allocation",
    "sf_fin_list_goals",
    "sf_fin_get_suggestions",
  ]);

  for (const name of Object.keys(slashDescriptions)) {
    const slashName = name.replace(/_/g, "-");
    const desc = slashDescriptions[name] ?? name;

    pi.registerCommand(slashName, {
      description: desc,
      handler: async (args: string, ctx: ExtensionCommandContext) => {
        const trimmed = args.trim();
        let message: string;

        if (NO_ARG_TOOLS.has(name)) {
          message = `Invoke the ${name} tool.`;
        } else if (name === "sf_fin_get_holdings") {
          message = trimmed.length === 0
            ? "Invoke the sf_fin_get_holdings tool."
            : `Invoke the sf_fin_get_holdings tool with symbol: ${trimmed}`;
        } else if (name === "sf_fin_sync_now") {
          message = trimmed.length === 0
            ? "Invoke the sf_fin_sync_now tool to sync all providers."
            : `Invoke the sf_fin_sync_now tool with provider: ${trimmed}`;
        } else if (name === "sf_fin_import_file") {
          message = trimmed.length === 0
            ? "Invoke the sf_fin_import_file tool. Ask me for the file path."
            : `Invoke the sf_fin_import_file tool with filePath: ${trimmed}`;
        } else if (name === "sf_fin_history") {
          message = trimmed.length === 0
            ? "Invoke the sf_fin_history tool. Ask me for the symbol."
            : `Invoke the sf_fin_history tool with symbol: ${trimmed}`;
        } else if (name === "sf_fin_dismiss_suggestion") {
          message = trimmed.length === 0
            ? "Invoke the sf_fin_dismiss_suggestion tool. Ask me for the suggestion ID."
            : `Invoke the sf_fin_dismiss_suggestion tool with id: ${trimmed}`;
        } else {
          // sf_fin_set_target (wizard — too complex for positional args)
          message = "Invoke the sf_fin_set_target tool to create or update an investment goal.";
        }

        if (!send) {
          ctx.ui?.notify?.(
            `finance: this pi runtime can't post slash-command output to the agent. Type "${slashName} ${trimmed}" instead.`,
            "warning",
          );
          return;
        }

        const idle = typeof ctx.isIdle === "function" ? ctx.isIdle() : true;
        if (idle) {
          send(message);
        } else {
          send(message, { deliverAs: "followUp" });
        }
      },
    });
  }
}
