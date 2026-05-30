import { describe, expect, it } from "vitest";

import type { CatalogYaml } from "../../src/config/schema.js";
import {
  addPackage,
  removePackage,
  togglePackage,
  enablePackage,
  disablePackage,
} from "../../src/catalog/crud.js";
import {
  nextRating,
  isDisabled,
  isValidSource,
  RATING_CYCLE,
} from "../../src/catalog/ratings.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function emptyCatalog(): CatalogYaml {
  return {
    meta: { pi_version: "1.0.0" },
    packages: {},
  };
}

// ---------------------------------------------------------------------------
// ratings helpers
// ---------------------------------------------------------------------------

describe("RATING_CYCLE", () => {
  it("contains core → useful → debatable → disabled", () => {
    expect(RATING_CYCLE).toEqual([
      "core",
      "useful",
      "debatable",
      "disabled",
    ]);
  });
});

describe("nextRating", () => {
  it("cycles core → useful", () => {
    expect(nextRating("core")).toBe("useful");
  });

  it("cycles useful → debatable", () => {
    expect(nextRating("useful")).toBe("debatable");
  });

  it("cycles debatable → disabled", () => {
    expect(nextRating("debatable")).toBe("disabled");
  });

  it("cycles disabled → core (wraps around)", () => {
    expect(nextRating("disabled")).toBe("core");
  });
});

describe("isDisabled", () => {
  it("returns true for disabled", () => {
    expect(isDisabled("disabled")).toBe(true);
  });

  it("returns false for core", () => {
    expect(isDisabled("core")).toBe(false);
  });

  it("returns false for useful", () => {
    expect(isDisabled("useful")).toBe(false);
  });

  it("returns false for debatable", () => {
    expect(isDisabled("debatable")).toBe(false);
  });
});

