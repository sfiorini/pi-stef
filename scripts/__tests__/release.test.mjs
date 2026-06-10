import { describe, it, expect } from "vitest";
import { bumpVersion, convertFileDependencies, sanitize } from "../lib.mjs";

describe("bumpVersion", () => {
  it("bumps patch version", () => {
    expect(bumpVersion("1.2.3", "patch")).toBe("1.2.4");
    expect(bumpVersion("0.0.0", "patch")).toBe("0.0.1");
  });

  it("bumps minor version", () => {
    expect(bumpVersion("1.2.3", "minor")).toBe("1.3.0");
    expect(bumpVersion("0.0.0", "minor")).toBe("0.1.0");
  });

  it("bumps major version", () => {
    expect(bumpVersion("1.2.3", "major")).toBe("2.0.0");
    expect(bumpVersion("0.0.0", "major")).toBe("1.0.0");
  });

  it("throws on invalid version format", () => {
    expect(() => bumpVersion("invalid", "patch")).toThrow('Invalid version format: "invalid"');
    expect(() => bumpVersion("1.2", "patch")).toThrow('Invalid version format: "1.2"');
  });
});

describe("convertFileDependencies", () => {
  it("converts file: dependencies to version ranges", () => {
    const pkg = {
      dependencies: {
        "@pi-stef/paths": "file:../paths",
        "lodash": "^4.17.21",
      },
    };
    const versionMap = new Map([["@pi-stef/paths", "1.0.0"]]);

    convertFileDependencies(pkg, versionMap);

    expect(pkg.dependencies["@pi-stef/paths"]).toBe("^1.0.0");
    expect(pkg.dependencies["lodash"]).toBe("^4.17.21");
  });

  it("handles devDependencies", () => {
    const pkg = {
      devDependencies: {
        "@pi-stef/paths": "file:../paths",
      },
    };
    const versionMap = new Map([["@pi-stef/paths", "2.0.0"]]);

    convertFileDependencies(pkg, versionMap);

    expect(pkg.devDependencies["@pi-stef/paths"]).toBe("^2.0.0");
  });

  it("skips when no dependencies", () => {
    const pkg = {};
    const versionMap = new Map();

    convertFileDependencies(pkg, versionMap);

    expect(pkg.dependencies).toBeUndefined();
    expect(pkg.devDependencies).toBeUndefined();
  });

  it("skips non-file: dependencies", () => {
    const pkg = {
      dependencies: {
        "lodash": "^4.17.21",
        "@pi-stef/paths": "file:../paths",
      },
    };
    const versionMap = new Map([["lodash", "5.0.0"]]);

    convertFileDependencies(pkg, versionMap);

    expect(pkg.dependencies["lodash"]).toBe("^4.17.21");
    expect(pkg.dependencies["@pi-stef/paths"]).toBe("file:../paths");
  });
});

describe("sanitize", () => {
  it("allows safe characters", () => {
    expect(sanitize("release(all): v1.0.0")).toBe("release(all): v1.0.0");
    expect(sanitize("@pi-stef/catalog@1.0.0")).toBe("@pi-stef/catalog@1.0.0");
  });

  it("removes dangerous characters", () => {
    expect(sanitize("test$(whoami)")).toBe("test(whoami)");
    expect(sanitize("test`whoami`")).toBe("testwhoami");
    expect(sanitize('test"whoami"')).toBe("testwhoami");
    expect(sanitize("test'whoami'")).toBe("testwhoami");
    expect(sanitize("test;whoami")).toBe("testwhoami");
    expect(sanitize("test|whoami")).toBe("testwhoami");
    expect(sanitize("test&whoami")).toBe("testwhoami");
  });
});
