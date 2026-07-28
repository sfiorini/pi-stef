# Live-capture runbook — Issue #2 model-hybrid trigger (M3 / S-M3-1)

> **Non-production evidence-gathering.** This runbook pins the exact
> deterministic trigger that turns a real model spec into a fabricated
> `{ provider, id }` hybrid (e.g. `anthropic/claude-opus-5` →
> `anthropic/gpt-5.6-terra`), and validates how the M1 `normalizeModelSpec`
> guard treats the captured value. There is **no automated assertion** — the
> JSON artifact produced by `scripts/capture-model-hybrid.mjs` **is** the
> evidence.
>
> The capture script is excluded from vitest (it lives under `scripts/`, not
> `tests/`, and its name is not `*.test.*`/`*.spec.*`), so it never runs as a
> unit test and cannot affect the suite.

## Root cause (what you are pinning)

`buildFallbackModel(provider, modelId, availableModels)` in
`@quintinshaw/pi-dynamic-workflows/dist/model-spec.js` (definition ≈ line 140,
call site ≈ line 231) returns `{ ...baseModel, id: modelId, name: modelId }`.
When a `provider/modelId` cannot be resolved to a real model, it **keeps the
provider's `provider`** (from the provider's base model) but **overwrites `id`
and `name`** with the unresolvable pattern → an atomic-looking hybrid spliced
from two sources. `canonicalModelSpec` then renders it as a clean
`provider/modelId` string, so the fabrication is invisible downstream.

A **deterministic in-checkout reproduction** is available without a live run:

```
node packages/flow/scripts/capture-model-hybrid.mjs
```

With a minimal `{ getAll }` registry it shows the splice directly:

- input `"anthropic/gpt-5.6-terra"` → resolved model
  `{ provider: "anthropic", id: "gpt-5.6-terra", name: "gpt-5.6-terra" }`
  (`provider` carried from `claude-opus-5`, `id`/`name` overwritten), and
- `canonicalSpec === "anthropic/gpt-5.6-terra"` — the fabricated spec rendered
  as a real-looking model id.

The live procedure below pins the **source** of that unresolvable pattern in a
real `sf_flow_auto` run (the one gap the static repro cannot answer), and
re-validates the guard.

---

## 1. Environment

Run inside the **pi host runtime** that provides
`@quintinshaw/pi-dynamic-workflows`. Set the role model to a real spec; the
hybrid appears when resolution falls through to the fallback factory:

```sh
# Reproducing role: RESEARCHER (used by the sf-flow-plan tier-1 skill phase).
# Any tier-1 role env var works: SF_FLOW_<ROLE>_MODEL where ROLE is one of
# RESEARCHER | DEVELOPER | REVIEWER | PLANNER | AUDITOR | DESIGNER | SYNTH.
export SF_FLOW_RESEARCHER_MODEL="anthropic/claude-opus-5"
```

> The hybrid is observed when a `provider/modelId` whose model id is NOT a real
> model for that provider reaches `resolveModelSpecWithThinking`. To force the
> splice against the reproduction, point the role at a spec whose id is unknown
> for its provider (e.g. `anthropic/gpt-5.6-terra`). To reproduce the
> cross-source splice from a *real* spec, set the role model AND ensure the
> model id is absent from the host model registry — the debug-log points below
> reveal which source supplied the pattern.

## 2. Instrument the three debug-log points

Add a `console.error("[CAPTURE] …")` at each site, then `grep '\[CAPTURE\]'`
from stderr (step 4). These are READ-ONLY observation logs; they change no
behavior.

1. **Baked literal** — `packages/flow/src/yaml/generate.ts:48`
   ```ts
   if (def?.model) parts.push(`model: ${JSON.stringify(def.model)}`);
   ```
   Log the value of `def.model` (the tier-2 agent `model:` baked into the
   generated script).

