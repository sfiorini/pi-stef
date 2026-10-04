import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Read-only agent-`.md` discovery + frontmatter reporting.
 *
 * Flow REPORTS where each agent is defined (and which model it carries) but never
 * RESOLVES or passes a model at dispatch: the agent `.md` files are the single
 * source of truth for agent definitions, and pi-subagents / pi-dynamic-workflows
 * apply them natively (frontmatter is authoritative). This module exists so
 * tool output can show the user what WILL run without flow interfering.
 *
 * Discovery mirrors pi-subagents' `loadCustomAgents` (custom-agents.ts):
 *   1. project `<cwd>/.pi/agents/<name>.md`   (highest priority)
 *   2. global  `<agentDir>/agents/<name>.md`  (getAgentDir(), honors PI_CODING_AGENT_DIR)
 *
 * Matching is case-insensitive on the FILENAME (a `Reviewer.md` is found for
 * "reviewer"), mirroring `resolveAgentType` in src/agents.ts.
 *
 * NOTE: the project lookup is intentionally NON-RECURSIVE (exactly `<cwd>/.pi/agents`),
 * matching the stale-file check in src/agents.ts. A flow launched from a
 * subdirectory may therefore report the global `.md` while pi-subagents (which
 * also discovers per-cwd) applies a project one — acceptable for a read-only
 * report; the actual model application is pi-subagents'/pi-dw's job.
 */

/** Which discovery location the found definition came from. */
export type AgentMdSource = "project" | "global";

/** The frontmatter fields flow reports (never acts on). */
export interface AgentFrontmatter {
  model?: string;
  thinking?: string;
  tools?: string;
  max_turns?: number;
  isolated?: boolean;
  /** False when the .md sets `enabled: false` (pi-subagents refuses to run it —
   *  the report must not present a disabled agent as usable). */
  enabled?: boolean;
}

export interface AgentFileInfo {
  /** Absolute path of the discovered `.md`. */
  path: string;
  source: AgentMdSource;
  frontmatter: AgentFrontmatter;
}

/** The pi-coding-agent helpers, loaded lazily so a missing/broken peer install
 *  degrades to the homedir fallback instead of crashing the extension. */
interface PeerApi {
  getAgentDir: () => string;
  parseFrontmatter: (content: string) => { frontmatter: Record<string, unknown>; body: string };
}

let peerCache: PeerApi | null | undefined;

async function loadPeer(): Promise<PeerApi | null> {
  if (peerCache !== undefined) return peerCache;
  try {
    const mod = (await import("@earendil-works/pi-coding-agent")) as Partial<PeerApi>;
    if (typeof mod.getAgentDir === "function" && typeof mod.parseFrontmatter === "function") {
      peerCache = { getAgentDir: mod.getAgentDir, parseFrontmatter: mod.parseFrontmatter };
    } else {
      peerCache = null;
    }
  } catch {
    peerCache = null;
  }
  return peerCache;
}

/** The global agents dir: `getAgentDir()/agents`, falling back to `~/.pi/agent/agents`
 *  when the peer module is unavailable. Honors PI_CODING_AGENT_DIR via getAgentDir. */
export async function globalAgentsDir(): Promise<string> {
  const peer = await loadPeer();
  if (peer) return join(peer.getAgentDir(), "agents");
  return join(homedir(), ".pi", "agent", "agents");
}

/** The project agents dir for a working directory (non-recursive by design). */
export function projectAgentsDir(cwd: string): string {
  return join(cwd, ".pi", "agents");
}

/** Parse an agent `.md` into the report shape. Never throws on content — a
 *  malformed frontmatter block (or an unavailable peer parser) simply reports
 *  no fields. The peer MUST already be loaded (callers await loadPeer()). */
function parseAgentMd(path: string, source: AgentMdSource): AgentFileInfo {
  let fm: Record<string, unknown> = {};
  try {
    const parser = peerCache?.parseFrontmatter;
    if (parser) fm = parser(readFileSync(path, "utf8")).frontmatter ?? {};
  } catch {
    fm = {};
  }
  const str = (v: unknown): string | undefined =>
    typeof v === "string" && v.trim().length > 0 ? v.trim() : undefined;
  return {
    path,
    source,
    frontmatter: {
      model: str(fm.model),
      thinking: str(fm.thinking),
      tools: str(fm.tools),
      // pi-subagents' nonNegativeInt rejects negatives; mirror that in the report.
      max_turns: typeof fm.max_turns === "number" && fm.max_turns >= 0 ? fm.max_turns : undefined,
      isolated: typeof fm.isolated === "boolean" ? fm.isolated : undefined,
      // enabled defaults to true; explicitly false means pi-subagents refuses to run it.
      enabled: fm.enabled === false ? false : true,
    },
  };
}

/** Filename lookup inside one directory: `<dir>/<name>.md`. The NAME is matched
 *  case-insensitively (mirrors resolveAgentType); the EXTENSION is matched
 *  case-SENSITIVELY (`.md` only) to mirror pi-subagents' `f.endsWith(".md")`
 *  filter — a `Reviewer.MD` must not be reported as loadable. */
function findMd(dir: string, name: string): string | null {
  const target = name.toLowerCase();
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return null;
  }
  const hit = entries.find((f) => f.toLowerCase() === `${target}.md` && f.endsWith(".md"));
  return hit ? join(dir, hit) : null;
}

/**
 * Find an agent's `.md` definition and read its frontmatter (report-only).
 *
 * Project `<cwd>/.pi/agents/<name>.md` wins over the global dir. Returns null
 * when no file exists in either location (the caller reports "built-in
 * fallback / general-purpose / inherit orchestrator" per resolveAgentType).
 */
export async function findAgentDefinition(
  name: string,
  cwd: string,
): Promise<AgentFileInfo | null> {
  await loadPeer(); // ensure peerCache is primed before parseAgentMd uses it
  const project = findMd(projectAgentsDir(cwd), name);
  if (project && existsSync(project)) return parseAgentMd(project, "project");
  const global = findMd(await globalAgentsDir(), name);
  if (global && existsSync(global)) return parseAgentMd(global, "global");
  return null;
}

/** Bulk variant: resolve several agents at once (each null when not found). */
export async function resolveAgentInfoMap(
  names: string[],
  cwd: string,
): Promise<Map<string, AgentFileInfo | null>> {
  const infos = await Promise.all(names.map((name) => findAgentDefinition(name, cwd)));
  const out = new Map<string, AgentFileInfo | null>();
  names.forEach((name, i) => out.set(name, infos[i]));
  return out;
}
