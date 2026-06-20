import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type { CommandCtx } from "../src/commands/types.js";
import { addCommand } from "../src/commands/add.js";
import { writeCatalog } from "../src/config/io.js";
import type { CatalogYaml } from "../src/config/schema.js";

// ---------------------------------------------------------------------------
// Temp directory helpers
// ---------------------------------------------------------------------------

let tmpDir: string;

function makeHome(): string {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-catalog-addcomp-"));
  return tmpDir;
}

function cleanup() {
  if (tmpDir) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

function emptyCatalog(): CatalogYaml {
  return { meta: { pi_version: "1.0.0" }, packages: {} };
}

interface MockUi {
  notify: ReturnType<typeof vi.fn>;
  select: ReturnType<typeof vi.fn>;
  confirm: ReturnType<typeof vi.fn>;
  setWorkingMessage: ReturnType<typeof vi.fn>;
}

function makeCtx(overrides: Partial<MockUi> = {}): { ctx: CommandCtx; ui: MockUi } {
  const ui: MockUi = {
    notify: vi.fn(),
    select: vi.fn(),
    confirm: vi.fn(),
    setWorkingMessage: vi.fn(),
    ...overrides,
  };
  return { ctx: { ui, home: tmpDir } as CommandCtx, ui };
}

// ---------------------------------------------------------------------------
// addCommand companion tests
// ---------------------------------------------------------------------------

describe("addCommand — companions", () => {
  let installSpy: ReturnType<typeof vi.spyOn>;
  let resolveInstalledDirMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    makeHome();
    const execModule = await import("../src/util/exec.js");
    installSpy = vi
      .spyOn(execModule, "piInstall")
      .mockResolvedValue({ stdout: "", stderr: "", exitCode: 0 });
  });

  afterEach(() => {
    installSpy?.mockRestore();
    resolveInstalledDirMock?.mockRestore?.();
    cleanup();
  });

  it("installs pi.companions alongside the primary package", async () => {
    // Create a fake installed package dir
    const pairDir = path.join(tmpDir, ".pi", "agent", "npm", "node_modules", "@pi-stef/pair");
    fs.mkdirSync(pairDir, { recursive: true });
    fs.writeFileSync(
      path.join(pairDir, "package.json"),
      JSON.stringify({ name: "@pi-stef/pair", pi: { companions: ["git:github.com/obra/superpowers"] } }),
    );

    // Mock resolveInstalledDir to return our fake dir for the npm source
    const installModule = await import("../src/catalog/install.js");
    resolveInstalledDirMock = vi
      .spyOn(installModule, "resolveInstalledDir")
      .mockImplementation((source: string) => {
        if (source === "npm:@pi-stef/pair") return pairDir;
        return undefined;
      });

    const catalog: CatalogYaml = {
      meta: { pi_version: "1.0.0" },
      packages: {},
    };
    writeCatalog(catalog, tmpDir);

    const { ctx } = makeCtx();
    await addCommand({ positional: ["npm:@pi-stef/pair"], flags: { type: "pi-native" } }, ctx);

    // piInstall called for primary + companion
    const calls = installSpy.mock.calls.map((c) => c[0]);
    expect(calls).toContain("npm:@pi-stef/pair");
    expect(calls).toContain("git:github.com/obra/superpowers");
  });

  it("skips a companion already in the catalog's sources", async () => {
    const pairDir = path.join(tmpDir, ".pi", "agent", "npm", "node_modules", "@pi-stef/pair");
    fs.mkdirSync(pairDir, { recursive: true });
    fs.writeFileSync(
      path.join(pairDir, "package.json"),
      JSON.stringify({ name: "@pi-stef/pair", pi: { companions: ["git:github.com/obra/superpowers"] } }),
    );

    const installModule = await import("../src/catalog/install.js");
    resolveInstalledDirMock = vi
      .spyOn(installModule, "resolveInstalledDir")
      .mockImplementation((source: string) => {
        if (source === "npm:@pi-stef/pair") return pairDir;
        return undefined;
      });

    // obra is already in catalog
    const catalog: CatalogYaml = {
      meta: { pi_version: "1.0.0" },
      packages: { superpowers: { source: "git:github.com/obra/superpowers", type: "skill" } },
    };
    writeCatalog(catalog, tmpDir);

    const { ctx } = makeCtx();
    await addCommand({ positional: ["npm:@pi-stef/pair"], flags: { type: "pi-native" } }, ctx);

    const calls = installSpy.mock.calls.map((c) => c[0]);
    expect(calls).toContain("npm:@pi-stef/pair");
    // companion already in catalog => not installed
    expect(calls.filter((s) => s === "git:github.com/obra/superpowers")).toHaveLength(0);
  });

  it("installs each distinct companion once even with a cycle", async () => {
    const dirA = path.join(tmpDir, ".pi", "agent", "npm", "node_modules", "pkg-a");
    const dirB = path.join(tmpDir, ".pi", "agent", "npm", "node_modules", "pkg-b");
    fs.mkdirSync(dirA, { recursive: true });
    fs.mkdirSync(dirB, { recursive: true });
    // A -> [B], B -> [A] (cycle)
    fs.writeFileSync(path.join(dirA, "package.json"), JSON.stringify({ pi: { companions: ["git:b"] } }));
    fs.writeFileSync(path.join(dirB, "package.json"), JSON.stringify({ pi: { companions: ["npm:pkg-a"] } }));

    const installModule = await import("../src/catalog/install.js");
    resolveInstalledDirMock = vi
      .spyOn(installModule, "resolveInstalledDir")
      .mockImplementation((source: string) => {
        if (source === "npm:pkg-a") return dirA;
        if (source === "git:b") return dirB;
        return undefined;
      });

    writeCatalog(emptyCatalog(), tmpDir);
    const { ctx } = makeCtx();
    await addCommand({ positional: ["npm:pkg-a"], flags: { type: "pi-native" } }, ctx);

    const calls = installSpy.mock.calls.map((c) => c[0]);
    expect(calls.filter((s) => s === "npm:pkg-a")).toHaveLength(1); // primary only
    expect(calls.filter((s) => s === "git:b")).toHaveLength(1); // companion once
  });

  it("respects the depth cap (does not recurse beyond MAX_COMPANION_DEPTH)", async () => {
    // Chain: A -> B -> C -> D -> E (4 companions deep, each declaring the next)
    const dirs: Record<string, string> = {};
    for (const pkg of ["a", "b", "c", "d", "e"]) {
      const dir = path.join(tmpDir, ".pi", "agent", "npm", "node_modules", `pkg-${pkg}`);
      fs.mkdirSync(dir, { recursive: true });
      dirs[pkg] = dir;
    }
    fs.writeFileSync(path.join(dirs.a, "package.json"), JSON.stringify({ pi: { companions: ["npm:pkg-b"] } }));
    fs.writeFileSync(path.join(dirs.b, "package.json"), JSON.stringify({ pi: { companions: ["npm:pkg-c"] } }));
    fs.writeFileSync(path.join(dirs.c, "package.json"), JSON.stringify({ pi: { companions: ["npm:pkg-d"] } }));
    fs.writeFileSync(path.join(dirs.d, "package.json"), JSON.stringify({ pi: { companions: ["npm:pkg-e"] } }));
    fs.writeFileSync(path.join(dirs.e, "package.json"), JSON.stringify({}));

    const installModule = await import("../src/catalog/install.js");
    resolveInstalledDirMock = vi
      .spyOn(installModule, "resolveInstalledDir")
      .mockImplementation((source: string) => {
        for (const pkg of ["a", "b", "c", "d", "e"]) {
          if (source === `npm:pkg-${pkg}`) return dirs[pkg];
        }
        return undefined;
      });

    writeCatalog(emptyCatalog(), tmpDir);
    const { ctx } = makeCtx();
    await addCommand({ positional: ["npm:pkg-a"], flags: { type: "pi-native" } }, ctx);

    const calls = installSpy.mock.calls.map((c) => c[0]);
    // MAX_COMPANION_DEPTH=3, so after root (a) → b (d=0) → c (d=1) → d (d=2) → "continue at d=3" means d's companion e is NOT installed
    expect(calls.filter((s) => s === "npm:pkg-e")).toHaveLength(0);
    // b, c, d should be installed
    expect(calls).toContain("npm:pkg-b");
    expect(calls).toContain("npm:pkg-c");
    expect(calls).toContain("npm:pkg-d");
  });
});
