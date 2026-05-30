/**
 * `ct diff` subcommand implementation.
 *
 * Shows local vs remote gist differences by pulling the remote gist
 * content and comparing it line-by-line with the local cat.yaml.
 */

import yaml from "js-yaml";

import type { CommandArgs, CommandCtx } from "./types.js";
import { readCatalog, readLock } from "../config/io.js";
import { readCachedGistId } from "../sync/cache.js";
import { readGist } from "../sync/gist.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Context for `diffCommand`. Uses the base `CommandCtx`. */
export type DiffCtx = CommandCtx;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface DiffLine {
  type: "added" | "removed" | "unchanged";
  content: string;
}

/**
 * Compute a simple line-by-line diff between two strings.
 * Returns lines marked as added (in remote only), removed (in local only),
 * or unchanged.
 */
function lineDiff(local: string, remote: string): DiffLine[] {
  const localLines = local.split("\n");
  const remoteLines = remote.split("\n");

  const localSet = new Map<string, number>();
  for (const line of localLines) {
    localSet.set(line, (localSet.get(line) ?? 0) + 1);
  }

  const remoteSet = new Map<string, number>();
  for (const line of remoteLines) {
    remoteSet.set(line, (remoteSet.get(line) ?? 0) + 1);
  }

  // Build a merged set of unique lines preserving order
  const seen = new Set<string>();
  const allLines: string[] = [];
  for (const line of localLines) {
    if (!seen.has(line)) {
      seen.add(line);
      allLines.push(line);
    }
  }
  for (const line of remoteLines) {
    if (!seen.has(line)) {
      seen.add(line);
      allLines.push(line);
    }
  }

  const result: DiffLine[] = [];
  for (const line of allLines) {
    const localCount = localSet.get(line) ?? 0;
    const remoteCount = remoteSet.get(line) ?? 0;

    if (line === "") {
      // Skip trailing empty lines in diff output
      continue;
    }

    if (localCount > 0 && remoteCount > 0) {
      result.push({ type: "unchanged", content: line });
    } else if (localCount > 0) {
      result.push({ type: "removed", content: line });
    } else {
      result.push({ type: "added", content: line });
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// diffCommand
// ---------------------------------------------------------------------------

/**
 * Execute the `ct diff` subcommand.
 *
 * Fetches the remote gist content and compares it against the local
 * cat.yaml serialization. Shows added/removed lines.
 */
export async function diffCommand(
  args: CommandArgs,
  ctx: DiffCtx,
): Promise<void> {
  const { flags } = args;
  const profile =
    typeof flags["profile"] === "string" ? flags["profile"] : "default";

  // --- 1. Check for cached gist ID ---
  const gistId = readCachedGistId(ctx.home);
  if (!gistId) {
    ctx.ui.notify(
      `No remote gist configured. Use \`ct sync\` or \`ct push\` first.`,
      "error",
    );
    return;
  }

  // --- 2. Read local catalog as serialized YAML ---
  const catalog = readCatalog(ctx.home);
  const localYaml = yaml.dump(catalog);

  // --- 3. Fetch remote gist ---
  let remoteYaml: string;
  try {
    const gist = await readGist(gistId);
    const catFile = gist.files["cat.yaml"];
    remoteYaml = catFile?.content ?? "";
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    ctx.ui.notify(`Failed to read remote gist: ${message}`, "error");
    return;
  }

  // --- 4. Compute diff ---
  if (localYaml === remoteYaml) {
    ctx.ui.notify("Local and remote are identical.", "info");
    return;
  }

  // If remote is empty, all local lines are additions from remote's perspective
  if (!remoteYaml.trim()) {
    ctx.ui.notify("Remote is empty. Local has content to push.", "info");
    return;
  }

  const diff = lineDiff(localYaml, remoteYaml);

  const parts: string[] = ["Local vs Remote diff:"];
  const changed = diff.filter(
    (d) => d.type === "added" || d.type === "removed",
  );

  if (changed.length === 0) {
    ctx.ui.notify("Local and remote are identical.", "info");
    return;
  }

  for (const line of changed) {
    const prefix = line.type === "added" ? "+ " : "- ";
    parts.push(`${prefix}${line.content}`);
  }

  ctx.ui.notify(parts.join("\n"), "info");
}
