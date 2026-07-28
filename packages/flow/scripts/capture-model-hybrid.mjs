#!/usr/bin/env node
/**
 * capture-model-hybrid.mjs — Q4 live-capture instrumentation for Issue #2.
 *
 * WHAT THIS IS
 *   A NON-PRODUCTION, manually-run evidence-gathering artifact (M3 / S-M3-1).
 *   It is deliberately EXCLUDED from vitest: it lives under `scripts/` (not
 *   `tests/`) and its filename is not a test/spec file, so vitest's default
 *   include glob (which matches only files named like foo.test.mjs or
 *   bar.spec.ts) never picks it up. There is NO automated assertion — the
 *   artifact it writes IS the evidence.
 *
 *   Run it inside the pi HOST runtime that provides
 *   @quintinshaw/pi-dynamic-workflows:
 *       node packages/flow/scripts/capture-model-hybrid.mjs
 *
 * GOAL
 *   Pin the exact deterministic trigger that turns a real model spec into a
 *   fabricated `{ provider, id }` HYBRID — the root cause of Issue #2:
 *   `buildFallbackModel` in @quintinshaw/pi-dynamic-workflows keeps one source's
 *   `provider` (from the provider's default/base model) and OVERWRITES `id` and
 *   `name` with an unresolvable `provider/modelId` pattern, producing e.g.
 *   `anthropic/gpt-5.6-terra`. Then record how the M1 `normalizeModelSpec`
 *   guard treats the captured value.
 *
 * ─── THE THREE DEBUG-LOG POINTS an operator instruments to pin the trigger ───
 *   Add a `console.error("[CAPTURE] ...")` at each of the three sites below,
 *   then grep `[CAPTURE]` from the captured stderr during a live `sf_flow_auto`
 *   run (see tests/fixtures/live-capture-runbook.md for the exact invocation).
 *
 *   1. generate.ts baked literal  — packages/flow/src/yaml/generate.ts:48
 *        `if (def?.model) parts.push(`model: ${JSON.stringify(def.model)}`);`
 *      → log the `agentOpts` `model:` value baked into a tier-2 agent script.
 *
 *   2. pi-dw explicitModel / modelSpec —
 *        @quintinshaw/pi-dynamic-workflows/dist/workflow.js ≈ lines 156–157
 *          `const explicitModel = agentOptions.model ?? agentDef?.model;`
 *          `const modelSpec = explicitModel ?? (agentOptions.tier ? undefined : resolveModelForPhase(...));`
 *      → log `modelSpec` and the orchestrator `mainModel`.
 *
 *   3. buildFallbackModel call — THE HYBRID FACTORY —
 *        @quintinshaw/pi-dynamic-workflows/dist/model-spec.js
 *          definition ≈ line 140:
 *            `function buildFallbackModel(provider, modelId, availableModels) { ... return { ...baseModel, id: modelId, name: modelId }; }`
 *          call site  ≈ line 231:
 *            `const fallbackModel = buildFallbackModel(provider, fallbackPattern, availableModels);`
 *      → log the incoming spec, `baseModel`, and the returned `{ provider, id, name }`.
 *        THIS is where a non-existent `provider/modelId` keeps `provider` from
 *        the provider's base model but overwrites `id`/`name` with the
 *        unresolvable pattern → the hybrid.
 */

import { createRequire } from "node:module";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const __dirname = dirname(fileURLToPath(import.meta.url));

// A representative real spec (the kind an operator sets) and the fabricated
// hybrid it can degrade into when the pattern cannot be resolved and
// `buildFallbackModel` splices provider+id from two sources.
const INPUT_SPEC = "anthropic/claude-opus-5";
const HYBRID_SPEC = "anthropic/gpt-5.6-terra";

// ─── 0. Resolve the host-provided pi-dynamic-workflows ──────────────────────
// Mandated resolution line (S-M3-1). In the pi HOST runtime this resolves to
// dist/model-spec.js. In a plain checkout the package's `exports` map exposes
// only "." → dist/index.js, so the deep subpath throws
// ERR_PACKAGE_PATH_NOT_EXPORTED; require.resolve also throws when the package
// is absent entirely. Both are handled here — we print the documented operator
// message and continue (the robust bare-specifier import below still lets us
// reproduce the hybrid when the package is merely export-restricted).
let depPath = null;
try {
  depPath = require.resolve("@quintinshaw/pi-dynamic-workflows/dist/model-spec.js");
} catch {
  depPath = null;
  console.error(
    "[capture] require.resolve('@quintinshaw/pi-dynamic-workflows/dist/model-spec.js') failed.\n" +
      "[capture] run inside the pi host runtime that provides @quintinshaw/pi-dynamic-workflows.",
  );
}

