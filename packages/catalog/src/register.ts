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
import { addCommand, type AddCtx } from "./commands/add.js";
import { initCommand, type InitContext } from "./commands/init.js";
import { removeCommand, type RemoveCtx } from "./commands/remove.js";
import { updateCommand } from "./commands/update.js";
import { resetCommand, type ResetCtx } from "./commands/reset.js";
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
import { statusCommand, type StatusCtx } from "./commands/status.js";
import { diffCommand, type DiffCtx } from "./commands/diff.js";
import { verifyCommand, type VerifyCtx } from "./commands/verify.js";
import {
  profilesCommand,
  profileCommand,
  type ProfilesCtx,
} from "./commands/profiles.js";
import type { CommandArgs, CommandCtx } from "./commands/types.js";

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

  // Parse the raw argument string into structured { positional, flags }.
  // Note: the subcommand has already been extracted by the /ct handler,
  // so we only parse flags from the remaining args — positional tokens
  // are passed through directly.
  const rawParts = (args ?? "").trim().split(/\s+/).filter(Boolean);
  const flags: Record<string, true | string> = {};
  const positional: string[] = [];
  for (const token of rawParts) {
    if (token.startsWith("--")) {
      const body = token.slice(2);
      const eqIdx = body.indexOf("=");
      if (eqIdx !== -1) {
        flags[body.slice(0, eqIdx)] = body.slice(eqIdx + 1);
      } else {
        flags[body] = true;
      }
    } else {
      positional.push(token);
    }
  }
  const parsed = { subcommand: canonical, flags, positional };

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
    case "update":
      await updateCommand(parsed, ctx);
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
    case "status":
      await statusCommand(parsed, ctx as StatusCtx);
      break;
    case "diff":
      await diffCommand(parsed, ctx as DiffCtx);
      break;
    case "verify":
      await verifyCommand(parsed, ctx as VerifyCtx);
      break;
    case "profiles":
      await profilesCommand(parsed, ctx as ProfilesCtx);
      break;
    case "profile":
      await profileCommand(parsed, ctx as ProfilesCtx);
      break;
    case "reset":
      await resetCommand(parsed, ctx as ResetCtx);
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
/**
 * pi moved `reload()` off the tool-handler context: tools now receive
 * `ExtensionContext` (no reload); only command handlers
 * (`ExtensionCommandContext`) have it. Per pi's docs (extensions.md →
 * "ctx.reload()"), a tool queues the builtin `/reload` command as a follow-up
 * user message so extensions/skills hot-reload after the current turn — no
 * manual pi restart. This used to work when tools got a reload-capable ctx.
 */
