import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { ConfigValidationError, deepMerge, loadConfig } from "../src/config/load";
import { parseModelString } from "../src/config/model-string";

function makeFakeHome(): { home: string; dispose: () => void } {
  const home = mkdtempSync(path.join(tmpdir(), "ct-home-"));
  return { home, dispose: () => rmSync(home, { recursive: true, force: true }) };
}

function makeFakeRepo(): { repo: string; dispose: () => void } {
  const repo = mkdtempSync(path.join(tmpdir(), "ct-repo-"));
  return { repo, dispose: () => rmSync(repo, { recursive: true, force: true }) };
}

describe("M2: parseModelString", () => {
  it("returns model only when no colon present", () => {
    expect(parseModelString("claude-opus-4-7")).toEqual({ model: "claude-opus-4-7" });
  });

  it("splits on the LAST colon when RHS is a known thinking level", () => {
    expect(parseModelString("claude-opus-4-7:high")).toEqual({ model: "claude-opus-4-7", thinking: "high" });
    expect(parseModelString("anthropic/claude-opus-4-7:xhigh")).toEqual({
      model: "anthropic/claude-opus-4-7",
      thinking: "xhigh",
    });
    expect(parseModelString("openrouter:anthropic/x:medium")).toEqual({
      model: "openrouter:anthropic/x",
      thinking: "medium",
    });
  });

  it("treats colon as part of model id when RHS is NOT a thinking level", () => {
    expect(parseModelString("local:debug")).toEqual({ model: "local:debug" });
    expect(parseModelString("openrouter/anthropic/claude:foo")).toEqual({ model: "openrouter/anthropic/claude:foo" });
  });

  it("rejects empty input and bare-thinking shorthand", () => {
    expect(() => parseModelString("")).toThrow(/empty/);
    expect(() => parseModelString(":high")).toThrow(/empty/);
  });
});

describe("M2: deepMerge", () => {
  it("merges nested objects field-by-field with override winning", () => {
    expect(
      deepMerge(
        { agents: { planner: { model: "a" }, reviewer: { model: "r" } } } as never,
        { agents: { planner: { model: "b", thinking: "high" } } } as never,
      ),
    ).toEqual({
      agents: {
        planner: { model: "b", thinking: "high" },
        reviewer: { model: "r" },
      },
    });
  });

  it("override leaves untouched fields alone", () => {
    expect(deepMerge({ a: 1, b: 2 } as never, { b: 3 } as never)).toEqual({ a: 1, b: 3 });
  });
});

