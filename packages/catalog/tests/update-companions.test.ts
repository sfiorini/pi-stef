import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { updateCommand } from "../src/commands/update";
import { writeCatalog, readCatalog } from "../src/config/io";
import type { CatalogYaml } from "../src/config/schema";

// ---------------------------------------------------------------------------
// Temp directory helpers
// ---------------------------------------------------------------------------

let tmpDir: string;

function makeHome(): string {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-catalog-updcomp-"));
  return tmpDir;
}

function cleanup() {
  if (tmpDir) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

interface MockUi {
  notify: ReturnType<typeof vi.fn>;
  select: ReturnType<typeof vi.fn>;
  confirm: ReturnType<typeof vi.fn>;
  setWorkingMessage: ReturnType<typeof vi.fn>;
}

function makeCtx(overrides: Partial<MockUi> = {}) {
  const ui: MockUi = {
    notify: vi.fn(),
    select: vi.fn(),
    confirm: vi.fn(),
    setWorkingMessage: vi.fn(),
    ...overrides,
  };
  return { ctx: { ui, home: tmpDir } as any, ui };
}

// ---------------------------------------------------------------------------

describe("updateCommand — companions", () => {
  let updateSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    makeHome();
    const execModule = await import("../src/util/exec");
    updateSpy = vi
      .spyOn(execModule, "piUpdate")
      .mockResolvedValue({ stdout: "", stderr: "", exitCode: 0 });
  });

  afterEach(() => {
    updateSpy?.mockRestore();
    cleanup();
  });

  it("installs companions alongside a successfully updated single package", async () => {
    // Create fake installed package dir with companion declared
    const pairDir = path.join(tmpDir, ".pi", "agent", "npm", "node_modules", "@pi-stef/pair");
    fs.mkdirSync(pairDir, { recursive: true });
    fs.writeFileSync(
      path.join(pairDir, "package.json"),
      JSON.stringify({ name: "@pi-stef/pair", pi: { companions: ["git:github.com/obra/superpowers"] } }),
    );

    // Mock resolveInstalledDir to return the fake dir
    const installModule = await import("../src/catalog/install");
    const ridMock = vi
      .spyOn(installModule, "resolveInstalledDir")
      .mockImplementation((source: string) => {
        if (source === "npm:@pi-stef/pair") return pairDir;
        return undefined;
      });

    const piInstallModule = await import("../src/util/exec");
    const installSpy = vi
      .spyOn(piInstallModule, "piInstall")
      .mockResolvedValue({ stdout: "", stderr: "", exitCode: 0 });

    const catalog: CatalogYaml = {
      meta: { pi_version: "1.0.0" },
      packages: { pair: { source: "npm:@pi-stef/pair", type: "skill" } },
    };
    writeCatalog(catalog, tmpDir);

    const { ctx } = makeCtx();
    await updateCommand({ positional: ["pair"], flags: {} }, ctx);

    // piInstall should have been called for the companion
    expect(installSpy).toHaveBeenCalledWith("git:github.com/obra/superpowers");
    // The companion should be added to the catalog so it's not orphaned
    const updatedCatalog = readCatalog(tmpDir);
    expect(updatedCatalog.packages["github.com/obra/superpowers"]).toBeDefined();
    expect(updatedCatalog.packages["github.com/obra/superpowers"].source).toBe("git:github.com/obra/superpowers");

    installSpy.mockRestore();
    ridMock.mockRestore();
  });

  it("skips companion already in the catalog during update", async () => {
    const pairDir = path.join(tmpDir, ".pi", "agent", "npm", "node_modules", "@pi-stef/pair");
    fs.mkdirSync(pairDir, { recursive: true });
    fs.writeFileSync(
      path.join(pairDir, "package.json"),
      JSON.stringify({ name: "@pi-stef/pair", pi: { companions: ["git:github.com/obra/superpowers"] } }),
    );

    const installModule = await import("../src/catalog/install");
    const ridMock = vi
      .spyOn(installModule, "resolveInstalledDir")
      .mockImplementation((source: string) => {
        if (source === "npm:@pi-stef/pair") return pairDir;
        return undefined;
      });

    const piInstallModule = await import("../src/util/exec");
    const installSpy = vi
      .spyOn(piInstallModule, "piInstall")
      .mockResolvedValue({ stdout: "", stderr: "", exitCode: 0 });

    // obra is already in catalog
    const catalog: CatalogYaml = {
      meta: { pi_version: "1.0.0" },
      packages: {
        pair: { source: "npm:@pi-stef/pair", type: "skill" },
        superpowers: { source: "git:github.com/obra/superpowers", type: "skill" },
      },
    };
    writeCatalog(catalog, tmpDir);

    const { ctx } = makeCtx();
    await updateCommand({ positional: ["pair"], flags: {} }, ctx);

    // companion already in catalog => NOT installed
    const companionCalls = installSpy.mock.calls.filter((c: any[]) => c[0] === "git:github.com/obra/superpowers");
    expect(companionCalls).toHaveLength(0);

    installSpy.mockRestore();
    ridMock.mockRestore();
  });

  it("does NOT install companions when update fails", async () => {
    updateSpy.mockRestore(); // remove success mock
    const execModule2 = await import("../src/util/exec");
    updateSpy = vi
      .spyOn(execModule2, "piUpdate")
      .mockRejectedValue(new Error("update failed"));

    const piInstallModule = await import("../src/util/exec");
    const installSpy = vi
      .spyOn(piInstallModule, "piInstall")
      .mockResolvedValue({ stdout: "", stderr: "", exitCode: 0 });

    const catalog: CatalogYaml = {
      meta: { pi_version: "1.0.0" },
      packages: { pair: { source: "npm:@pi-stef/pair", type: "skill" } },
    };
    writeCatalog(catalog, tmpDir);

    const { ctx } = makeCtx();
    await updateCommand({ positional: ["pair"], flags: {} }, ctx);

    // piInstall should NOT be called for companions since update failed
    const installCalls = installSpy.mock.calls.map((c: any[]) => c[0] as string);
    expect(installCalls).toHaveLength(0);

    installSpy.mockRestore();
  });

  it("installs companions for each successfully updated package with --all", async () => {
    const dirA = path.join(tmpDir, ".pi", "agent", "npm", "node_modules", "pkg-a");
    const dirB = path.join(tmpDir, ".pi", "agent", "npm", "node_modules", "pkg-b");
    fs.mkdirSync(dirA, { recursive: true });
    fs.mkdirSync(dirB, { recursive: true });
    fs.writeFileSync(path.join(dirA, "package.json"), JSON.stringify({ pi: { companions: ["git:comp-a"] } }));
    fs.writeFileSync(path.join(dirB, "package.json"), JSON.stringify({ pi: { companions: ["git:comp-b"] } }));

    const installModule = await import("../src/catalog/install");
    const ridMock = vi
      .spyOn(installModule, "resolveInstalledDir")
      .mockImplementation((source: string) => {
        if (source === "npm:pkg-a") return dirA;
        if (source === "npm:pkg-b") return dirB;
        return undefined;
      });

    const piInstallModule = await import("../src/util/exec");
    const installSpy = vi
      .spyOn(piInstallModule, "piInstall")
      .mockResolvedValue({ stdout: "", stderr: "", exitCode: 0 });

    const catalog: CatalogYaml = {
      meta: { pi_version: "1.0.0" },
      packages: {
        a: { source: "npm:pkg-a", type: "skill" },
        b: { source: "npm:pkg-b", type: "skill" },
      },
    };
    writeCatalog(catalog, tmpDir);

    const { ctx } = makeCtx();
    await updateCommand({ positional: [], flags: { all: true } }, ctx);

    expect(installSpy).toHaveBeenCalledWith("git:comp-a");
    expect(installSpy).toHaveBeenCalledWith("git:comp-b");

    installSpy.mockRestore();
    ridMock.mockRestore();
  });
});
