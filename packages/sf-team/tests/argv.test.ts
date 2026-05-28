import { describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  buildPiArgv,
  defaultResolveAzureFoundryDeploymentIds,
  defaultResolveAzureFoundryProvider,
  defaultResolveCursorProvider,
  DEVELOPER_PROFILE_FLAGS,
  PLANNER_PROFILE_FLAGS,
  REVIEWER_PROFILE_FLAGS,
} from "../src/runtime/argv";
import type { TeamMember } from "../src/runtime/types";

describe("M4 buildPiArgv: reviewer profile (immutable)", () => {
  const reviewer: TeamMember = { role: "reviewer", model: "claude-opus-4-7", thinking: "xhigh", skills: ["should-be-ignored"] };

  it("snapshot of reviewer argv with --append-system-prompt", () => {
    const argv = buildPiArgv(reviewer, "review-task", { appendSystemPromptPath: "/tmp/sp.md" });
    expect(argv).toEqual([
      "--mode",
      "json",
      "--no-session",
      "--no-skills",
      "--no-prompt-templates",
      "--no-extensions",
      "--no-context-files",
      "--tools",
      "read,grep,find,ls",
      "--model",
      "claude-opus-4-7",
      "--thinking",
      "xhigh",
      "--append-system-prompt",
      "/tmp/sp.md",
      "-p",
      "review-task",
    ]);
  });

  it("contains every locked isolation flag", () => {
    const argv = buildPiArgv(reviewer, "t");
    for (const flag of REVIEWER_PROFILE_FLAGS) {
      expect(argv).toContain(flag);
    }
    expect(argv).toContain("--tools");
    expect(argv).toContain("read,grep,find,ls");
  });

  it("NEVER includes --skill even when member.skills is non-empty", () => {
    const argv = buildPiArgv(reviewer, "t", { resolveSkill: () => "/should/not/appear" });
    expect(argv).not.toContain("--skill");
  });

  it("does not include any planner/dev-only flags that would break isolation", () => {
    const argv = buildPiArgv(reviewer, "t");
    // Sanity: no --enable-skill or any other variant
    expect(argv.find((a) => a.startsWith("--enable-"))).toBeUndefined();
  });
});

describe("M4 buildPiArgv: planner / developer profile", () => {
  it("planner: uses a read-only profile and never receives skills", () => {
    const planner: TeamMember = {
      role: "planner",
      model: "claude-opus-4-7",
      thinking: "high",
      skills: ["brainstorming", "writing-plans", "missing-skill"],
    };
    const argv = buildPiArgv(planner, "plan-task", {
      resolveSkill: (name) =>
        name === "brainstorming"
          ? "/abs/brainstorming"
          : name === "writing-plans"
          ? "/abs/writing-plans"
          : undefined,
    });
    expect(argv).toEqual([
      ...PLANNER_PROFILE_FLAGS,
      "--model",
      "claude-opus-4-7",
      "--thinking",
      "high",
      "-p",
      "plan-task",
    ]);
    expect(argv).toContain("--tools");
    expect(argv).toContain("read,grep,find,ls");
    expect(argv).not.toContain("--skill");
  });

  it("developer: remains write-capable and skill-enabled", () => {
    const dev: TeamMember = { role: "developer", model: "m", skills: ["tdd"] };
    const argv = buildPiArgv(dev, "t", { resolveSkill: () => "/abs/tdd" });
    expect(argv).toContain("--skill");
    expect(argv).toContain("/abs/tdd");
    expect(argv.slice(0, DEVELOPER_PROFILE_FLAGS.length)).toEqual([...DEVELOPER_PROFILE_FLAGS]);
    expect(argv).not.toContain("--no-skills");
  });

  it("developer: blocks prompt templates and extensions but keeps repo context files", () => {
    const dev: TeamMember = { role: "developer", model: "m", skills: ["tdd"] };
    const argv = buildPiArgv(dev, "t", { resolveSkill: () => "/abs/tdd" });
    expect(argv).toContain("--no-prompt-templates");
    expect(argv).toContain("--no-extensions");
    expect(argv).not.toContain("--no-context-files");
    expect(argv).not.toContain("--no-skills");
    expect(argv).toContain("--skill");
  });

  it("missing skill is silently dropped (warn-and-continue is the orchestrator's job)", () => {
    const dev: TeamMember = { role: "developer", model: "m", skills: ["nope"] };
    const argv = buildPiArgv(dev, "t", { resolveSkill: () => undefined });
    expect(argv).not.toContain("--skill");
  });
});

