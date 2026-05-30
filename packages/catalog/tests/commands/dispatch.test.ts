import { describe, expect, it } from "vitest";

import {
  parseSubcommand,
  resolveAlias,
  SUBCOMMANDS,
  type ParsedCommand,
} from "../../src/commands/dispatch.js";

// ---------------------------------------------------------------------------
// resolveAlias
// ---------------------------------------------------------------------------

describe("resolveAlias", () => {
  it("returns the canonical name for a known alias", () => {
    expect(resolveAlias("a")).toBe("add");
    expect(resolveAlias("rm")).toBe("remove");
  });

  it("returns the canonical name unchanged when it is already canonical", () => {
    expect(resolveAlias("sync")).toBe("sync");
    expect(resolveAlias("add")).toBe("add");
    expect(resolveAlias("remove")).toBe("remove");
  });

  it("returns undefined for an unknown alias", () => {
    expect(resolveAlias("bogus")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// parseSubcommand
// ---------------------------------------------------------------------------

describe("parseSubcommand", () => {
  it("parses a simple subcommand with no flags", () => {
    const result = parseSubcommand(["sync"]);
    expect(result).toEqual<ParsedCommand>({
      subcommand: "sync",
      flags: {},
      positional: [],
    });
  });

  it("parses a subcommand with a boolean flag", () => {
    const result = parseSubcommand(["sync", "--force"]);
    expect(result).toEqual<ParsedCommand>({
      subcommand: "sync",
      flags: { force: true },
      positional: [],
    });
  });

  it("parses a subcommand with a key=value flag", () => {
    const result = parseSubcommand(["add", "--source=pkg@1.0.0"]);
    expect(result).toEqual<ParsedCommand>({
      subcommand: "add",
      flags: { source: "pkg@1.0.0" },
      positional: [],
    });
  });

  it("parses positional arguments after flags", () => {
    const result = parseSubcommand(["add", "my-pkg", "--source=npm:my-pkg"]);
    expect(result).toEqual<ParsedCommand>({
      subcommand: "add",
      flags: { source: "npm:my-pkg" },
      positional: ["my-pkg"],
    });
  });

  it("resolves aliases in the subcommand position", () => {
    const result = parseSubcommand(["a", "my-pkg"]);
    expect(result.subcommand).toBe("add");
    expect(result.positional).toEqual(["my-pkg"]);
  });

  it("resolves 'rm' alias to 'remove'", () => {
    const result = parseSubcommand(["rm", "my-pkg"]);
    expect(result.subcommand).toBe("remove");
    expect(result.positional).toEqual(["my-pkg"]);
  });

  it("returns subcommand=undefined for an unrecognized first token", () => {
    const result = parseSubcommand(["explosions"]);
    expect(result.subcommand).toBeUndefined();
  });

  it("handles empty args array", () => {
    const result = parseSubcommand([]);
    expect(result).toEqual<ParsedCommand>({
      subcommand: undefined,
      flags: {},
      positional: [],
    });
  });

  it("parses multiple boolean flags", () => {
    const result = parseSubcommand(["sync", "--force", "--verbose"]);
    expect(result).toEqual<ParsedCommand>({
      subcommand: "sync",
      flags: { force: true, verbose: true },
      positional: [],
    });
  });

  it("parses mixed boolean and key=value flags", () => {
    const result = parseSubcommand([
      "push",
      "--force",
      "--message=hello",
      "--dry-run",
    ]);
    expect(result).toEqual<ParsedCommand>({
      subcommand: "push",
      flags: { force: true, message: "hello", "dry-run": true },
      positional: [],
    });
  });

  it("treats positional args interspersed with flags correctly", () => {
    const result = parseSubcommand(["add", "pkg-a", "pkg-b", "--force"]);
    expect(result).toEqual<ParsedCommand>({
      subcommand: "add",
      flags: { force: true },
      positional: ["pkg-a", "pkg-b"],
    });
  });
});

// ---------------------------------------------------------------------------
// SUBCOMMANDS constant
// ---------------------------------------------------------------------------

describe("SUBCOMMANDS", () => {
  it("contains all required canonical subcommands", () => {
    const required = [
      "sync",
      "init",
      "add",
      "remove",
      "toggle",
      "disable",
      "enable",
      "push",
      "pull",
      "login",
      "status",
      "diff",
      "verify",
      "profiles",
      "profile",
    ] as const;

    for (const name of required) {
      expect(SUBCOMMANDS).toContain(name);
    }
  });
});
