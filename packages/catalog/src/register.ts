/**
 * Extension registration for the catalog extension.
 *
 * Wires all catalog subcommands into pi's extension API as `/ct` commands
 * and `ct_*` tools for LLM invocation.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

// ---------------------------------------------------------------------------
// Subcommand definitions
// ---------------------------------------------------------------------------

interface SubcommandDef {
  name: string;
  aliases?: string[];
  description: string;
}

const SUBCOMMANDS: SubcommandDef[] = [
  { name: "sync", description: "Sync catalog with remote gist" },
  { name: "init", description: "Initialize a new catalog" },
  { name: "add", aliases: ["a"], description: "Add a package to the catalog" },
  { name: "remove", aliases: ["rm"], description: "Remove a package from the catalog" },
  { name: "toggle", description: "Toggle a package's rating" },
  { name: "disable", description: "Disable a package" },
  { name: "enable", description: "Enable a package" },
  { name: "push", description: "Push catalog to remote gist" },
  { name: "pull", description: "Pull catalog from remote gist" },
  { name: "login", description: "Authenticate with GitHub for sync" },
  { name: "status", description: "Show catalog status" },
  { name: "diff", description: "Show diff between local and remote catalog" },
  { name: "verify", description: "Verify catalog integrity" },
  { name: "profiles", description: "List available profiles" },
  { name: "profile", description: "Show or switch active profile" },
];

/** Build a lookup map from subcommand name or alias → canonical name. */
function buildAliasMap(): Map<string, string> {
  const map = new Map<string, string>();
  for (const sub of SUBCOMMANDS) {
    map.set(sub.name, sub.name);
    for (const alias of sub.aliases ?? []) {
      map.set(alias, sub.name);
    }
  }
  return map;
}

const aliasMap = buildAliasMap();

// ---------------------------------------------------------------------------
// Command handlers (delegate to implementation modules)
// ---------------------------------------------------------------------------

/**
 * Handle a parsed subcommand invocation.
 *
 * Currently a thin shim that notifies the user. Full implementation
 * delegation will be wired in subsequent stories.
 */
async function handleSubcommand(
  subcommand: string,
  _args: string,
  ctx: { ui: { notify: (msg: string, level: string) => void } },
): Promise<void> {
  const canonical = aliasMap.get(subcommand);
  if (!canonical) {
    ctx.ui.notify(`Unknown subcommand: ${subcommand}`, "error");
    return;
  }

  // Story S-502 will add real dispatcher logic here.
  ctx.ui.notify(`ct ${canonical}: not yet implemented`, "info");
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
      const items = SUBCOMMANDS.map((s) => ({
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
  for (const sub of SUBCOMMANDS) {
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
        content: [{ type: "text", text: "ct_sync: not yet implemented" }],
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
        content: [{ type: "text", text: "ct_add: not yet implemented" }],
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
        content: [{ type: "text", text: "ct_remove: not yet implemented" }],
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
        content: [{ type: "text", text: "ct_toggle: not yet implemented" }],
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
        content: [{ type: "text", text: "ct_status: not yet implemented" }],
      };
    },
  });
}
