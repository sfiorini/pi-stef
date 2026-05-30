/**
 * Extension registration for the catalog extension.
 *
 * Wires all catalog subcommands into pi's extension API as `/ct` commands
 * and `ct_*` tools for LLM invocation.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";

import {
  SUBCOMMAND_DEFS,
  getAliasMap,
} from "./commands/definitions.js";
import { parseSubcommand } from "./commands/dispatch.js";
import { addCommand, type AddCtx } from "./commands/add.js";
import { initCommand, type InitContext } from "./commands/init.js";
import { removeCommand, type RemoveCtx } from "./commands/remove.js";
import {
  toggleCommand,
  enableCommand,
  disableCommand,
  type ToggleCtx,
} from "./commands/toggle.js";
import {
  syncCommand,
  pushCommand,
  pullCommand,
  type SyncCtx,
  type PushPullCtx,
} from "./commands/sync.js";
import { loginCommand, type LoginCtx } from "./commands/login.js";
import type { CommandCtx } from "./commands/types.js";

// ---------------------------------------------------------------------------
// Alias map (derived from shared definitions)
// ---------------------------------------------------------------------------

const aliasMap = getAliasMap();

// ---------------------------------------------------------------------------
// Command handlers (delegate to implementation modules)
// ---------------------------------------------------------------------------

/**
 * Handle a parsed subcommand invocation.
 *
 * Delegates to the appropriate command implementation module.
 */