export function withToolReload<Ctx>(pi: ExtensionAPI, ctx: Ctx): Ctx & { reload: () => Promise<void> } {
  return {
    ...ctx,
    reload: async () => {
      pi.sendUserMessage("/reload", { deliverAs: "followUp" });
    },
  };
}

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
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      try {
        const args: CommandArgs = { positional: [], flags: params.force ? { force: true } : {} };
        await syncCommand(args, ctx as unknown as SyncCtx);
        return { content: [{ type: "text" as const, text: "Sync completed." }], details: undefined as unknown };
      } catch (err) {
        return { content: [{ type: "text" as const, text: `Sync failed: ${err instanceof Error ? err.message : String(err)}` }], details: undefined as unknown };
      }
    },
  });

  pi.registerTool({
    name: "ct_add",
    label: "Catalog Add",
    description:
      "Add a package to the catalog by source. Name is auto-derived from source. Source must start with 'npm:' or 'git:'.",
    promptSnippet: "Add a package to the catalog",
    promptGuidelines: [
      "Use ct_add when the user asks to add a new package or skill to their catalog.",
    ],
    parameters: Type.Object({
      source: Type.String({ description: "Package source (npm:… or git:…)" }),
      scope: Type.Optional(Type.String({ description: "Batch scope: '@pi-stef' to add all @pi-stef packages" })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      try {
        const flags: Record<string, true | string> = {};
        if (params.scope) flags.scope = params.scope;
        const args: CommandArgs = {
          positional: params.scope ? [] : [params.source],
          flags,
        };
        await addCommand(args, withToolReload(pi, ctx) as unknown as AddCtx);
        return { content: [{ type: "text" as const, text: `Added ${params.source}.` }], details: undefined as unknown };
      } catch (err) {
        return { content: [{ type: "text" as const, text: `Add failed: ${err instanceof Error ? err.message : String(err)}` }], details: undefined as unknown };
      }
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
      name: Type.Optional(Type.String({ description: "Package name to remove" })),
      scope: Type.Optional(Type.String({ description: "Batch scope: '@pi-stef' to remove all @pi-stef packages" })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      try {
        const flags: Record<string, true | string> = {};
        if (params.scope) flags.scope = params.scope;
        const args: CommandArgs = {
          positional: params.name ? [params.name] : [],
          flags,
        };
        await removeCommand(args, withToolReload(pi, ctx) as unknown as RemoveCtx);
        const label = params.scope ? `Scope ${params.scope}` : `${params.name}`;
        return { content: [{ type: "text" as const, text: `Removed ${label}.` }], details: undefined as unknown };
      } catch (err) {
        return { content: [{ type: "text" as const, text: `Remove failed: ${err instanceof Error ? err.message : String(err)}` }], details: undefined as unknown };
      }
    },
  });

  pi.registerTool({
    name: "ct_toggle",
    label: "Catalog Toggle",
    description:
      "Toggle a package's enabled state (enabled ↔ disabled).",
    promptSnippet: "Toggle a package's enabled state",
    promptGuidelines: [
      "Use ct_toggle when the user wants to enable or disable a package.",
    ],
    parameters: Type.Object({
      name: Type.String({ description: "Package name to toggle" }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      try {
        const args: CommandArgs = { positional: [params.name], flags: {} };
        await toggleCommand(args, ctx as unknown as ToggleCtx);
        return { content: [{ type: "text" as const, text: `Toggled ${params.name}.` }], details: undefined as unknown };
      } catch (err) {
        return { content: [{ type: "text" as const, text: `Toggle failed: ${err instanceof Error ? err.message : String(err)}` }], details: undefined as unknown };
      }
    },
  });

  pi.registerTool({
    name: "ct_update",
    label: "Catalog Update",
    description:
      "Update packages to their latest versions. Run `pi update` behind the scenes.",
    promptSnippet: "Update catalog packages",
    promptGuidelines: [
      "Use ct_update when the user asks to update one or more packages in their catalog.",
    ],
    parameters: Type.Object({
      name: Type.Optional(Type.String({ description: "Package name to update (omit for --all)" })),
      all: Type.Optional(Type.Boolean({ description: "Update all packages" })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      try {
        const positional = params.name ? [params.name] : [];
        const flags: Record<string, true | string> = {};
        if (params.all) flags.all = true;
        const args: CommandArgs = { positional, flags };
        await updateCommand(args, withToolReload(pi, ctx));
        return { content: [{ type: "text" as const, text: "Update completed." }], details: undefined as unknown };
      } catch (err) {
        return { content: [{ type: "text" as const, text: `Update failed: ${err instanceof Error ? err.message : String(err)}` }], details: undefined as unknown };
      }
    },
  });

  pi.registerTool({
    name: "ct_reset",
    label: "Catalog Reset",
    description:
      "Full nuke: uninstall all @pi-stef packages, delete gist refs, delete config files.",
    promptSnippet: "Reset catalog completely",
    promptGuidelines: [
      "Use ct_reset when the user wants to completely remove all @pi-stef packages and catalog config.",
    ],
    parameters: Type.Object({
      yes: Type.Optional(Type.Boolean({ description: "Skip confirmation prompt" })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      try {
        const flags: Record<string, true | string> = {};
        if (params.yes) flags.yes = true;
        const args: CommandArgs = { positional: [], flags };
        await resetCommand(args, ctx as unknown as ResetCtx);
        return { content: [{ type: "text" as const, text: "Reset completed." }], details: undefined as unknown };
      } catch (err) {
        return { content: [{ type: "text" as const, text: `Reset failed: ${err instanceof Error ? err.message : String(err)}` }], details: undefined as unknown };
      }
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
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      try {
        const args: CommandArgs = { positional: [], flags: params.verbose ? { verbose: true } : {} };
        await statusCommand(args, ctx as unknown as StatusCtx);
        return { content: [{ type: "text" as const, text: "Status displayed." }], details: undefined as unknown };
      } catch (err) {
        return { content: [{ type: "text" as const, text: `Status failed: ${err instanceof Error ? err.message : String(err)}` }], details: undefined as unknown };
      }
    },
  });
}
