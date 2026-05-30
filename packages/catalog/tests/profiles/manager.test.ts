import { describe, expect, it } from "vitest";
import type { CatalogYaml } from "../../src/config/schema.js";
import {
  createProfile,
  switchProfile,
  deleteProfile,
  resolveEffectivePackages,
  DEFAULT_PROFILE,
} from "../../src/profiles/manager.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function baseCatalog(): CatalogYaml {
  return {
    meta: { pi_version: "1.0.0" },
    packages: {
      "base-pkg-a": { source: "npm:base-pkg-a", rating: "core" },
      "base-pkg-b": { source: "npm:base-pkg-b", rating: "useful" },
    },
    profiles: {
      work: {
        packages: {
          "work-tool": { source: "npm:work-tool", rating: "core" },
          "base-pkg-a": { source: "npm:base-pkg-a", rating: "debatable" },
        },
      },
    },
  };
}

function emptyCatalog(): CatalogYaml {
  return {
    meta: { pi_version: "1.0.0" },
    packages: {},
  };
}

// ---------------------------------------------------------------------------
// createProfile
// ---------------------------------------------------------------------------

describe("createProfile", () => {
  it("creates a new empty profile", () => {
    const result = createProfile(baseCatalog(), "personal");
    expect(result.profiles).toBeDefined();
    expect(result.profiles!["personal"]).toEqual({ packages: {} });
  });

  it("throws if profile already exists", () => {
    expect(() => createProfile(baseCatalog(), "work")).toThrow(
      /already exists/,
    );
  });

  it("initializes profiles section if missing", () => {
    const result = createProfile(emptyCatalog(), "work");
    expect(result.profiles).toBeDefined();
    expect(result.profiles!["work"]).toEqual({ packages: {} });
  });
});

// ---------------------------------------------------------------------------
// switchProfile
// ---------------------------------------------------------------------------

describe("switchProfile", () => {
  it("switches active profile in meta", () => {
    const result = switchProfile(baseCatalog(), "work");
    expect(result.meta.activeProfile).toBe("work");
  });

  it("throws if profile does not exist", () => {
    expect(() => switchProfile(baseCatalog(), "nonexistent")).toThrow(
      /not found/,
    );
  });

  it("switches to default profile", () => {
    const cat = switchProfile(baseCatalog(), "work");
    const result = switchProfile(cat, DEFAULT_PROFILE);
    expect(result.meta.activeProfile).toBe(DEFAULT_PROFILE);
  });
});

// ---------------------------------------------------------------------------
// deleteProfile
// ---------------------------------------------------------------------------

describe("deleteProfile", () => {
  it("deletes an existing profile", () => {
    const result = deleteProfile(baseCatalog(), "work");
    expect(result.profiles!["work"]).toBeUndefined();
    expect(Object.keys(result.profiles!)).toHaveLength(0);
  });

  it("throws if profile does not exist", () => {
    expect(() => deleteProfile(baseCatalog(), "nonexistent")).toThrow(
      /not found/,
    );
  });

  it("throws when trying to delete the default profile", () => {
    expect(() => deleteProfile(baseCatalog(), DEFAULT_PROFILE)).toThrow(
      /Cannot delete the "default" profile/,
    );
  });

  it("clears activeProfile if it was the deleted profile", () => {
    const cat = switchProfile(baseCatalog(), "work");
    const result = deleteProfile(cat, "work");
    expect(result.meta.activeProfile).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// resolveEffectivePackages
// ---------------------------------------------------------------------------

describe("resolveEffectivePackages", () => {
  it("returns base packages for default profile", () => {
    const result = resolveEffectivePackages(baseCatalog(), DEFAULT_PROFILE);
    expect(Object.keys(result)).toEqual(["base-pkg-a", "base-pkg-b"]);
  });

  it("merges base packages with profile overrides", () => {
    const result = resolveEffectivePackages(baseCatalog(), "work");
    // work profile overrides base-pkg-a and adds work-tool
    expect(Object.keys(result).sort()).toEqual(
      ["base-pkg-a", "base-pkg-b", "work-tool"].sort(),
    );
  });

  it("profile override wins over base package", () => {
    const result = resolveEffectivePackages(baseCatalog(), "work");
    // base-pkg-a is "core" in base, "debatable" in work profile
    expect(result["base-pkg-a"].rating).toBe("debatable");
  });

  it("returns only base packages when profile has no packages", () => {
    const cat = createProfile(baseCatalog(), "empty-profile");
    const result = resolveEffectivePackages(cat, "empty-profile");
    expect(Object.keys(result)).toEqual(["base-pkg-a", "base-pkg-b"]);
  });

  it("uses activeProfile from meta when profile is undefined", () => {
    const cat = switchProfile(baseCatalog(), "work");
    const result = resolveEffectivePackages(cat);
    expect(result["base-pkg-a"].rating).toBe("debatable");
    expect(result["work-tool"]).toBeDefined();
  });

  it("defaults to default profile when meta has no activeProfile", () => {
    const result = resolveEffectivePackages(baseCatalog());
    expect(Object.keys(result)).toEqual(["base-pkg-a", "base-pkg-b"]);
  });
});
