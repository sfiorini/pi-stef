import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";

import { createCloakBrowserFetchAdapter, createCloakBrowserRuntime, createCloakBrowserSearchAdapter } from "./browser/cloak";
import { parseFlowSteps, runWebFlow, type FlowStepInput } from "./browser/flow";
import { runWebLogin } from "./browser/login";
import { guardBrowserNavigation } from "./browser/navigation";
import { clearSession, listSessions, writeSessionMetadata } from "./browser/session";
import { loadWebAccessConfig } from "./config";
import { fetchWeb, renderFetchResult } from "./fetch";
import { handleSearchCommand } from "./search";

const searchParams = Type.Object({
  headless: Type.Optional(Type.Boolean()),
  query: Type.String({ description: "Search query." }),
  maxResults: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })),
  profile: Type.Optional(Type.String({ description: "Browser profile name for browser-backed providers." })),
  providers: Type.Optional(
    Type.Array(
      Type.Union([
        Type.Literal("searxng"),
        Type.Literal("searxng-html"),
        Type.Literal("duckduckgo"),
        Type.Literal("google"),
        Type.Literal("bing"),
      ]),
    ),
  ),
  searxngUrl: Type.Optional(Type.String({ description: "Optional SearXNG instance URL." })),
});

const fetchParams = Type.Object({
  url: Type.String({ description: "URL to fetch." }),
  format: Type.Optional(
    Type.Union([Type.Literal("markdown"), Type.Literal("text"), Type.Literal("html"), Type.Literal("json"), Type.Literal("raw")]),
  ),
  headless: Type.Optional(Type.Boolean({ description: "Use headless browser mode for rendered fetches." })),
  mode: Type.Optional(Type.Union([Type.Literal("auto"), Type.Literal("fast"), Type.Literal("browser")])),
  profile: Type.Optional(Type.String({ description: "Browser profile name for rendered fetches." })),
  screenshot: Type.Optional(Type.Boolean({ description: "Capture a screenshot when browser mode is used." })),
  selector: Type.Optional(Type.String({ description: "Optional CSS selector to extract from HTML pages." })),
});

const flowStep = Type.Union([
  Type.Object({ action: Type.Union([Type.Literal("goto"), Type.Literal("navigate"), Type.Literal("open")]), url: Type.String() }),
  Type.Object({
    action: Type.Literal("click"),
    name: Type.Optional(Type.String()),
    role: Type.Optional(Type.String()),
    selector: Type.Optional(Type.String()),
    text: Type.Optional(Type.String()),
  }),
  Type.Object({ action: Type.Union([Type.Literal("type"), Type.Literal("fill")]), selector: Type.Optional(Type.String()), text: Type.String() }),
  Type.Object({
    action: Type.Union([Type.Literal("press"), Type.Literal("keypress"), Type.Literal("key")]),
    key: Type.String(),
    selector: Type.Optional(Type.String()),
  }),
  Type.Object({ action: Type.Literal("wait"), ms: Type.Integer({ minimum: 0, maximum: 120_000 }) }),
  Type.Object({ action: Type.Literal("screenshot"), path: Type.String() }),
  Type.Object({ action: Type.Literal("extract"), count: Type.Optional(Type.Integer({ minimum: 1 })), selector: Type.String() }),
]);

const flowParams = Type.Object({
  headless: Type.Optional(Type.Boolean()),
  instruction: Type.Optional(Type.String({ description: "Natural-language flow instruction." })),
  profile: Type.Optional(Type.String({ description: "Browser profile name." })),
  steps: Type.Optional(Type.Array(flowStep)),
});

const loginParams = Type.Object({
  headless: Type.Optional(Type.Boolean()),
  interactive: Type.Optional(Type.Boolean({ description: "Open a headed browser for manual login." })),
  interactiveWaitMs: Type.Optional(Type.Integer({ minimum: 1000, maximum: 600_000 })),
  passwordEnv: Type.Optional(Type.String({ description: "Environment variable name containing the password." })),
  profile: Type.Optional(Type.String({ description: "Browser profile name." })),
  url: Type.String({ description: "Login URL." }),
  usernameEnv: Type.Optional(Type.String({ description: "Environment variable name containing the username." })),
});