// ─── 1. Read the resolved source to LOCATE the hybrid factory ───────────────
let sourceText = null;
const located = {
  canonicalModelSpecDef: null,
  buildFallbackModelDef: null,
  buildFallbackModelCall: null,
};
if (depPath) {
  try {
    sourceText = readFileSync(depPath, "utf8");
    const lines = sourceText.split(/\r?\n/);
    const lineOf = (re) => {
      const i = lines.findIndex((l) => re.test(l));
      return i >= 0 ? i + 1 : null;
    };
    located.canonicalModelSpecDef = lineOf(/\bfunction\s+canonicalModelSpec\b/);
    located.buildFallbackModelDef = lineOf(/\bfunction\s+buildFallbackModel\b/);
    located.buildFallbackModelCall = lineOf(/=\s*buildFallbackModel\s*\(/);
  } catch (e) {
    console.error("[capture] could not read model-spec.js source:", e.message);
  }
}

// ─── 2. Reproduce the hybrid deterministically ──────────────────────────────
// `resolveModelSpecWithThinking` + `canonicalModelSpec` are re-exported from the
// package MAIN entry (exports "."), so the bare specifier resolves in both a
// plain checkout and the host runtime. We feed a minimal model registry
// ({ getAll }) — the exact surface resolveModelSpecWithThinking consumes — to
// drive the fallback branch and reproduce the splice WITHOUT a live run.
let resolvedSpec = null;
let resolvedModel = null;
let resolveWarning = null;
try {
  const piDw = await import("@quintinshaw/pi-dynamic-workflows");
  const fakeRegistry = {
    // A single real anthropic model. gpt-5.6-terra does NOT exist for anthropic,
    // so resolution falls through to buildFallbackModel → splice.
    getAll: () => [{ provider: "anthropic", id: "claude-opus-5", name: "Claude Opus 5" }],
  };
  const r = piDw.resolveModelSpecWithThinking(HYBRID_SPEC, fakeRegistry);
  resolvedSpec = r.resolvedSpec ?? null;
  resolvedModel = r.model ?? null;
  resolveWarning = r.warning ?? null;
} catch (e) {
  console.error("[capture] could not import @quintinshaw/pi-dynamic-workflows:", e.message);
}

// ─── 3. Compute guardWouldReject via normalizeModelSpec ─────────────────────
// Imported from the compiled flow dist when resolvable (host runtime that ships
// a dist build); otherwise a FAITHFUL inline replica whose logic is byte-
// identical to packages/flow/src/config/model-spec.ts, so the verdict is always
// deterministic and honest.
let normalizeModelSpec = null;
let guardSource = "unavailable";
try {
  const flow = await import("@pi-stef/flow/dist/config/model-spec.js");
  if (typeof flow.normalizeModelSpec === "function") {
    normalizeModelSpec = flow.normalizeModelSpec;
    guardSource = "flow-dist";
  }
} catch {
  // fall through to the inline replica
}
if (!normalizeModelSpec) {
  // Inline replica — mirrors src/config/model-spec.ts EXACTLY.
  const MODEL_SPEC_RE = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;
  normalizeModelSpec = (spec) => {
    if (spec == null) return null;
    const trimmed = String(spec).trim();
    if (trimmed.length === 0) return null;
    if (trimmed.includes("/")) return MODEL_SPEC_RE.test(trimmed) ? trimmed : null;
    return trimmed.length >= 2 ? trimmed : null;
  };
  guardSource = "inline-replica";
}

// guardWouldReject for the captured hybrid (the value S-M3-1 asks us to record).
const guardWouldReject = normalizeModelSpec(HYBRID_SPEC) === null;
// The guard's ACTUAL scope is MALFORMED specs — demonstrate that too so the
// reader sees both the guard's reach and its limit.
const malformedSample = "anthropic/";
const guardWouldRejectMalformed = normalizeModelSpec(malformedSample) === null;

// ─── 4. Write the capture artifact ──────────────────────────────────────────
const fixtureDir = join(__dirname, "..", "tests", "fixtures");
mkdirSync(fixtureDir, { recursive: true });
const artifact = {
  schemaVersion: 1,
  purpose:
    "Q4 live-capture evidence for Issue #2 (model-hybrid fabrication by buildFallbackModel).",
  inputSpec: INPUT_SPEC,
  hybridSpec: HYBRID_SPEC,
  intermediates: {
    point1_generateBakedLiteral: {
      file: "packages/flow/src/yaml/generate.ts",
      line: 48,
      code: "if (def?.model) parts.push(`model: ${JSON.stringify(def.model)}`);",
      captures: "tier-2 agent `model:` value baked into the generated script (def.model)",
    },
    point2_piDwExplicitModel: {
      file: "@quintinshaw/pi-dynamic-workflows/dist/workflow.js",
      lines: "156-157",
      code: "const explicitModel = agentOptions.model ?? agentDef?.model;\nconst modelSpec = explicitModel ?? (agentOptions.tier ? undefined : resolveModelForPhase(assignedPhase, routingConfig));",
      captures: "modelSpec (explicit or routing-derived) and the orchestrator mainModel",
    },
    point3_buildFallbackModel: {
      file: "@quintinshaw/pi-dynamic-workflows/dist/model-spec.js",
      defLine: located.buildFallbackModelDef ?? 140,
      callLine: located.buildFallbackModelCall ?? 231,
      factory:
        "function buildFallbackModel(provider, modelId, availableModels) { ... return { ...baseModel, id: modelId, name: modelId }; }",
      note: "THE HYBRID FACTORY: keeps `provider` from the provider's base model, overwrites `id`/`name` with the unresolvable pattern.",
      resolvedFallbackModel: resolvedModel,
      resolveWarning,
    },
  },
  canonicalSpec: resolvedSpec,
  guardWouldReject,
  guard: {
    source: guardSource,
    sampleMalformed: malformedSample,
    guardWouldRejectMalformed,
    scope:
      "normalizeModelSpec rejects MALFORMED specs (empty segments, multi-segment, slash-only). " +
      "A WELL-FORMED fabricated hybrid like 'anthropic/gpt-5.6-terra' PASSES the shape-check " +
      "(guardWouldReject === false): the guard cannot tell a real model id from a bogus one by " +
      "shape alone. Protection against that class is the Tier-1 omission behavior " +
      "(a spec that cannot be resolved to a real model is omitted rather than handed to " +
      "buildFallbackModel) plus accurate per-phase reporting (M2).",
  },
  requiredDeepPathResolved: Boolean(depPath),
  timestamp: new Date().toISOString(),
};
const outPath = join(fixtureDir, "model-hybrid-capture.json");
writeFileSync(outPath, JSON.stringify(artifact, null, 2) + "\n", "utf8");

console.log("[capture] wrote", outPath);
console.log("[capture] canonicalSpec =", resolvedSpec);
console.log("[capture] resolvedModel =", JSON.stringify(resolvedModel));
console.log("[capture] guardWouldReject(hybrid) =", guardWouldReject, "(source:", guardSource + ")");
console.log("");
console.log("[capture] Issue #2 model-hybrid reproduction:");
console.log("  real spec (input)  :", INPUT_SPEC);
console.log("  fabricated hybrid  :", HYBRID_SPEC);
if (resolvedModel) {
  console.log(
    "  resolved model      : provider=%s id=%s name=%s  (provider kept from baseModel, id/name overwritten)",
    resolvedModel.provider,
    resolvedModel.id,
    resolvedModel.name,
  );
}
console.log("  canonicalSpec      :", resolvedSpec);
console.log("");
console.log("[capture] Debug-log points (instrument, grep [CAPTURE] from stderr in a live run):");
console.log("  1. packages/flow/src/yaml/generate.ts:48                                  (baked agentOpts model:)");
console.log("  2. @quintinshaw/pi-dynamic-workflows/dist/workflow.js:156-157             (explicitModel/modelSpec)");
console.log(
  "  3. @quintinshaw/pi-dynamic-workflows/dist/model-spec.js:%s def / :%s call (buildFallbackModel)",
  located.buildFallbackModelDef ?? 140,
  located.buildFallbackModelCall ?? 231,
);