async function handleSubcommand(
  subcommand: string,
  args: string,
  ctx: CommandCtx,
): Promise<void> {
  const canonical = aliasMap.get(subcommand);
  if (!canonical) {
    ctx.ui.notify(`Unknown subcommand: ${subcommand}`, "error");
    return;
  }

  // Parse the raw argument string into structured { positional, flags }
  const rawParts = (args ?? "").trim().split(/\s+/).filter(Boolean);
  const parsed = parseSubcommand(rawParts);

  switch (canonical) {
    case "add":
      await addCommand(parsed, ctx as AddCtx);
      break;
    case "init":
      await initCommand(parsed, ctx as InitContext);
      break;
    case "remove":
      await removeCommand(parsed, ctx as RemoveCtx);
      break;
    case "sync":
      await syncCommand(parsed, ctx as SyncCtx);
      break;
    case "push":
      await pushCommand(parsed, ctx as PushPullCtx);
      break;
    case "pull":
      await pullCommand(parsed, ctx as PushPullCtx);
      break;
    case "toggle":
      await toggleCommand(parsed, ctx as ToggleCtx);
      break;
    case "enable":
      await enableCommand(parsed, ctx as ToggleCtx);
      break;
    case "disable":
      await disableCommand(parsed, ctx as ToggleCtx);
      break;
    case "login":
      await loginCommand(parsed, ctx as LoginCtx);
      break;
    default:
      ctx.ui.notify(`ct ${canonical}: not yet implemented`, "info");
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Register all catalog commands and tools with the pi extension API.
 *
 * - `/ct` main command with subcommand routing and argument auto-completion
 * - `/ct-sync`, `/ct-init`, … individual alias commands
 * - `ct_sync`, `ct_add`, `ct_remove`, `ct_toggle`, `ct_status` LLM tools
 */
export function registerCatalog(pi: ExtensionAPI): void {
  // ----- /ct main command --------------------------------------------------
  pi.registerCommand("ct", {
    description: "Catalog management: sync, add, remove, toggle, and more",
    getArgumentCompletions(prefix: string) {
      const items = SUBCOMMAND_DEFS.map((s) => ({
        value: s.name,
        label: s.name,
        description: s.description,
      }));
      const filtered = items.filter((i) => i.value.startsWith(prefix));
      return filtered.length > 0 ? filtered : null;
    },
    async handler(args, ctx) {
      const parts = (args ?? "").trim().split(/\s+/);
      const sub = parts[0] || "";
      const rest = parts.slice(1).join(" ");
      await handleSubcommand(sub, rest, ctx);
    },
  });

  // ----- Individual alias commands (e.g. /ct-sync, /ct-init) ---------------
  for (const sub of SUBCOMMAND_DEFS) {
    pi.registerCommand(`ct-${sub.name}`, {
      description: sub.description,
      async handler(args, ctx) {
        await handleSubcommand(sub.name, args ?? "", ctx);
      },
    });
  }

  // ----- LLM tools ---------------------------------------------------------

  pi.registerTool({
    name: "ct_sync",
    label: "Catalog Sync",
    description:
      "Synchronize the catalog with the remote gist. Pushes local changes and pulls remote changes, resolving conflicts.",
    promptSnippet: "Sync catalog with remote",
    promptGuidelines: [
      "Use ct_sync when the user asks to sync their catalog or when catalog state may be stale.",
    ],
    parameters: Type.Object({
      force: Type.Optional(Type.Boolean({ description: "Force sync even if no changes detected" })),
    }),
    async execute(_toolCallId, _params, _signal, _onUpdate, _ctx) {
      // Implementation delegation wired in later milestone
      return {
        content: [{ type: "text" as const, text: "ct_sync: not yet implemented" }],
        details: undefined as unknown,
      };
    },
  });

  pi.registerTool({
    name: "ct_add",
    label: "Catalog Add",
    description:
      "Add a package to the catalog by name and source. Source must start with 'npm:' or 'git:'.",
    promptSnippet: "Add a package to the catalog",
    promptGuidelines: [
      "Use ct_add when the user asks to add a new package or skill to their catalog.",
    ],
    parameters: Type.Object({
      name: Type.String({ description: "Package name" }),
      source: Type.String({ description: "Package source (npm:… or git:…)" }),
      rating: Type.Optional(Type.String({ description: "Initial rating (core, useful, debatable)" })),
    }),
    async execute(_toolCallId, _params, _signal, _onUpdate, _ctx) {
      return {
        content: [{ type: "text" as const, text: "ct_add: not yet implemented" }],
        details: undefined as unknown,
      };
    },
  });

  pi.registerTool({
    name: "ct_remove",
    label: "Catalog Remove",
    description: "Remove a package from the catalog by name.",
    promptSnippet: "Remove a package from the catalog",
    promptGuidelines: [
      "Use ct_remove when the user asks to remove or uninstall a package from their catalog.",
    ],
    parameters: Type.Object({
      name: Type.String({ description: "Package name to remove" }),
    }),
    async execute(_toolCallId, _params, _signal, _onUpdate, _ctx) {
      return {
        content: [{ type: "text" as const, text: "ct_remove: not yet implemented" }],
        details: undefined as unknown,
      };
    },
  });

  pi.registerTool({
    name: "ct_toggle",
    label: "Catalog Toggle",
    description:
      "Toggle a package's rating through the cycle: core → useful → debatable → disabled → core.",
    promptSnippet: "Toggle a package's catalog rating",
    promptGuidelines: [
      "Use ct_toggle when the user wants to cycle a package's rating.",
    ],
    parameters: Type.Object({
      name: Type.String({ description: "Package name to toggle" }),
    }),
    async execute(_toolCallId, _params, _signal, _onUpdate, _ctx) {
      return {
        content: [{ type: "text" as const, text: "ct_toggle: not yet implemented" }],
        details: undefined as unknown,
      };
    },
  });

  pi.registerTool({
    name: "ct_status",
    label: "Catalog Status",
    description: "Show the current catalog status including package counts and sync state.",
    promptSnippet: "Show catalog status",
    promptGuidelines: [
      "Use ct_status when the user wants to check catalog health, package counts, or sync state.",
    ],
    parameters: Type.Object({
      verbose: Type.Optional(Type.Boolean({ description: "Show detailed status" })),
    }),
    async execute(_toolCallId, _params, _signal, _onUpdate, _ctx) {
      return {
        content: [{ type: "text" as const, text: "ct_status: not yet implemented" }],
        details: undefined as unknown,
      };
    },
  });
}
