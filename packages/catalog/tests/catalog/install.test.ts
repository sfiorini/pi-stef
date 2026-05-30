import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import { scanInstalled, type InstalledPackage } from "../../src/catalog/install.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Create a mock settings.json content with the given packages array.
 */
function makeSettings(packages: unknown[]): string {
  return JSON.stringify({ packages });
}

/**
 * Create a mock package.json for an installed npm package.
 */
function makePackageJson(name: string, version: string): string {
  return JSON.stringify({ name, version });
}

// ---------------------------------------------------------------------------
// scanInstalled
// ---------------------------------------------------------------------------

describe("scanInstalled", () => {
  let readFileSyncSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    readFileSyncSpy = vi.spyOn(fs, "readFileSync");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns empty map when settings has no packages key", () => {
    readFileSyncSpy.mockImplementation((p: string | Buffer) => {
      if (typeof p === "string" && p.endsWith("settings.json")) {
        return JSON.stringify({});
      }
      throw new Error(`unexpected read: ${p}`);
    });

    const result = scanInstalled("/fake/home");
    expect(result).toEqual({});
  });

  it("returns empty map when settings has empty packages array", () => {
    readFileSyncSpy.mockImplementation((p: string | Buffer) => {
      if (typeof p === "string" && p.endsWith("settings.json")) {
        return makeSettings([]);
      }
      throw new Error(`unexpected read: ${p}`);
    });

    const result = scanInstalled("/fake/home");
    expect(result).toEqual({});
  });

  it("parses npm source string and reads version from installed package.json", () => {
    readFileSyncSpy.mockImplementation((p: string | Buffer) => {
      const fp = typeof p === "string" ? p : p.toString();
      if (fp.endsWith("settings.json")) {
        return makeSettings(["npm:@foo/bar@1.2.3"]);
      }
      // npm package.json at ~/.pi/agent/npm/node_modules/@foo/bar/package.json
      if (fp.includes("node_modules") && fp.endsWith("package.json")) {
        return makePackageJson("@foo/bar", "1.2.3");
      }
      throw new Error(`unexpected read: ${fp}`);
    });

    const result = scanInstalled("/fake/home");
    expect(Object.keys(result)).toHaveLength(1);

    const pkg: InstalledPackage = result["@foo/bar"];
    expect(pkg).toBeDefined();
    expect(pkg.source).toBe("npm:@foo/bar@1.2.3");
    expect(pkg.name).toBe("@foo/bar");
    expect(pkg.version).toBe("1.2.3");
  });

  it("parses npm source without version pin", () => {
    readFileSyncSpy.mockImplementation((p: string | Buffer) => {
      const fp = typeof p === "string" ? p : p.toString();
      if (fp.endsWith("settings.json")) {
        return makeSettings(["npm:my-pkg"]);
      }
      if (fp.includes("node_modules") && fp.endsWith("package.json")) {
        return makePackageJson("my-pkg", "2.0.0");
      }
      throw new Error(`unexpected read: ${fp}`);
    });

    const result = scanInstalled("/fake/home");
    const pkg = result["my-pkg"];
    expect(pkg.source).toBe("npm:my-pkg");
    expect(pkg.name).toBe("my-pkg");
    expect(pkg.version).toBe("2.0.0");
  });

  it("parses git source string", () => {
    readFileSyncSpy.mockImplementation((p: string | Buffer) => {
      const fp = typeof p === "string" ? p : p.toString();
      if (fp.endsWith("settings.json")) {
        return makeSettings(["git:github.com/user/repo@v1"]);
      }
      throw new Error(`unexpected read: ${fp}`);
    });

    const result = scanInstalled("/fake/home");
    expect(Object.keys(result)).toHaveLength(1);

    const pkg = result["github.com/user/repo"];
    expect(pkg.source).toBe("git:github.com/user/repo@v1");
    expect(pkg.name).toBe("github.com/user/repo");
    // git packages don't have a version from npm; may be undefined or detected differently
    expect(pkg.version).toBeUndefined();
  });

  it("parses HTTPS URL source", () => {
    readFileSyncSpy.mockImplementation((p: string | Buffer) => {
      const fp = typeof p === "string" ? p : p.toString();
      if (fp.endsWith("settings.json")) {
        return makeSettings(["https://github.com/user/repo@v2"]);
      }
      throw new Error(`unexpected read: ${fp}`);
    });

    const result = scanInstalled("/fake/home");
    const pkg = result["github.com/user/repo"];
    expect(pkg.source).toBe("https://github.com/user/repo@v2");
    expect(pkg.name).toBe("github.com/user/repo");
  });

  it("parses local path source and reads version from its package.json", () => {
    const localPath = "../../Projects/my-skill";

    readFileSyncSpy.mockImplementation((p: string | Buffer) => {
      const fp = typeof p === "string" ? p : p.toString();
      if (fp.endsWith("settings.json")) {
        return makeSettings([localPath]);
      }
      // The resolved local package.json
      if (fp.endsWith("package.json") && fp.includes("Projects")) {
        return makePackageJson("my-skill", "3.5.0");
      }
      throw new Error(`unexpected read: ${fp}`);
    });

    const result = scanInstalled("/fake/home");
    const pkg = result[localPath];
    expect(pkg.source).toBe(localPath);
    expect(pkg.name).toBe("my-skill");
    expect(pkg.version).toBe("3.5.0");
  });

  it("parses object-form package entry with source key", () => {
    readFileSyncSpy.mockImplementation((p: string | Buffer) => {
      const fp = typeof p === "string" ? p : p.toString();
      if (fp.endsWith("settings.json")) {
        return makeSettings([
          { source: "npm:@foo/bar", extensions: ["extensions/*.ts"] },
        ]);
      }
      if (fp.includes("node_modules") && fp.endsWith("package.json")) {
        return makePackageJson("@foo/bar", "4.0.0");
      }
      throw new Error(`unexpected read: ${fp}`);
    });

    const result = scanInstalled("/fake/home");
    const pkg = result["@foo/bar"];
    expect(pkg.source).toBe("npm:@foo/bar");
    expect(pkg.name).toBe("@foo/bar");
    expect(pkg.version).toBe("4.0.0");
  });

  it("handles multiple packages of mixed types", () => {
    readFileSyncSpy.mockImplementation((p: string | Buffer) => {
      const fp = typeof p === "string" ? p : p.toString();
      if (fp.endsWith("settings.json")) {
        return makeSettings([
          "npm:@foo/bar@1.2.3",
          "git:github.com/user/repo@v1",
          "../../Projects/my-skill",
        ]);
      }
      if (fp.includes("@foo") && fp.endsWith("package.json")) {
        return makePackageJson("@foo/bar", "1.2.3");
      }
      if (fp.includes("Projects") && fp.endsWith("package.json")) {
        return makePackageJson("my-skill", "3.5.0");
      }
      throw new Error(`unexpected read: ${fp}`);
    });

    const result = scanInstalled("/fake/home");
    expect(Object.keys(result)).toHaveLength(3);
    expect(result["@foo/bar"]).toBeDefined();
    expect(result["github.com/user/repo"]).toBeDefined();
    expect(result["../../Projects/my-skill"]).toBeDefined();
  });

  it("returns undefined version when package.json is missing for npm package", () => {
    readFileSyncSpy.mockImplementation((p: string | Buffer) => {
      const fp = typeof p === "string" ? p : p.toString();
      if (fp.endsWith("settings.json")) {
        return makeSettings(["npm:orphan-pkg"]);
      }
      if (fp.includes("node_modules") && fp.endsWith("package.json")) {
        const err = new Error("ENOENT") as NodeJS.ErrnoException;
        err.code = "ENOENT";
        throw err;
      }
      throw new Error(`unexpected read: ${fp}`);
    });

    const result = scanInstalled("/fake/home");
    const pkg = result["orphan-pkg"];
    expect(pkg.source).toBe("npm:orphan-pkg");
    expect(pkg.version).toBeUndefined();
  });

  it("throws on unreadable settings.json (non-ENOENT error)", () => {
    readFileSyncSpy.mockImplementation(() => {
      const err = new Error("Permission denied") as NodeJS.ErrnoException;
      err.code = "EACCES";
      throw err;
    });

    expect(() => scanInstalled("/fake/home")).toThrow("Permission denied");
  });

  it("returns empty map when settings.json does not exist", () => {
    readFileSyncSpy.mockImplementation(() => {
      const err = new Error("ENOENT") as NodeJS.ErrnoException;
      err.code = "ENOENT";
      throw err;
    });

    const result = scanInstalled("/fake/home");
    expect(result).toEqual({});
  });

  it("uses default home directory when none is provided", () => {
    readFileSyncSpy.mockImplementation((p: string | Buffer) => {
      const fp = typeof p === "string" ? p : p.toString();
      // Should be reading from ~/.pi/agent/settings.json
      if (fp.includes(".pi") && fp.endsWith("settings.json")) {
        return makeSettings(["npm:test-pkg"]);
      }
      if (fp.includes("node_modules") && fp.endsWith("package.json")) {
        return makePackageJson("test-pkg", "1.0.0");
      }
      throw new Error(`unexpected read: ${fp}`);
    });

    const result = scanInstalled();
    expect(result["test-pkg"]).toBeDefined();
  });

  // -----------------------------------------------------------------------
  // Project-level settings (.pi/settings.json)
  // -----------------------------------------------------------------------

  it("reads project settings when cwd is provided", () => {
    readFileSyncSpy.mockImplementation((p: string | Buffer) => {
      const fp = typeof p === "string" ? p : p.toString();
      // Global settings has one package
      if (fp.includes("/fake/home/.pi/agent/settings.json")) {
        return makeSettings(["npm:global-pkg"]);
      }
      // Project settings has another package
      if (fp.includes("/fake/project/.pi/settings.json")) {
        return makeSettings(["npm:project-pkg"]);
      }
      // npm package.jsons for both
      if (fp.includes("node_modules") && fp.includes("global-pkg") && fp.endsWith("package.json")) {
        return makePackageJson("global-pkg", "1.0.0");
      }
      if (fp.includes("node_modules") && fp.includes("project-pkg") && fp.endsWith("package.json")) {
        return makePackageJson("project-pkg", "2.0.0");
      }
      throw new Error(`unexpected read: ${fp}`);
    });

    const result = scanInstalled("/fake/home", "/fake/project");
    expect(Object.keys(result)).toHaveLength(2);
    expect(result["global-pkg"]).toBeDefined();
    expect(result["global-pkg"].version).toBe("1.0.0");
    expect(result["project-pkg"]).toBeDefined();
    expect(result["project-pkg"].version).toBe("2.0.0");
  });

  it("project settings override global for same package key", () => {
    readFileSyncSpy.mockImplementation((p: string | Buffer) => {
      const fp = typeof p === "string" ? p : p.toString();
      if (fp.includes("/fake/home/.pi/agent/settings.json")) {
        return makeSettings(["npm:shared-pkg@1.0.0"]);
      }
      if (fp.includes("/fake/project/.pi/settings.json")) {
        return makeSettings(["npm:shared-pkg@2.0.0"]);
      }
      // Return project version (project wins)
      if (fp.includes("node_modules") && fp.endsWith("package.json")) {
        return makePackageJson("shared-pkg", "2.0.0");
      }
      throw new Error(`unexpected read: ${fp}`);
    });

    const result = scanInstalled("/fake/home", "/fake/project");
    expect(Object.keys(result)).toHaveLength(1);
    expect(result["shared-pkg"]).toBeDefined();
    // Project settings source wins
    expect(result["shared-pkg"].source).toBe("npm:shared-pkg@2.0.0");
  });

  it("falls back to global only when project settings file is missing", () => {
    readFileSyncSpy.mockImplementation((p: string | Buffer) => {
      const fp = typeof p === "string" ? p : p.toString();
      if (fp.includes("/fake/home/.pi/agent/settings.json")) {
        return makeSettings(["npm:global-only"]);
      }
      if (fp.includes("/fake/project/.pi/settings.json")) {
        const err = new Error("ENOENT") as NodeJS.ErrnoException;
        err.code = "ENOENT";
        throw err;
      }
      if (fp.includes("node_modules") && fp.endsWith("package.json")) {
        return makePackageJson("global-only", "1.0.0");
      }
      throw new Error(`unexpected read: ${fp}`);
    });

    const result = scanInstalled("/fake/home", "/fake/project");
    expect(Object.keys(result)).toHaveLength(1);
    expect(result["global-only"]).toBeDefined();
  });

  it("returns empty map when settings.json has malformed JSON", () => {
    readFileSyncSpy.mockImplementation((p: string | Buffer) => {
      const fp = typeof p === "string" ? p : p.toString();
      if (fp.endsWith("settings.json")) {
        return "not valid json {{{";
      }
      throw new Error(`unexpected read: ${fp}`);
    });

    const result = scanInstalled("/fake/home");
    expect(result).toEqual({});
  });

  it("returns empty map when packages is not an array", () => {
    readFileSyncSpy.mockImplementation((p: string | Buffer) => {
      const fp = typeof p === "string" ? p : p.toString();
      if (fp.endsWith("settings.json")) {
        return JSON.stringify({ packages: "not-an-array" });
      }
      throw new Error(`unexpected read: ${fp}`);
    });

    const result = scanInstalled("/fake/home");
    expect(result).toEqual({});
  });

  it("skips malformed package entries (null, numbers, objects without source)", () => {
    readFileSyncSpy.mockImplementation((p: string | Buffer) => {
      const fp = typeof p === "string" ? p : p.toString();
      if (fp.endsWith("settings.json")) {
        return JSON.stringify({
          packages: [
            null,
            123,
            { notSource: "npm:pkg" },
            "npm:valid-pkg",
          ],
        });
      }
      if (fp.includes("node_modules") && fp.endsWith("package.json")) {
        return makePackageJson("valid-pkg", "1.0.0");
      }
      throw new Error(`unexpected read: ${fp}`);
    });

    const result = scanInstalled("/fake/home");
    // Only the valid string entry survives
    expect(Object.keys(result)).toHaveLength(1);
    expect(result["valid-pkg"]).toBeDefined();
    expect(result["valid-pkg"].source).toBe("npm:valid-pkg");
  });
});
