import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * S-M211 spawn-site audit. Every `deps.spawnAgent`-using call site in
 * packages/sf-team/src/ should route through `makeSpawnHelper`, where the
 * helper auto-injects steering guidance for non-decider spawns. The
 * runtime-layer `spawnAgent` import in shared.ts is the single legitimate
 * direct consumer.
 *
 * This test snapshots the list of `from "../runtime/spawn"` imports under
 * `packages/sf-team/src/`. A new direct consumer would fail the snapshot
 * and force the contributor to either route through makeSpawnHelper or
 * document the exemption here.
 */

function repoFiles(): string[] {
  const root = path.resolve(__dirname, "..", "src");
  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readDirSync(dir)) {
      const full = path.join(dir, name);
      const stat = statSync(full);
      if (stat.isDirectory()) walk(full);
      else if (name.endsWith(".ts")) found.push(full);
    }
  };
  walk(root);
  return found;
}

function readDirSync(dir: string): string[] {
  // tiny wrapper so we can mock if needed later; uses Node fs directly.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return require("node:fs").readdirSync(dir);
}
function statSync(p: string): { isDirectory(): boolean } {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return require("node:fs").statSync(p);
}

describe("steering spawn-site audit", () => {
  const ALLOWED_DIRECT_SPAWN_AGENT_IMPORTS: ReadonlySet<string> = new Set([
    // The spawn helper itself is the canonical consumer.
    path.normalize("packages/sf-team/src/tools/shared.ts"),
  ]);

  it("no new direct imports of runtime/spawn outside makeSpawnHelper", () => {
    const files = repoFiles();
    const offenders: string[] = [];
    for (const file of files) {
      const body = readFileSync(file, "utf8");
      if (body.includes("from \"../runtime/spawn\"") || body.includes("from \"./runtime/spawn\"")) {
        const rel = path.relative(path.resolve(__dirname, "..", "..", ".."), file);
        if (!ALLOWED_DIRECT_SPAWN_AGENT_IMPORTS.has(rel)) {
          offenders.push(rel);
        }
      }
    }
    expect(offenders, `New direct spawnAgent consumers (route through makeSpawnHelper or add to ALLOWED list with rationale): ${offenders.join(", ")}`).toEqual([]);
  });

  it("non-decider spawnText callers go through a helper built with steering context", () => {
    // Sample assertion: makeSpawnHelper is called with `steering: bodyCtx.steering` or
    // `steering: ctx.steering` in tools/*.ts. We check that every tools/*.ts that calls
    // makeSpawnHelper passes a `steering:` parameter so the helper can inject guidance.
    const toolsDir = path.resolve(__dirname, "..", "src", "tools");
    const toolFiles = readDirSync(toolsDir)
      .filter((name) => name.endsWith(".ts"))
      .map((name) => path.join(toolsDir, name));
    const offenders: string[] = [];
    for (const file of toolFiles) {
      const body = readFileSync(file, "utf8");
      // makeSpawnHelper calls should always carry `steering:` so the helper
      // can auto-inject for non-decider spawns. The shared.ts helper-builder
      // itself is exempt (it defines the helper, not a call site).
      if (file.endsWith("shared.ts")) continue;
      const calls = body.match(/makeSpawnHelper\([\s\S]*?\)/g) ?? [];
      for (const call of calls) {
        if (!call.includes("steering:")) {
          offenders.push(`${path.basename(file)}: makeSpawnHelper(...) call missing steering: context`);
        }
      }
    }
    expect(offenders, offenders.join("\n")).toEqual([]);
  });

  it("no `spawnAgent: deps.spawnAgent` raw passthrough in tools/* (must route through sp)", () => {
    // Verifier-agent and similar inner-spawn passes must go through the
    // helper so steering guidance is injected. The plan's spawn-site audit
    // criterion explicitly enumerates non-decider spawns; this regression
    // check pins down the previously-missed `agent: { ..., spawnAgent:
    // deps.spawnAgent }` shape used by the verification gate runner.
    const toolsDir = path.resolve(__dirname, "..", "src", "tools");
    const toolFiles = readDirSync(toolsDir)
      .filter((name) => name.endsWith(".ts"))
      .map((name) => path.join(toolsDir, name));
    const offenders: string[] = [];
    for (const file of toolFiles) {
      const body = readFileSync(file, "utf8");
      const matches = body.match(/spawnAgent:\s*deps\.spawnAgent/g) ?? [];
      if (matches.length > 0) {
        offenders.push(`${path.basename(file)}: ${matches.length} raw deps.spawnAgent passthrough(s) (route via sp.spawn instead)`);
      }
    }
    expect(offenders, offenders.join("\n")).toEqual([]);
  });
});
