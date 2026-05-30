import { describe, expect, it } from "vitest";
import {
  extractNpmName,
  extractNpmVersion,
  cleanGitName,
  parseSource,
  sourceToKey,
  extractVersionFromSource,
} from "../../src/catalog/source.js";

// ---------------------------------------------------------------------------
// extractNpmName
// ---------------------------------------------------------------------------

describe("extractNpmName", () => {
  it("extracts unscoped package name without version", () => {
    expect(extractNpmName("my-pkg")).toBe("my-pkg");
  });

  it("extracts unscoped package name with version", () => {
    expect(extractNpmName("my-pkg@1.2.3")).toBe("my-pkg");
  });

  it("extracts scoped package name without version", () => {
    expect(extractNpmName("@scope/my-pkg")).toBe("@scope/my-pkg");
  });

  it("extracts scoped package name with version", () => {
    expect(extractNpmName("@scope/my-pkg@1.2.3")).toBe("@scope/my-pkg");
  });
});

// ---------------------------------------------------------------------------
// extractNpmVersion
// ---------------------------------------------------------------------------

describe("extractNpmVersion", () => {
  it("returns undefined for package without version", () => {
    expect(extractNpmVersion("my-pkg")).toBeUndefined();
  });

  it("extracts version from unscoped package", () => {
    expect(extractNpmVersion("my-pkg@1.2.3")).toBe("1.2.3");
  });

  it("returns undefined for scoped package without version", () => {
    expect(extractNpmVersion("@scope/my-pkg")).toBeUndefined();
  });

  it("extracts version from scoped package", () => {
    expect(extractNpmVersion("@scope/my-pkg@2.0.0")).toBe("2.0.0");
  });
});

// ---------------------------------------------------------------------------
// cleanGitName
// ---------------------------------------------------------------------------

describe("cleanGitName", () => {
  it("returns plain github shorthand unchanged", () => {
    expect(cleanGitName("github.com/user/repo")).toBe("github.com/user/repo");
  });

  it("strips @version suffix", () => {
    expect(cleanGitName("github.com/user/repo@v1")).toBe(
      "github.com/user/repo",
    );
  });

  it("strips git@ prefix and converts colon to slash", () => {
    expect(cleanGitName("git@github.com:user/repo")).toBe(
      "github.com/user/repo",
    );
  });

  it("strips https:// prefix", () => {
    expect(cleanGitName("https://github.com/user/repo")).toBe(
      "github.com/user/repo",
    );
  });

  it("strips .git suffix", () => {
    expect(cleanGitName("github.com/user/repo.git")).toBe(
      "github.com/user/repo",
    );
  });

  it("handles ssh:// with git@ and @ref", () => {
    expect(cleanGitName("ssh://git@github.com/user/repo@v1")).toBe(
      "github.com/user/repo",
    );
  });

  it("strips git:// prefix", () => {
    expect(cleanGitName("git://github.com/user/repo")).toBe(
      "github.com/user/repo",
    );
  });
});

// ---------------------------------------------------------------------------
// parseSource
// ---------------------------------------------------------------------------

describe("parseSource", () => {
  it("parses npm source without version", () => {
    const result = parseSource("npm:my-pkg");
    expect(result).toEqual({
      name: "my-pkg",
      type: "npm",
      npmName: "my-pkg",
      npmVersion: undefined,
    });
  });

  it("parses npm source with version", () => {
    const result = parseSource("npm:@scope/pkg@1.2.3");
    expect(result).toEqual({
      name: "@scope/pkg",
      type: "npm",
      npmName: "@scope/pkg",
      npmVersion: "1.2.3",
    });
  });

  it("parses git shorthand", () => {
    const result = parseSource("git:github.com/user/repo@v1");
    expect(result).toEqual({
      name: "github.com/user/repo",
      type: "git",
    });
  });

  it("parses HTTPS URL as git type", () => {
    const result = parseSource("https://github.com/user/repo");
    expect(result).toEqual({
      name: "github.com/user/repo",
      type: "git",
    });
  });

  it("parses local path and derives name from basename", () => {
    const result = parseSource("../../my/skill");
    expect(result.type).toBe("local");
    expect(result.name).toBe("skill");
  });
});

// ---------------------------------------------------------------------------
// sourceToKey
// ---------------------------------------------------------------------------

describe("sourceToKey", () => {
  it("returns npm name for npm source", () => {
    expect(sourceToKey("npm:my-pkg")).toBe("my-pkg");
  });

  it("returns npm name for scoped npm source with version", () => {
    expect(sourceToKey("npm:@scope/pkg@1.0.0")).toBe("@scope/pkg");
  });

  it("returns cleaned git name for git source", () => {
    expect(sourceToKey("git:github.com/user/repo@v1")).toBe(
      "github.com/user/repo",
    );
  });

  it("returns raw source for local path", () => {
    expect(sourceToKey("../../my/skill")).toBe("../../my/skill");
  });

  it("returns cleaned git name for HTTPS URL", () => {
    expect(sourceToKey("https://github.com/user/repo")).toBe(
      "github.com/user/repo",
    );
  });
});

// ---------------------------------------------------------------------------
// extractVersionFromSource
// ---------------------------------------------------------------------------

describe("extractVersionFromSource", () => {
  it("extracts version from npm source with version pin", () => {
    expect(extractVersionFromSource("npm:pkg-a@1.2.3")).toBe("1.2.3");
  });

  it("returns 'unknown' for npm source without version pin", () => {
    expect(extractVersionFromSource("npm:pkg-a")).toBe("unknown");
  });

  it("extracts version from git source with @ref", () => {
    expect(extractVersionFromSource("git:github.com/user/repo@v1")).toBe("v1");
  });

  it("returns 'unknown' for git source without @ref", () => {
    expect(extractVersionFromSource("git:github.com/user/repo")).toBe("unknown");
  });

  it("returns 'unknown' for local path source", () => {
    expect(extractVersionFromSource("../../my/skill")).toBe("unknown");
  });
});