const sessionParams = Type.Object({
  action: Type.Optional(Type.Union([Type.Literal("list"), Type.Literal("inspect"), Type.Literal("locate"), Type.Literal("clear")])),
  profile: Type.Optional(Type.String({ description: "Browser profile name." })),
  yes: Type.Optional(Type.Boolean({ description: "Confirm destructive clear action." })),
});

export function registerWebAccess(pi: ExtensionAPI): void {
  registerTools(pi);
  registerCommands(pi);
}

function registerTools(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "web_search",
    label: "FH Web Search",
    description: "Search the web using no-key provider cascade.",
    promptSnippet: "Search the web with web_search when current public web results are needed.",
    parameters: searchParams,
    execute: async (_toolCallId, params, signal) => {
      const config = await loadWebAccessConfig({
        maxResults: params.maxResults,
        searchProviders: params.providers,
        searxngUrl: params.searxngUrl,
      });
      const text = await handleSearchCommand(params.query, {
        browser: createCloakBrowserSearchAdapter(config, { headless: params.headless ?? true, profile: params.profile }),
        config,
        maxResults: params.maxResults,
        providers: config.searchProviders,
        searxngUrl: params.searxngUrl,
        signal,
      });
      return { content: [{ type: "text", text }], details: { implemented: true } };
    },
  });

  pi.registerTool({
    name: "web_fetch",
    label: "FH Web Fetch",
    description: "Fetch a specific URL through guarded fast fetch or CloakBrowser-rendered access. Requires a url argument.",
    promptSnippet: "Fetch URL content with web_fetch when a specific page needs to be read; include the url argument.",
    promptGuidelines: [
      "If web_fetch fails because the url argument is missing or invalid, retry with an exact URL already present in the conversation or web_search results; if no URL is available, ask the user for the URL.",
      "When a retry or other fetch path retrieves enough content to answer completely, omit intermediate internal web_fetch JSON, schema, missing-url, alternate-method, or fallback details unless the user asks for tool diagnostics.",
    ],
    parameters: fetchParams,
    execute: async (_toolCallId, params, signal) => {
      if (!params.url) {
        return { content: [{ type: "text", text: "Usage: web_fetch { url: string }" }], details: { implemented: true } };
      }
      const config = await loadWebAccessConfig();
      const result = await fetchWeb({
        browser: createCloakBrowserFetchAdapter(config, { headless: params.headless ?? true, profile: params.profile }),
        format: params.format,
        mode: params.mode,
        screenshot: params.screenshot,
        selector: params.selector,
        signal,
        url: params.url,
      });
      return { content: [{ type: "text", text: renderFetchResult(result) }], details: { implemented: true } };
    },
  });

  pi.registerTool({
    name: "web_flow",
    label: "FH Web Flow",
    description: "Run deterministic browser automation steps in a CloakBrowser session.",
    parameters: flowParams,
    execute: async (_toolCallId, params, signal) => {
      const config = await loadWebAccessConfig();
      const steps = params.steps ?? (params.instruction ? parseFlowSteps(params.instruction) : undefined);
      if (!steps?.length) {
        return { content: [{ type: "text", text: "Usage: web_flow { instruction } or { steps }" }], details: { implemented: true } };
      }
      const runtime = await createCloakBrowserRuntime(config, { headless: params.headless ?? true, profile: params.profile });
      const result = await runWebFlow({
        guardNavigation: (url) => guardBrowserNavigation(url, config),
        runtime,
        signal,
        steps: steps as FlowStepInput[],
      });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], details: { implemented: true } };
    },
  });

  pi.registerTool({
    name: "web_login",
    label: "FH Web Login",
    description: "Create or refresh a named browser login profile without raw password tool parameters.",
    parameters: loginParams,
    execute: async (_toolCallId, params, signal) => {
      const config = await loadWebAccessConfig();
      const profile = params.profile ?? "default";
      const runtime = await createCloakBrowserRuntime(config, {
        headless: params.interactive ? false : params.headless ?? true,
        profile,
      });
      const result = await runWebLogin({
        env: process.env,
        guardNavigation: (url) => guardBrowserNavigation(url, config),
        interactive: params.interactive,
        interactiveWaitMs: params.interactiveWaitMs,
        passwordEnv: params.passwordEnv,
        runtime,
        signal,
        url: params.url,
        usernameEnv: params.usernameEnv,
      });
      if (result.success) {
        await writeSessionMetadata(config, profile, { finalUrl: result.finalUrl, updatedAt: new Date().toISOString() });
      }
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], details: { implemented: true } };
    },
  });

  pi.registerTool({
    name: "web_session",
    label: "FH Web Session",
    description: "List, inspect, locate, or clear web browser session profiles.",
    parameters: sessionParams,
    execute: async (_toolCallId, params) => {
      const text = await handleSessionAction(params.action ?? "list", params.profile, params.yes);
      return { content: [{ type: "text", text }], details: { implemented: true } };
    },
  });
}