describe("M2: loadConfig", () => {
  it("returns {} when both files are missing (no crash)", async () => {
    const { home, dispose: dh } = makeFakeHome();
    const { repo, dispose: dr } = makeFakeRepo();
    try {
      const cfg = await loadConfig(repo, { homeDir: home });
      expect(cfg).toEqual({});
    } finally {
      dh();
      dr();
    }
  });

  it("loads only global when project is absent", async () => {
    const { home, dispose: dh } = makeFakeHome();
    const { repo, dispose: dr } = makeFakeRepo();
    try {
      const dir = path.join(home, ".pi", "sf-team");
      mkdirSync(dir, { recursive: true });
      writeFileSync(path.join(dir, "config.json"), JSON.stringify({ review: { max_rounds: 7 } }));
      const cfg = await loadConfig(repo, { homeDir: home });
      expect(cfg).toEqual({ review: { max_rounds: 7 } });
    } finally {
      dh();
      dr();
    }
  });

  it("project overrides global at field level (deep merge, not whole-object replace)", async () => {
    const { home, dispose: dh } = makeFakeHome();
    const { repo, dispose: dr } = makeFakeRepo();
    try {
      const globalDir = path.join(home, ".pi", "sf-team");
      mkdirSync(globalDir, { recursive: true });
      writeFileSync(
        path.join(globalDir, "config.json"),
        JSON.stringify({
          agents: { planner: { model: "global-planner" }, reviewer: { model: "global-reviewer" } },
          review: { max_rounds: 5 },
        }),
      );
      writeFileSync(
        path.join(repo, ".sf-team.json"),
        JSON.stringify({
          agents: { planner: { model: "project-planner", thinking: "xhigh" } },
        }),
      );
      const cfg = await loadConfig(repo, { homeDir: home });
      expect(cfg).toEqual({
        agents: {
          planner: { model: "project-planner", thinking: "xhigh" }, // project wins on planner
          reviewer: { model: "global-reviewer" }, // global preserved
        },
        review: { max_rounds: 5 },
      });
    } finally {
      dh();
      dr();
    }
  });

  it("throws ConfigValidationError with file path + JSON pointer on schema violation", async () => {
    const { home, dispose: dh } = makeFakeHome();
    const { repo, dispose: dr } = makeFakeRepo();
    try {
      writeFileSync(
        path.join(repo, ".sf-team.json"),
        JSON.stringify({ review: { max_rounds: "not-a-number" } }),
      );
      try {
        await loadConfig(repo, { homeDir: home });
        throw new Error("expected ConfigValidationError");
      } catch (err) {
        expect(err).toBeInstanceOf(ConfigValidationError);
        const cve = err as ConfigValidationError;
        expect(cve.filePath).toBe(path.join(repo, ".sf-team.json"));
        // JSON pointer must point at the offending field, not just "/"
        expect(cve.jsonPointer).toBe("/review/max_rounds");
        expect(cve.message).toMatch(/\/review\/max_rounds/);
      }
    } finally {
      dh();
      dr();
    }
  });

  it("allows project config to override only thinking on an agent (partial agent override)", async () => {
    const { home, dispose: dh } = makeFakeHome();
    const { repo, dispose: dr } = makeFakeRepo();
    try {
      const globalDir = path.join(home, ".pi", "sf-team");
      mkdirSync(globalDir, { recursive: true });
      writeFileSync(
        path.join(globalDir, "config.json"),
        JSON.stringify({ agents: { planner: { model: "claude-opus-4-7", thinking: "high" } } }),
      );
      writeFileSync(
        path.join(repo, ".sf-team.json"),
        JSON.stringify({ agents: { planner: { thinking: "xhigh" } } }),
      );
      const cfg = await loadConfig(repo, { homeDir: home });
      expect(cfg).toEqual({
        agents: { planner: { model: "claude-opus-4-7", thinking: "xhigh" } },
      });
    } finally {
      dh();
      dr();
    }
  });

  it("accepts the performance widget update interval knob", async () => {
    const { home, dispose: dh } = makeFakeHome();
    const { repo, dispose: dr } = makeFakeRepo();
    try {
      writeFileSync(
        path.join(repo, ".sf-team.json"),
        JSON.stringify({ performance: { widget_update_interval_ms: 0 } }),
      );
      const cfg = await loadConfig(repo, { homeDir: home });
      expect(cfg).toEqual({ performance: { widget_update_interval_ms: 0 } });
    } finally {
      dh();
      dr();
    }
  });

  it("rejects out-of-range performance widget update intervals", async () => {
    const { home, dispose: dh } = makeFakeHome();
    const { repo, dispose: dr } = makeFakeRepo();
    try {
      writeFileSync(
        path.join(repo, ".sf-team.json"),
        JSON.stringify({ performance: { widget_update_interval_ms: 5_001 } }),
      );
      await expect(loadConfig(repo, { homeDir: home })).rejects.toBeInstanceOf(ConfigValidationError);
    } finally {
      dh();
      dr();
    }
  });

  it("deep-merges performance policy from global and project config", async () => {
    const { home, dispose: dh } = makeFakeHome();
    const { repo, dispose: dr } = makeFakeRepo();
    try {
      const dir = path.join(home, ".pi", "sf-team");
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        path.join(dir, "config.json"),
        JSON.stringify({
          performance: { researcher: "always", plan_revision: "full", widget_update_interval_ms: 20 },
        }),
      );
      writeFileSync(
        path.join(repo, ".sf-team.json"),
        JSON.stringify({ performance: { researcher: "never" } }),
      );
      const cfg = await loadConfig(repo, { homeDir: home });
      expect(cfg).toEqual({
        performance: { researcher: "never", plan_revision: "full", widget_update_interval_ms: 20 },
      });
    } finally {
      dh();
      dr();
    }
  });

  it("accepts workflow profile and split review caps", async () => {
    const { home, dispose: dh } = makeFakeHome();
    const { repo, dispose: dr } = makeFakeRepo();
    try {
      writeFileSync(
        path.join(repo, ".sf-team.json"),
        JSON.stringify({
          workflow: { profile: "headless" },
          review: { plan_max_rounds: 2, implementation_max_rounds: 4 },
        }),
      );
      const cfg = await loadConfig(repo, { homeDir: home });
      expect(cfg).toEqual({
        workflow: { profile: "headless" },
        review: { plan_max_rounds: 2, implementation_max_rounds: 4 },
      });
    } finally {
      dh();
      dr();
    }
  });

  it("rejects invalid workflow profile and split review caps", async () => {
    const { home, dispose: dh } = makeFakeHome();
    const { repo, dispose: dr } = makeFakeRepo();
    try {
      writeFileSync(
        path.join(repo, ".sf-team.json"),
        JSON.stringify({
          workflow: { profile: "daemon" },
          review: { plan_max_rounds: 0 },
        }),
      );
      await expect(loadConfig(repo, { homeDir: home })).rejects.toBeInstanceOf(ConfigValidationError);
    } finally {
      dh();
      dr();
    }
  });

  it("rejects invalid researcher and plan revision performance policies", async () => {
    const { home, dispose: dh } = makeFakeHome();
    const { repo, dispose: dr } = makeFakeRepo();
    try {
      writeFileSync(
        path.join(repo, ".sf-team.json"),
        JSON.stringify({ performance: { researcher: "sometimes", plan_revision: "rewrite" } }),
      );
      await expect(loadConfig(repo, { homeDir: home })).rejects.toBeInstanceOf(ConfigValidationError);
    } finally {
      dh();
      dr();
    }
  });

  it("rejects unknown keys on agent objects (additionalProperties: false)", async () => {
    const { home, dispose: dh } = makeFakeHome();
    const { repo, dispose: dr } = makeFakeRepo();
    try {
      writeFileSync(
        path.join(repo, ".sf-team.json"),
        JSON.stringify({ agents: { planner: { model: "x", typo_field: "boom" } } }),
      );
      await expect(loadConfig(repo, { homeDir: home })).rejects.toBeInstanceOf(ConfigValidationError);
    } finally {
      dh();
      dr();
    }
  });

  it("throws ConfigValidationError with file path on JSON parse error", async () => {
    const { home, dispose: dh } = makeFakeHome();
    const { repo, dispose: dr } = makeFakeRepo();
    try {
      writeFileSync(path.join(repo, ".sf-team.json"), "{ this is not json");
      await expect(loadConfig(repo, { homeDir: home })).rejects.toBeInstanceOf(ConfigValidationError);
    } finally {
      dh();
      dr();
    }
  });
});