describe("isValidSource", () => {
  it("accepts npm: source", () => {
    expect(isValidSource("npm:my-package")).toBe(true);
  });

  it("accepts npm: with scoped package", () => {
    expect(isValidSource("npm:@scope/my-package")).toBe(true);
  });

  it("accepts git: source", () => {
    expect(isValidSource("git:https://github.com/example/repo")).toBe(true);
  });

  it("accepts git: source with #subpath", () => {
    expect(isValidSource("git:https://github.com/example/repo#subpath")).toBe(
      true,
    );
  });

  it("rejects arbitrary string", () => {
    expect(isValidSource("just-a-string")).toBe(false);
  });

  it("rejects empty string", () => {
    expect(isValidSource("")).toBe(false);
  });

  it("rejects https: URL", () => {
    expect(isValidSource("https://github.com/example/repo")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// addPackage
// ---------------------------------------------------------------------------

describe("addPackage", () => {
  it("adds a new package entry", () => {
    const catalog = emptyCatalog();
    const result = addPackage(catalog, "my-skill", "npm:my-skill", "core");
    expect(result.packages["my-skill"]).toEqual({
      source: "npm:my-skill",
      rating: "core",
    });
  });

  it("throws on duplicate package name", () => {
    const catalog = addPackage(
      emptyCatalog(),
      "my-skill",
      "npm:my-skill",
      "core",
    );
    expect(() =>
      addPackage(catalog, "my-skill", "npm:other", "useful"),
    ).toThrow(/already exists/i);
  });

  it("throws on invalid source format", () => {
    const catalog = emptyCatalog();
    expect(() =>
      addPackage(catalog, "skill", "invalid-source", "core"),
    ).toThrow(/source/i);
  });

  it("accepts git: source format", () => {
    const catalog = emptyCatalog();
    const result = addPackage(
      catalog,
      "skill",
      "git:https://github.com/example/repo",
      "core",
    );
    expect(result.packages["skill"].source).toBe(
      "git:https://github.com/example/repo",
    );
  });

  it("accepts git:#subpath source format", () => {
    const catalog = emptyCatalog();
    const result = addPackage(
      catalog,
      "skill",
      "git:https://github.com/example/repo#skills/mine",
      "core",
    );
    expect(result.packages["skill"].source).toBe(
      "git:https://github.com/example/repo#skills/mine",
    );
  });

  it("adds with optional type", () => {
    const catalog = emptyCatalog();
    const result = addPackage(catalog, "skill", "npm:pkg", "core", "skill");
    expect(result.packages["skill"].type).toBe("skill");
  });

  it("does not mutate the original catalog", () => {
    const catalog = emptyCatalog();
    const result = addPackage(catalog, "skill", "npm:pkg", "core");
    expect(catalog.packages).toEqual({});
    expect(result).not.toBe(catalog);
  });
});

// ---------------------------------------------------------------------------
// removePackage
// ---------------------------------------------------------------------------

describe("removePackage", () => {
  it("removes an existing package", () => {
    const catalog = addPackage(
      emptyCatalog(),
      "skill",
      "npm:pkg",
      "core",
    );
    const result = removePackage(catalog, "skill");
    expect(result.packages["skill"]).toBeUndefined();
  });

  it("throws when package not found", () => {
    const catalog = emptyCatalog();
    expect(() => removePackage(catalog, "nonexistent")).toThrow(/not found/i);
  });

  it("does not mutate the original catalog", () => {
    const catalog = addPackage(
      emptyCatalog(),
      "skill",
      "npm:pkg",
      "core",
    );
    const result = removePackage(catalog, "skill");
    expect(catalog.packages["skill"]).toBeDefined();
    expect(result).not.toBe(catalog);
  });
});

// ---------------------------------------------------------------------------
// togglePackage
// ---------------------------------------------------------------------------

describe("togglePackage", () => {
  it("cycles core → useful", () => {
    const catalog = addPackage(
      emptyCatalog(),
      "skill",
      "npm:pkg",
      "core",
    );
    const result = togglePackage(catalog, "skill");
    expect(result.packages["skill"].rating).toBe("useful");
  });

  it("cycles useful → debatable", () => {
    let catalog = addPackage(emptyCatalog(), "skill", "npm:pkg", "core");
    catalog = togglePackage(catalog, "skill"); // core → useful
    const result = togglePackage(catalog, "skill"); // useful → debatable
    expect(result.packages["skill"].rating).toBe("debatable");
  });

  it("cycles debatable → disabled", () => {
    let catalog = addPackage(emptyCatalog(), "skill", "npm:pkg", "core");
    catalog = togglePackage(catalog, "skill"); // core → useful
    catalog = togglePackage(catalog, "skill"); // useful → debatable
    const result = togglePackage(catalog, "skill"); // debatable → disabled
    expect(result.packages["skill"].rating).toBe("disabled");
  });

  it("cycles disabled → core (wraps around)", () => {
    let catalog = addPackage(emptyCatalog(), "skill", "npm:pkg", "core");
    catalog = togglePackage(catalog, "skill"); // core → useful
    catalog = togglePackage(catalog, "skill"); // useful → debatable
    catalog = togglePackage(catalog, "skill"); // debatable → disabled
    const result = togglePackage(catalog, "skill"); // disabled → core
    expect(result.packages["skill"].rating).toBe("core");
  });

  it("throws when package not found", () => {
    const catalog = emptyCatalog();
    expect(() => togglePackage(catalog, "nonexistent")).toThrow(/not found/i);
  });

  it("does not mutate the original catalog", () => {
    const catalog = addPackage(
      emptyCatalog(),
      "skill",
      "npm:pkg",
      "core",
    );
    const result = togglePackage(catalog, "skill");
    expect(catalog.packages["skill"].rating).toBe("core");
    expect(result).not.toBe(catalog);
  });
});

// ---------------------------------------------------------------------------
// enablePackage
// ---------------------------------------------------------------------------

describe("enablePackage", () => {
  it("restores previous rating when enabling a disabled package", () => {
    let catalog = addPackage(
      emptyCatalog(),
      "skill",
      "npm:pkg",
      "useful",
    );
    catalog = disablePackage(catalog, "skill");
    expect(catalog.packages["skill"].rating).toBe("disabled");

    const result = enablePackage(catalog, "skill");
    expect(result.packages["skill"].rating).toBe("useful");
  });

  it("defaults to core when no previous rating stored", () => {
    // A package added directly with "disabled" rating has no previousRating
    const catalog = addPackage(
      emptyCatalog(),
      "skill",
      "npm:pkg",
      "disabled",
    );
    const result = enablePackage(catalog, "skill");
    expect(result.packages["skill"].rating).toBe("core");
  });

  it("is a no-op when already enabled (not disabled)", () => {
    const catalog = addPackage(
      emptyCatalog(),
      "skill",
      "npm:pkg",
      "useful",
    );
    const result = enablePackage(catalog, "skill");
    expect(result.packages["skill"].rating).toBe("useful");
  });

  it("clears previousRating after enabling", () => {
    let catalog = addPackage(
      emptyCatalog(),
      "skill",
      "npm:pkg",
      "debatable",
    );
    catalog = disablePackage(catalog, "skill");
    expect(catalog.packages["skill"].previousRating).toBe("debatable");

    const result = enablePackage(catalog, "skill");
    expect(result.packages["skill"].previousRating).toBeUndefined();
  });

  it("throws when package not found", () => {
    const catalog = emptyCatalog();
    expect(() => enablePackage(catalog, "nonexistent")).toThrow(/not found/i);
  });
});

// ---------------------------------------------------------------------------
// disablePackage
// ---------------------------------------------------------------------------

describe("disablePackage", () => {
  it("sets rating to disabled", () => {
    const catalog = addPackage(
      emptyCatalog(),
      "skill",
      "npm:pkg",
      "core",
    );
    const result = disablePackage(catalog, "skill");
    expect(result.packages["skill"].rating).toBe("disabled");
  });

  it("preserves the previous rating in previousRating field", () => {
    const catalog = addPackage(
      emptyCatalog(),
      "skill",
      "npm:pkg",
      "useful",
    );
    const result = disablePackage(catalog, "skill");
    expect(result.packages["skill"].previousRating).toBe("useful");
  });

  it("throws when package not found", () => {
    const catalog = emptyCatalog();
    expect(() => disablePackage(catalog, "nonexistent")).toThrow(/not found/i);
  });

  it("does not mutate the original catalog", () => {
    const catalog = addPackage(
      emptyCatalog(),
      "skill",
      "npm:pkg",
      "core",
    );
    const result = disablePackage(catalog, "skill");
    expect(catalog.packages["skill"].rating).toBe("core");
    expect(result).not.toBe(catalog);
  });
});
