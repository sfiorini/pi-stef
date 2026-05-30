import { describe, expect, it } from "vitest";

import {
  SUBCOMMAND_DEFS,
  resolveCanonical,
  getAliasMap,
  getSubcommandNames,
} from "../../src/commands/definitions.js";

describe("SUBCOMMAND_DEFS (single source of truth)", () => {
  it("contains every required canonical subcommand", () => {
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
      expect(
        SUBCOMMAND_DEFS.some((d) => d.name === name),
        `expected subcommand ${name}`,
      ).toBe(true);
    }
  });

  it("each definition has a non-empty name and description", () => {
    for (const def of SUBCOMMAND_DEFS) {
      expect(def.name.length, `name for ${def.name}`).toBeGreaterThan(0);
      expect(def.description.length, `description for ${def.name}`).toBeGreaterThan(0);
    }
  });

  it("aliases are optional and when present are non-empty strings", () => {
    for (const def of SUBCOMMAND_DEFS) {
      for (const alias of def.aliases ?? []) {
        expect(alias.length, `alias for ${def.name}`).toBeGreaterThan(0);
      }
    }
  });

  it("has expected aliases: a→add, rm→remove", () => {
    const addDef = SUBCOMMAND_DEFS.find((d) => d.name === "add");
    expect(addDef?.aliases).toContain("a");

    const removeDef = SUBCOMMAND_DEFS.find((d) => d.name === "remove");
    expect(removeDef?.aliases).toContain("rm");
  });

  it("names are unique", () => {
    const names = SUBCOMMAND_DEFS.map((d) => d.name);
    expect(new Set(names).size).toBe(names.length);
  });
});

describe("resolveCanonical", () => {
  it("resolves a canonical name unchanged", () => {
    expect(resolveCanonical("sync")).toBe("sync");
    expect(resolveCanonical("add")).toBe("add");
  });

  it("resolves aliases to their canonical name", () => {
    expect(resolveCanonical("a")).toBe("add");
    expect(resolveCanonical("rm")).toBe("remove");
  });

  it("returns undefined for unknown tokens", () => {
    expect(resolveCanonical("bogus")).toBeUndefined();
  });
});

describe("getAliasMap", () => {
  it("maps every name and alias to its canonical name", () => {
    const map = getAliasMap();

    // Every canonical name maps to itself
    for (const def of SUBCOMMAND_DEFS) {
      expect(map.get(def.name)).toBe(def.name);
    }

    // Aliases map to their canonical name
    expect(map.get("a")).toBe("add");
    expect(map.get("rm")).toBe("remove");
  });
});

describe("getSubcommandNames", () => {
  it("returns the ordered list of canonical subcommand names", () => {
    const names = getSubcommandNames();

    expect(names).toEqual(SUBCOMMAND_DEFS.map((d) => d.name));
    expect(names).toContain("sync");
    expect(names).toContain("add");
    expect(names).toContain("profile");
  });
});
