import { describe, expect, it } from "vitest";
import yaml from "js-yaml";

import {
  CatalogYamlSchema,
  LockFileSchema,
  type CatalogYaml,
  type LockFile,
} from "../../src/config/schema.js";

// ---------------------------------------------------------------------------
// cat.yaml  —  valid documents
// ---------------------------------------------------------------------------

describe("CatalogYamlSchema (cat.yaml)", () => {
  const validMinimal: CatalogYaml = {
    meta: { pi_version: "1.0.0" },
    packages: {
      "my-skill": {
        source: "https://github.com/example/my-skill",
        rating: "core",
      },
    },
  };

  it("parses a minimal valid document", () => {
    const parsed = CatalogYamlSchema.parse(validMinimal);
    expect(parsed.meta.pi_version).toBe("1.0.0");
    expect(parsed.packages["my-skill"].source).toBe(
      "https://github.com/example/my-skill",
    );
    expect(parsed.packages["my-skill"].rating).toBe("core");
  });

  it("parses a document with optional type and profile fields", () => {
    const doc: CatalogYaml = {
      meta: { pi_version: "2.0.0" },
      packages: {
        "my-skill": {
          source: "https://github.com/example/my-skill",
          rating: "useful",
          type: "skill",
          profile: "default",
        },
        "another-pkg": {
          source: "https://github.com/example/pkg",
          rating: "debatable",
          type: "pi-native",
        },
      },
    };
    const parsed = CatalogYamlSchema.parse(doc);
    expect(parsed.packages["my-skill"].type).toBe("skill");
    expect(parsed.packages["my-skill"].profile).toBe("default");
    expect(parsed.packages["another-pkg"].type).toBe("pi-native");
    // profile is optional and should be undefined when omitted
    expect(parsed.packages["another-pkg"].profile).toBeUndefined();
  });

  it("parses YAML string into valid catalog", () => {
    const yamlStr = `
meta:
  pi_version: "1.0.0"
packages:
  hello-world:
    source: "https://github.com/example/hello"
    rating: "core"
    type: skill
    profile: work
`;
    const raw = yaml.load(yamlStr);
    const parsed = CatalogYamlSchema.parse(raw);
    expect(parsed.packages["hello-world"].source).toBe(
      "https://github.com/example/hello",
    );
    expect(parsed.packages["hello-world"].type).toBe("skill");
  });

  // -----------------------------------------------------------------------
  // cat.yaml  —  failure cases
  // -----------------------------------------------------------------------

  it("rejects a document missing meta", () => {
    const { meta: _, ...noMeta } = validMinimal;
    expect(() => CatalogYamlSchema.parse(noMeta)).toThrow();
  });

  it("rejects a document missing pi_version in meta", () => {
    const doc = { meta: {}, packages: {} };
    expect(() => CatalogYamlSchema.parse(doc)).toThrow();
  });

  it("rejects a document missing packages", () => {
    const { packages: _, ...noPackages } = validMinimal;
    expect(() => CatalogYamlSchema.parse(noPackages)).toThrow();
  });

  it("rejects a package entry missing source", () => {
    const doc = {
      meta: { pi_version: "1.0.0" },
      packages: {
        bad: { rating: "core" },
      },
    };
    expect(() => CatalogYamlSchema.parse(doc)).toThrow();
  });

  it("rejects a package entry missing rating", () => {
    const doc = {
      meta: { pi_version: "1.0.0" },
      packages: {
        bad: { source: "https://github.com/example/bad" },
      },
    };
    expect(() => CatalogYamlSchema.parse(doc)).toThrow();
  });

  it("rejects an invalid type value", () => {
    const doc = {
      meta: { pi_version: "1.0.0" },
      packages: {
        bad: {
          source: "https://github.com/example/bad",
          rating: "core",
          type: "invalid-type",
        },
      },
    };
    expect(() => CatalogYamlSchema.parse(doc)).toThrow();
  });

  it("rejects an invalid rating value", () => {
    const doc = {
      meta: { pi_version: "1.0.0" },
      packages: {
        bad: {
          source: "https://github.com/example/bad",
          rating: "invalid",
        },
      },
    };
    expect(() => CatalogYamlSchema.parse(doc)).toThrow();
  });
});