function registerCommands(pi: ExtensionAPI): void {
  const searchCommand = {
    description: "Search the web with web.",
    handler: async (args: string, ctx: any) => {
      ctx.ui.notify(await handleSearchCommand(args), "info");
    },
  };

  try {
    pi.registerCommand("search", searchCommand);
  } catch {
    pi.registerCommand("web-search", {
      ...searchCommand,
      description: "Search the web with web. Fallback when /search is unavailable.",
    });
  }

  pi.registerCommand("web", {
    description: "Manage web: /web status|sessions|clear-session",
    handler: async (args: string, ctx: any) => {
      ctx.ui.notify(await handleWebCommand(args, ctx.cwd), "info");
    },
  });
}

export async function handleWebCommand(args: string, cwd = process.cwd()): Promise<string> {
  const [command = "status", name, flag] = args.trim().split(/\s+/).filter(Boolean);
  if (command === "status") {
    const config = await loadWebAccessConfig({}, process.env);
    return [
      "web status",
      `cwd: ${cwd}`,
      `profiles: ${config.profilesDir}`,
      `output: ${config.outputDir}`,
      `searxng: ${config.searxngUrl ?? "not configured"}`,
      `allow private networks: ${config.allowPrivateNetworks ? "yes" : "no"}`,
    ].join("\n");
  }
  if (command === "sessions") {
    return handleSessionAction("list");
  }
  if (command === "clear-session") {
    if (!name) return "Usage: /web clear-session <name> [--yes]";
    return handleSessionAction("clear", name, flag === "--yes");
  }
  return "Usage: /web status | /web sessions | /web clear-session <name> [--yes]";
}

async function handleSessionAction(action: string, profile = "default", yes = false): Promise<string> {
  const config = await loadWebAccessConfig();
  if (action === "list") {
    const sessions = await listSessions(config);
    if (sessions.length === 0) return "No sessions.";
    return sessions
      .map((session) => {
        const finalUrl = typeof session.metadata?.finalUrl === "string" ? session.metadata.finalUrl : "unknown";
        const updatedAt = typeof session.metadata?.updatedAt === "string" ? session.metadata.updatedAt : new Date(session.mtimeMs).toISOString();
        return `${session.name}\t${updatedAt}\t${finalUrl}\t${session.path}`;
      })
      .join("\n");
  }
  if (action === "locate" || action === "inspect") {
    const sessions = await listSessions(config);
    const match = sessions.find((session) => session.name === profile);
    if (!match) return `Session not found: ${profile}`;
    if (action === "locate") return match.path;
    return JSON.stringify(match, null, 2);
  }
  if (action === "clear") {
    try {
      const result = await clearSession(config, profile, yes);
      return `Session ${result.name} removed: ${result.path}`;
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }
  return "Usage: web_session { action: list|locate|clear, profile?, yes? }";
}