describe("buildPiArgv: cursor-provider conditional --extension load", () => {
  // The cursor provider lives in a workspace-sibling extension. Every role
  // profile pins --no-extensions for isolation; that means cursor/* models
  // would fail with "Model not found" because the provider never loads.
  // The fix appends an explicit `--extension <path>` ONLY when:
  //   (a) the requested model starts with "cursor/", AND
  //   (b) the resolver returns an existing path.
  // pi's --no-extensions docs guarantee "explicit -e paths still work",
  // so we keep the isolation flag and only add the one extension we need.

  it("researcher with cursor/* model: appends --extension <path> when resolver returns one", () => {
    const member: TeamMember = { role: "researcher", model: "cursor/composer-2" };
    const argv = buildPiArgv(member, "t", { resolveCursorProvider: () => "/abs/cursor-provider.ts" });
    expect(argv).toContain("--extension");
    expect(argv).toContain("/abs/cursor-provider.ts");
    // Isolation flag MUST stay — auto-discovery of other extensions remains off.
    expect(argv).toContain("--no-extensions");
    // The extension flag appears AFTER the model (so a reader of argv can
    // see model→provider mapping in order).
    const modelIdx = argv.indexOf("--model");
    const extIdx = argv.indexOf("--extension");
    expect(extIdx).toBeGreaterThan(modelIdx);
  });

  it("planner with cursor/* model: same gate (resolver returns path → --extension added)", () => {
    const member: TeamMember = { role: "planner", model: "cursor/gpt-5.3-codex-spark-preview" };
    const argv = buildPiArgv(member, "t", { resolveCursorProvider: () => "/abs/cursor-provider.ts" });
    expect(argv).toContain("--extension");
    expect(argv).toContain("/abs/cursor-provider.ts");
    expect(argv).toContain("--no-extensions");
  });

  it("reviewer with cursor/* model: same gate, isolation tools list unchanged", () => {
    const member: TeamMember = { role: "reviewer", model: "cursor/claude-4.6-opus" };
    const argv = buildPiArgv(member, "t", { resolveCursorProvider: () => "/abs/cursor-provider.ts" });
    expect(argv).toContain("--extension");
    expect(argv).toContain("/abs/cursor-provider.ts");
    // Reviewer's read-only tool allowlist must NOT be widened by the extension load.
    expect(argv).toContain("--tools");
    expect(argv).toContain("read,grep,find,ls");
  });

  it("developer with cursor/* model: same gate, --skill wiring still works", () => {
    const member: TeamMember = { role: "developer", model: "cursor/claude-4.6-sonnet-thinking", skills: ["tdd"] };
    const argv = buildPiArgv(member, "t", {
      resolveCursorProvider: () => "/abs/cursor-provider.ts",
      resolveSkill: () => "/abs/tdd",
    });
    expect(argv).toContain("--extension");
    expect(argv).toContain("/abs/cursor-provider.ts");
    expect(argv).toContain("--skill");
    expect(argv).toContain("/abs/tdd");
  });

  it("cursor/* model + resolver returns undefined: --extension is NOT added (graceful fall-through)", () => {
    const member: TeamMember = { role: "developer", model: "cursor/composer-2" };
    const argv = buildPiArgv(member, "t", { resolveCursorProvider: () => undefined });
    expect(argv).not.toContain("--extension");
    // Existing behavior preserved: pi will still reject the cursor/ model
    // because --no-extensions is still in place. The orchestrator's error
    // surface stays identical to today's "Model not found" path when the
    // user has no cursor-provider installed.
    expect(argv).toContain("--no-extensions");
  });

  it("non-cursor model: resolver is NEVER called — anthropic/* path stays byte-identical to today", () => {
    let calls = 0;
    const member: TeamMember = { role: "researcher", model: "anthropic/claude-haiku-4-5" };
    const argv = buildPiArgv(member, "t", {
      resolveCursorProvider: () => {
        calls += 1;
        return "/abs/cursor-provider.ts";
      },
    });
    expect(calls).toBe(0);
    expect(argv).not.toContain("--extension");
    expect(argv).toContain("--no-extensions");
  });

  it("non-cursor model (openai-codex): resolver is NEVER called", () => {
    let calls = 0;
    const member: TeamMember = { role: "reviewer", model: "openai-codex/gpt-5.5" };
    const argv = buildPiArgv(member, "t", {
      resolveCursorProvider: () => {
        calls += 1;
        return "/abs/cursor-provider.ts";
      },
    });
    expect(calls).toBe(0);
    expect(argv).not.toContain("--extension");
  });

  it("default resolver (no opts) returns the workspace cursor-provider path when present", () => {
    // The workspace ships a cursor-provider package at
    // packages/cursor-provider/extensions/cursor-provider.ts. The default
    // probe should find it, so a real cursor/* model build should append
    // --extension pointing at that real file. This is an integration check
    // against the actual repo layout.
    const resolved = defaultResolveCursorProvider();
    expect(resolved).toBeTypeOf("string");
    expect(resolved).toMatch(/cursor-provider[\\/]extensions[\\/]cursor-provider\.ts$/);
  });

  it("SF_TEAM_CURSOR_PROVIDER_PATH env override wins over the workspace probe (genuinely different path)", () => {
    // Real precedence test: point the env var at a DIFFERENT existing file
    // (a temp file) and assert the resolver returns the env value, not the
    // workspace probe value. Asserting "env value !== probe value" is the
    // only way to prove the env path took precedence.
    const probed = defaultResolveCursorProvider();
    const tmpDir = mkdtempSync(path.join(tmpdir(), "argv-test-"));
    const fakePath = path.join(tmpDir, "fake-cursor-provider.ts");
    writeFileSync(fakePath, "// stand-in for the real extension\n");
    const prev = process.env.SF_TEAM_CURSOR_PROVIDER_PATH;
    process.env.SF_TEAM_CURSOR_PROVIDER_PATH = fakePath;
    try {
      const resolved = defaultResolveCursorProvider();
      expect(resolved).toBe(fakePath);
      // Sanity: the env value really IS different from the workspace probe.
      if (probed) expect(resolved).not.toBe(probed);
    } finally {
      if (prev === undefined) delete process.env.SF_TEAM_CURSOR_PROVIDER_PATH;
      else process.env.SF_TEAM_CURSOR_PROVIDER_PATH = prev;
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("SF_TEAM_CURSOR_PROVIDER_PATH points at a missing path: silently falls through to workspace probe", () => {
    // Documented degradation: a typo in the env var should not break
    // every spawn. We fall back to the workspace probe (which the
    // monorepo always satisfies). This locks in the JSDoc'd contract.
    const prev = process.env.SF_TEAM_CURSOR_PROVIDER_PATH;
    process.env.SF_TEAM_CURSOR_PROVIDER_PATH = "/definitely/does/not/exist/cursor-provider.ts";
    try {
      const resolved = defaultResolveCursorProvider();
      // In the monorepo the workspace probe finds the real file; outside
      // the monorepo it returns undefined. Either way, the env-set-but-
      // missing path MUST NOT be returned.
      expect(resolved).not.toBe("/definitely/does/not/exist/cursor-provider.ts");
    } finally {
      if (prev === undefined) delete process.env.SF_TEAM_CURSOR_PROVIDER_PATH;
      else process.env.SF_TEAM_CURSOR_PROVIDER_PATH = prev;
    }
  });
});

describe("buildPiArgv: azure-foundry-provider conditional --extension load", () => {
  // The azure-foundry provider lives in a workspace-sibling extension that
  // registers Azure deployments as native pi providers. Every role profile
  // pins --no-extensions for isolation; that means azure-foundry/* models
  // would fail with "Model not found" because the extension never loads.
  // The fix mirrors the cursor branch: append `--extension <path>` when
  //   (a) the requested model prefix matches a configured deployment ID,
  //   AND
  //   (b) the resolver returns an existing path.
  // The cursor/ namespace is structurally hard-reserved (an `if cursor/ ...
  // else { azure ... }` control flow guarantees at most one --extension
  // load per spawn). Other prefix collisions (e.g., a deployment named
  // `anthropic`) follow user intent and DO load the azure extension.

  const azureIds = (ids: string[]) => () => ids;
  const azurePath = (p: string | undefined) => () => p;
  const failIfCalled = <T>(label: string): (() => T) => () => {
    throw new Error(`${label} must not be called`);
  };

  describe("matching-deployment-ID, path returned", () => {
    it("reviewer with azure-foundry/Kimi-K2.6 + ids=['azure-foundry'] + path → --extension appears after --model and isolation flags intact", () => {
      const member: TeamMember = { role: "reviewer", model: "azure-foundry/Kimi-K2.6", thinking: "high" };
      const argv = buildPiArgv(member, "review-task", {
        resolveAzureFoundryDeploymentIds: azureIds(["azure-foundry"]),
        resolveAzureFoundryProvider: azurePath("/abs/azure-foundry-provider.ts"),
      });
      expect(argv).toContain("--extension");
      expect(argv).toContain("/abs/azure-foundry-provider.ts");
      // Isolation flag stays — auto-discovery of other extensions remains off.
      expect(argv).toContain("--no-extensions");
      // Reviewer's read-only tool allowlist must not be widened.
      expect(argv).toContain("--tools");
      expect(argv).toContain("read,grep,find,ls");
      // --extension comes AFTER --model so the model→provider mapping is readable.
      const modelIdx = argv.indexOf("--model");
      const extIdx = argv.indexOf("--extension");
      expect(extIdx).toBeGreaterThan(modelIdx);
      // Exactly one --extension flag (the structural if/else guarantees this).
      expect(argv.filter((a) => a === "--extension")).toHaveLength(1);
    });

    it("planner with azure-foundry/Kimi-K2.6 + ids=['azure-foundry'] + path → --extension added, planner profile preserved", () => {
      const member: TeamMember = { role: "planner", model: "azure-foundry/Kimi-K2.6", thinking: "medium" };
      const argv = buildPiArgv(member, "plan-task", {
        resolveAzureFoundryDeploymentIds: azureIds(["azure-foundry"]),
        resolveAzureFoundryProvider: azurePath("/abs/azure-foundry-provider.ts"),
      });
      expect(argv).toContain("--extension");
      expect(argv).toContain("/abs/azure-foundry-provider.ts");
      for (const flag of PLANNER_PROFILE_FLAGS) {
        expect(argv).toContain(flag);
      }
    });

    it("researcher with azure-foundry/Kimi-K2.6 + ids=['azure-foundry'] + path → --extension added", () => {
      const member: TeamMember = { role: "researcher", model: "azure-foundry/Kimi-K2.6" };
      const argv = buildPiArgv(member, "research-task", {
        resolveAzureFoundryDeploymentIds: azureIds(["azure-foundry"]),
        resolveAzureFoundryProvider: azurePath("/abs/azure-foundry-provider.ts"),
      });
      expect(argv).toContain("--extension");
      expect(argv).toContain("/abs/azure-foundry-provider.ts");
    });

    it("developer with azure-foundry/Kimi-K2.6 + ids=['azure-foundry'] + path → --extension added, --skill wiring still works", () => {
      const member: TeamMember = { role: "developer", model: "azure-foundry/Kimi-K2.6", skills: ["tdd"] };
      const argv = buildPiArgv(member, "dev-task", {
        resolveAzureFoundryDeploymentIds: azureIds(["azure-foundry"]),
        resolveAzureFoundryProvider: azurePath("/abs/azure-foundry-provider.ts"),
        resolveSkill: () => "/abs/tdd",
      });
      expect(argv).toContain("--extension");
      expect(argv).toContain("/abs/azure-foundry-provider.ts");
      expect(argv).toContain("--skill");
      expect(argv).toContain("/abs/tdd");
    });

    it("custom deployment id (azure-foundry-west) + matching model → --extension added", () => {
      const member: TeamMember = { role: "reviewer", model: "azure-foundry-west/Kimi-K2.6" };
      const argv = buildPiArgv(member, "t", {
        resolveAzureFoundryDeploymentIds: azureIds(["azure-foundry-west"]),
        resolveAzureFoundryProvider: azurePath("/abs/azure-foundry-provider.ts"),
      });
      expect(argv).toContain("--extension");
      expect(argv).toContain("/abs/azure-foundry-provider.ts");
    });

    it("multiple deployment ids: any one match triggers the extension (model matches the second)", () => {
      const member: TeamMember = { role: "reviewer", model: "azure-foundry-west/Kimi-K2.6" };
      const argv = buildPiArgv(member, "t", {
        resolveAzureFoundryDeploymentIds: azureIds(["azure-foundry", "azure-foundry-west"]),
        resolveAzureFoundryProvider: azurePath("/abs/azure-foundry-provider.ts"),
      });
      expect(argv).toContain("--extension");
      expect(argv).toContain("/abs/azure-foundry-provider.ts");
    });
  });

  describe("matching-deployment-ID, path resolver returns undefined", () => {
    it("graceful fall-through: no --extension appended, no throw", () => {
      const member: TeamMember = { role: "reviewer", model: "azure-foundry/Kimi-K2.6" };
      const argv = buildPiArgv(member, "t", {
        resolveAzureFoundryDeploymentIds: azureIds(["azure-foundry"]),
        resolveAzureFoundryProvider: azurePath(undefined),
      });
      expect(argv).not.toContain("--extension");
      // Isolation flag preserved; pi will surface the original "Model not found".
      expect(argv).toContain("--no-extensions");
    });
  });

  describe("empty deployment-IDs list", () => {
    it("path resolver MUST NOT be called when ids is empty", () => {
      const member: TeamMember = { role: "reviewer", model: "azure-foundry/Kimi-K2.6" };
      const argv = buildPiArgv(member, "t", {
        resolveAzureFoundryDeploymentIds: azureIds([]),
        resolveAzureFoundryProvider: failIfCalled("azure-foundry path resolver"),
      });
      expect(argv).not.toContain("--extension");
    });
  });

  describe("byte-identity for non-azure-matching models (non-colliding ids)", () => {
    // The baseline is a HARDCODED expected argv that does not depend on
    // the developer's real ~/.pi/azure-foundry/config.json (per impl-review
    // round-1 P2: the previous test design called `buildPiArgv()` without
    // overriding the resolvers and would therefore drift on machines that
    // happened to configure colliding deployment IDs).

    it("anthropic/* + ids=['azure-foundry'] → argv equals the pre-change reviewer argv exactly", () => {
      const member: TeamMember = { role: "reviewer", model: "anthropic/claude-opus-4-7" };
      const argv = buildPiArgv(member, "t", {
        resolveAzureFoundryDeploymentIds: azureIds(["azure-foundry"]),
        resolveAzureFoundryProvider: failIfCalled("azure-foundry path resolver"),
      });
      expect(argv).toEqual([
        ...REVIEWER_PROFILE_FLAGS,
        "--model",
        "anthropic/claude-opus-4-7",
        "-p",
        "t",
      ]);
    });

    it("openai-codex/* + ids=['azure-foundry'] → argv equals the pre-change reviewer argv exactly", () => {
      const member: TeamMember = { role: "reviewer", model: "openai-codex/gpt-5.5" };
      const argv = buildPiArgv(member, "t", {
        resolveAzureFoundryDeploymentIds: azureIds(["azure-foundry"]),
        resolveAzureFoundryProvider: failIfCalled("azure-foundry path resolver"),
      });
      expect(argv).toEqual([
        ...REVIEWER_PROFILE_FLAGS,
        "--model",
        "openai-codex/gpt-5.5",
        "-p",
        "t",
      ]);
    });

    it("plain alias (no slash) + ids=['azure-foundry'] → argv equals the pre-change reviewer argv exactly", () => {
      const member: TeamMember = { role: "reviewer", model: "claude-opus-4-7" };
      const argv = buildPiArgv(member, "t", {
        resolveAzureFoundryDeploymentIds: azureIds(["azure-foundry"]),
        resolveAzureFoundryProvider: failIfCalled("azure-foundry path resolver"),
      });
      expect(argv).toEqual([
        ...REVIEWER_PROFILE_FLAGS,
        "--model",
        "claude-opus-4-7",
        "-p",
        "t",
      ]);
    });

    it("default resolvers + ids=[] (no Azure config) + anthropic/* → argv equals the pre-change reviewer argv exactly", () => {
      // Locks in the env-independent guarantee: when the user has no
      // Azure deployments configured, the new branch is structurally
      // inert and argv is bit-for-bit identical to today.
      const member: TeamMember = { role: "reviewer", model: "anthropic/claude-opus-4-7" };
      const argv = buildPiArgv(member, "t", {
        resolveAzureFoundryDeploymentIds: () => [],
        resolveAzureFoundryProvider: failIfCalled("azure-foundry path resolver"),
      });
      expect(argv).toEqual([
        ...REVIEWER_PROFILE_FLAGS,
        "--model",
        "anthropic/claude-opus-4-7",
        "-p",
        "t",
      ]);
    });
  });

  describe("cursor namespace is structurally hard-reserved", () => {
    // The cursor/ branch in buildPiArgv runs INSTEAD of the azure branch
    // (if/else). Tests confirm the azure branch is bypassed regardless of
    // azure config, so a deployment named `cursor` can never inject a
    // second --extension or override cursor handling.

    it("cursor/* + ids=['cursor'] + cursor resolver returns path → ONLY cursor --extension, azure resolvers NOT called", () => {
      const member: TeamMember = { role: "reviewer", model: "cursor/composer-2" };
      const argv = buildPiArgv(member, "t", {
        resolveCursorProvider: () => "/abs/cursor-provider.ts",
        resolveAzureFoundryDeploymentIds: failIfCalled("azure-foundry ids resolver"),
        resolveAzureFoundryProvider: failIfCalled("azure-foundry path resolver"),
      });
      // Exactly one --extension and it is the cursor path.
      expect(argv.filter((a) => a === "--extension")).toHaveLength(1);
      expect(argv).toContain("/abs/cursor-provider.ts");
      expect(argv).not.toContain("/abs/azure-foundry-provider.ts");
    });

    it("cursor/* + ids=['cursor'] + cursor resolver returns undefined → NO --extension (azure does NOT rescue)", () => {
      const member: TeamMember = { role: "reviewer", model: "cursor/composer-2" };
      const argv = buildPiArgv(member, "t", {
        resolveCursorProvider: () => undefined,
        resolveAzureFoundryDeploymentIds: failIfCalled("azure-foundry ids resolver"),
        resolveAzureFoundryProvider: failIfCalled("azure-foundry path resolver"),
      });
      expect(argv).not.toContain("--extension");
    });

    it("structural enumeration: cursor/* model bypasses azure branch for any colliding deployment id", () => {
      const colliders = ["cursor", "anthropic", "openai-codex", "google"];
      for (const id of colliders) {
        const member: TeamMember = { role: "reviewer", model: "cursor/composer-2" };
        const argv = buildPiArgv(member, "t", {
          resolveCursorProvider: () => "/abs/cursor-provider.ts",
          // Even when the azure config "claims" the cursor prefix, the
          // structural if/else means azure resolvers must NOT run.
          resolveAzureFoundryDeploymentIds: failIfCalled(`azure ids resolver (id=${id})`),
          resolveAzureFoundryProvider: failIfCalled(`azure path resolver (id=${id})`),
        });
        expect(argv.filter((a) => a === "--extension")).toHaveLength(1);
        expect(argv).toContain("/abs/cursor-provider.ts");
      }
    });
  });

  describe("explicit-collision: user intentionally names a deployment after a built-in", () => {
    // Documented trade-off (Assumption #8): if a user names an azure
    // deployment after a built-in pi provider prefix (other than `cursor`,
    // which is structurally reserved), they explicitly want sf-team to
    // route that prefix through the azure-foundry extension. Tests lock
    // this in so it cannot regress silently.

    it("ids=['anthropic'] + model=anthropic/claude-opus-4-7 + path returned → --extension IS appended (intentional)", () => {
      const member: TeamMember = { role: "reviewer", model: "anthropic/claude-opus-4-7" };
      const argv = buildPiArgv(member, "t", {
        resolveAzureFoundryDeploymentIds: azureIds(["anthropic"]),
        resolveAzureFoundryProvider: azurePath("/abs/azure-foundry-provider.ts"),
      });
      expect(argv).toContain("--extension");
      expect(argv).toContain("/abs/azure-foundry-provider.ts");
      expect(argv.filter((a) => a === "--extension")).toHaveLength(1);
    });

    it("ids=['anthropic'] + model=anthropic/claude-opus-4-7 + path undefined → NO --extension (graceful fallthrough)", () => {
      const member: TeamMember = { role: "reviewer", model: "anthropic/claude-opus-4-7" };
      const argv = buildPiArgv(member, "t", {
        resolveAzureFoundryDeploymentIds: azureIds(["anthropic"]),
        resolveAzureFoundryProvider: azurePath(undefined),
      });
      expect(argv).not.toContain("--extension");
    });
  });

  describe("defaultResolveAzureFoundryProvider", () => {
    it("returns the workspace azure-foundry-provider path in the monorepo", () => {
      const resolved = defaultResolveAzureFoundryProvider();
      expect(resolved).toBeTypeOf("string");
      expect(resolved).toMatch(/azure-foundry-provider[\\/]extensions[\\/]azure-foundry-provider\.ts$/);
    });

    it("SF_TEAM_AZURE_FOUNDRY_PROVIDER_PATH env override wins over workspace probe when the path exists", () => {
      const probed = defaultResolveAzureFoundryProvider();
      const tmpDir = mkdtempSync(path.join(tmpdir(), "argv-azure-test-"));
      const fakePath = path.join(tmpDir, "fake-azure-foundry-provider.ts");
      writeFileSync(fakePath, "// stand-in for the real extension\n");
      const prev = process.env.SF_TEAM_AZURE_FOUNDRY_PROVIDER_PATH;
      process.env.SF_TEAM_AZURE_FOUNDRY_PROVIDER_PATH = fakePath;
      try {
        const resolved = defaultResolveAzureFoundryProvider();
        expect(resolved).toBe(fakePath);
        if (probed) expect(resolved).not.toBe(probed);
      } finally {
        if (prev === undefined) delete process.env.SF_TEAM_AZURE_FOUNDRY_PROVIDER_PATH;
        else process.env.SF_TEAM_AZURE_FOUNDRY_PROVIDER_PATH = prev;
        rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it("SF_TEAM_AZURE_FOUNDRY_PROVIDER_PATH points at a missing path: silently falls through to workspace probe", () => {
      const prev = process.env.SF_TEAM_AZURE_FOUNDRY_PROVIDER_PATH;
      process.env.SF_TEAM_AZURE_FOUNDRY_PROVIDER_PATH = "/definitely/does/not/exist/azure-foundry-provider.ts";
      try {
        const resolved = defaultResolveAzureFoundryProvider();
        expect(resolved).not.toBe("/definitely/does/not/exist/azure-foundry-provider.ts");
      } finally {
        if (prev === undefined) delete process.env.SF_TEAM_AZURE_FOUNDRY_PROVIDER_PATH;
        else process.env.SF_TEAM_AZURE_FOUNDRY_PROVIDER_PATH = prev;
      }
    });
  });

  describe("defaultResolveAzureFoundryDeploymentIds", () => {
    // The resolver MUST be read-only: no writeSeed, no writeSchemaFile.
    // It reads the same path the provider uses (~/.pi/azure-foundry/config.json
    // by default; PI_AZURE_FOUNDRY_CONFIG env override). It parses JSONC
    // so user configs with // and /* */ comments work.

    const withConfigPath = <T>(configPath: string | undefined, fn: () => T): T => {
      const prev = process.env.PI_AZURE_FOUNDRY_CONFIG;
      if (configPath === undefined) delete process.env.PI_AZURE_FOUNDRY_CONFIG;
      else process.env.PI_AZURE_FOUNDRY_CONFIG = configPath;
      try {
        return fn();
      } finally {
        if (prev === undefined) delete process.env.PI_AZURE_FOUNDRY_CONFIG;
        else process.env.PI_AZURE_FOUNDRY_CONFIG = prev;
      }
    };

    it("returns [] when the config file is absent and does not create the file (no side effects)", () => {
      const tmpDir = mkdtempSync(path.join(tmpdir(), "argv-azure-cfg-"));
      const missing = path.join(tmpDir, "config.json");
      try {
        const ids = withConfigPath(missing, () => defaultResolveAzureFoundryDeploymentIds());
        expect(ids).toEqual([]);
        // CRITICAL: no writeSeed / writeSchemaFile side effects.
        expect(existsSync(missing)).toBe(false);
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it("returns [] and does not throw on malformed JSON", () => {
      const tmpDir = mkdtempSync(path.join(tmpdir(), "argv-azure-cfg-"));
      const cfg = path.join(tmpDir, "config.json");
      writeFileSync(cfg, "{ not valid json }\n");
      try {
        const ids = withConfigPath(cfg, () => defaultResolveAzureFoundryDeploymentIds());
        expect(ids).toEqual([]);
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it("returns [] when deployments field is missing", () => {
      const tmpDir = mkdtempSync(path.join(tmpdir(), "argv-azure-cfg-"));
      const cfg = path.join(tmpDir, "config.json");
      writeFileSync(cfg, '{ "$schema": "./config.schema.json" }\n');
      try {
        const ids = withConfigPath(cfg, () => defaultResolveAzureFoundryDeploymentIds());
        expect(ids).toEqual([]);
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it("returns [] when deployments is not an array", () => {
      const tmpDir = mkdtempSync(path.join(tmpdir(), "argv-azure-cfg-"));
      const cfg = path.join(tmpDir, "config.json");
      writeFileSync(cfg, '{ "deployments": "oops" }\n');
      try {
        const ids = withConfigPath(cfg, () => defaultResolveAzureFoundryDeploymentIds());
        expect(ids).toEqual([]);
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it("strips JSONC comments before parsing (line + block)", () => {
      const tmpDir = mkdtempSync(path.join(tmpdir(), "argv-azure-cfg-"));
      const cfg = path.join(tmpDir, "config.json");
      writeFileSync(
        cfg,
        `{
  // line comment
  "deployments": [
    {
      "id": "azure-foundry",
      "name": "Azure Foundry"
      /* block comment
         spanning lines */
    }
  ]
}
`,
      );
      try {
        const ids = withConfigPath(cfg, () => defaultResolveAzureFoundryDeploymentIds());
        expect(ids).toEqual(["azure-foundry"]);
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it("returns deployments[].id list (happy path with single deployment)", () => {
      const tmpDir = mkdtempSync(path.join(tmpdir(), "argv-azure-cfg-"));
      const cfg = path.join(tmpDir, "config.json");
      writeFileSync(cfg, '{ "deployments": [ { "id": "azure-foundry", "name": "n" } ] }\n');
      try {
        const ids = withConfigPath(cfg, () => defaultResolveAzureFoundryDeploymentIds());
        expect(ids).toEqual(["azure-foundry"]);
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it("filters out non-string, empty, and duplicate ids", () => {
      const tmpDir = mkdtempSync(path.join(tmpdir(), "argv-azure-cfg-"));
      const cfg = path.join(tmpDir, "config.json");
      writeFileSync(
        cfg,
        JSON.stringify({
          deployments: [
            { id: "azure-foundry" },
            { id: "" },
            { id: 42 },
            { id: "azure-foundry" },
            { id: "azure-foundry-west" },
          ],
        }),
      );
      try {
        const ids = withConfigPath(cfg, () => defaultResolveAzureFoundryDeploymentIds());
        expect(ids).toEqual(["azure-foundry", "azure-foundry-west"]);
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    });
  });
});