2. **pi-dw `explicitModel` / `modelSpec`** —
   `@quintinshaw/pi-dynamic-workflows/dist/workflow.js` ≈ lines 156–157
   ```js
   const explicitModel = agentOptions.model ?? agentDef?.model;
   const modelSpec = explicitModel ?? (agentOptions.tier ? undefined : resolveModelForPhase(assignedPhase, routingConfig));
   ```
   Log `modelSpec` and the orchestrator `mainModel`.

3. **`buildFallbackModel` (the hybrid factory)** —
   `@quintinshaw/pi-dynamic-workflows/dist/model-spec.js` (def ≈ 140, call ≈ 231)
   ```js
   const fallbackModel = buildFallbackModel(provider, fallbackPattern, availableModels);
   ```
   Log the incoming `fallbackPattern`, the chosen `baseModel` (its `provider`),
   and the returned `{ provider, id, name }`. **This is where the splice
   happens.**

## 3. Invocation

Against a workflow that contains a **tier-1 skill phase** (`sf-flow-plan`,
`sf-flow-implement`, or `sf-flow-audit`), so the configured role model is in
play:

```
pi
```

then, inside pi:

```
/sf-flow-auto <workflow> <prompt>
```

For example, against the bundled `sf-flow-plan` workflow with a tier-1 plan
phase:

```
/sf-flow-auto sf-flow-plan "Add a README section describing the model-resolution chain"
```

## 4. Capture stderr + run the capture script

```sh
# Capture everything pi writes to stderr for the [CAPTURE] markers.
pi 2> /tmp/flow-capture.stderr
grep '\[CAPTURE\]' /tmp/flow-capture.stderr

# Write the capture artifact (the evidence).
node packages/flow/scripts/capture-model-hybrid.mjs
cat packages/flow/tests/fixtures/model-hybrid-capture.json
```

## 5. What the artifact proves

`packages/flow/tests/fixtures/model-hybrid-capture.json` is the evidence. Its
top-level fields:

- **`canonicalSpec`** — when it equals `"anthropic/gpt-5.6-terra"`, it
  **reproduces the bug**: `buildFallbackModel` fabricated a provider/id hybrid
  and `canonicalModelSpec` rendered it as a clean, real-looking model id.

- **`guardWouldReject`** — `normalizeModelSpec(hybrid) === null`, i.e. whether
  the **M1 shape-guard** would omit the captured hybrid at Tier-1 resolution.

  > ⚠️ **Honest scope note.** The guard rejects *malformed* specs (empty
  > segments, slash-only, multi-segment — see the artifact's
  > `guard.guardWouldRejectMalformed === true`). A **well-formed** fabricated
  > hybrid like `"anthropic/gpt-5.6-terra"` **passes** the shape-check, so for
  > that sample `guardWouldReject === false`: the guard cannot tell a real model
  > id from a bogus one by shape alone. `guardWouldReject === true` proves the
  > guard catches the *malformed* class of trigger; for a well-formed hybrid the
  > protection is the Tier-1 **omission** behavior (a spec that cannot be
  > resolved to a real model is omitted rather than handed to
  > `buildFallbackModel`) plus the **accurate per-phase reporting** added in M2.
  > Read the live-captured `intermediates` to determine which class your
  > reproducing trigger belongs to.

- **`intermediates`** — the values at each of the three debug-log points. Point
  3's `resolvedFallbackModel` shows the exact splice (`provider` from the
  provider's base model, `id`/`name` from the unresolvable pattern).

## 6. Acceptance (manual)

An operator runs steps 1–4 once and produces
`packages/flow/tests/fixtures/model-hybrid-capture.json` whose:

- `canonicalSpec` reproduces the hybrid (the fabricated `provider/modelId`),
  **and**
- `guard` block documents the guard's verdict for the captured value (true for a
  malformed trigger; for a well-formed hybrid, false — see the scope note, which
  is itself the finding).

The flow test suite must remain green (the script is not a test):
`pnpm --filter @pi-stef/flow exec vitest run` → green.