// ---------------------------------------------------------------------------
// catalog.lock.json  —  valid documents
// ---------------------------------------------------------------------------

describe("LockFileSchema (catalog.lock.json)", () => {
  const validMinimal: LockFile = {
    packages: {
      "my-skill": {
        version: "1.2.3",
        contentHash: "sha256-abcdef123456",
        installedAt: "2026-05-29T10:00:00Z",
        syncState: "synced",
      },
    },
  };

  it("parses a minimal valid lock file", () => {
    const parsed = LockFileSchema.parse(validMinimal);
    expect(parsed.packages["my-skill"].version).toBe("1.2.3");
    expect(parsed.packages["my-skill"].contentHash).toBe(
      "sha256-abcdef123456",
    );
    expect(parsed.packages["my-skill"].installedAt).toBe(
      "2026-05-29T10:00:00Z",
    );
    expect(parsed.packages["my-skill"].syncState).toBe("synced");
  });

  it("parses lock file with multiple packages and different sync states", () => {
    const doc: LockFile = {
      packages: {
        "skill-a": {
          version: "0.1.0",
          contentHash: "sha256-aaa",
          installedAt: "2026-05-29T10:00:00Z",
          syncState: "synced",
        },
        "skill-b": {
          version: "2.0.0",
          contentHash: "sha256-bbb",
          installedAt: "2026-05-28T08:30:00Z",
          syncState: "outdated",
        },
        "skill-c": {
          version: "3.0.0",
          contentHash: "sha256-ccc",
          installedAt: "2026-05-27T12:00:00Z",
          syncState: "conflict",
        },
      },
    };
    const parsed = LockFileSchema.parse(doc);
    expect(Object.keys(parsed.packages)).toHaveLength(3);
    expect(parsed.packages["skill-b"].syncState).toBe("outdated");
    expect(parsed.packages["skill-c"].syncState).toBe("conflict");
  });

  it("parses lock file from JSON string", () => {
    const json = JSON.stringify(validMinimal);
    const raw = JSON.parse(json);
    const parsed = LockFileSchema.parse(raw);
    expect(parsed).toEqual(validMinimal);
  });

  // -----------------------------------------------------------------------
  // catalog.lock.json  —  failure cases
  // -----------------------------------------------------------------------

  it("rejects a lock file missing packages", () => {
    expect(() => LockFileSchema.parse({})).toThrow();
  });

  it("rejects a package entry missing version", () => {
    const doc = {
      packages: {
        bad: {
          contentHash: "sha256-abc",
          installedAt: "2026-05-29T10:00:00Z",
          syncState: "synced",
        },
      },
    };
    expect(() => LockFileSchema.parse(doc)).toThrow();
  });

  it("rejects a package entry missing contentHash", () => {
    const doc = {
      packages: {
        bad: {
          version: "1.0.0",
          installedAt: "2026-05-29T10:00:00Z",
          syncState: "synced",
        },
      },
    };
    expect(() => LockFileSchema.parse(doc)).toThrow();
  });

  it("rejects a package entry missing installedAt", () => {
    const doc = {
      packages: {
        bad: {
          version: "1.0.0",
          contentHash: "sha256-abc",
          syncState: "synced",
        },
      },
    };
    expect(() => LockFileSchema.parse(doc)).toThrow();
  });

  it("rejects a package entry missing syncState", () => {
    const doc = {
      packages: {
        bad: {
          version: "1.0.0",
          contentHash: "sha256-abc",
          installedAt: "2026-05-29T10:00:00Z",
        },
      },
    };
    expect(() => LockFileSchema.parse(doc)).toThrow();
  });

  it("rejects an invalid syncState value", () => {
    const doc = {
      packages: {
        bad: {
          version: "1.0.0",
          contentHash: "sha256-abc",
          installedAt: "2026-05-29T10:00:00Z",
          syncState: "invalid",
        },
      },
    };
    expect(() => LockFileSchema.parse(doc)).toThrow();
  });
});
