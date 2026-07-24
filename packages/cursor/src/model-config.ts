/**
 * Model configuration, cost estimation, effort dedup, and parameterized-model
 * expansion for the Cursor provider.  Transport-agnostic — no SDK or bridge
 * imports.  Used by index.ts (provider registration) and model-cache.ts.
 */

import type {
  CursorModelParameter,
  CursorParameterizedModel,
  CursorParameterizedVariant,
} from "./cursor-wire.js";

import { FALLBACK_MODEL_ITEMS as rawFallbackModels } from "./model-fallback.generated.js";

// ── Re-export the 4 model-shape types for downstream importers ──

export type { CursorModelParameter, CursorParameterizedModel, CursorParameterizedVariant };

/** Core model descriptor used throughout the Cursor provider. */
export interface CursorModel {
  id: string;
  name: string;
  reasoning: boolean;
  contextWindow: number;
  maxTokens: number;
  requestedModelId?: string;
  parameters?: CursorModelParameter[];
  requiresMaxMode?: boolean;
  requestedMaxMode?: boolean;
  supportsImages?: boolean;
}

// ── Cost estimation ──

export interface ModelCost {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

const MODEL_COST_TABLE: Record<string, ModelCost> = {
  "claude-4-sonnet": { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  "claude-4.5-haiku": { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
  "claude-4.5-opus": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  "claude-4.5-sonnet": { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  "claude-4.6-opus": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  "claude-4.6-sonnet": { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  "composer-1": { input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: 0 },
  "composer-1.5": { input: 3.5, output: 17.5, cacheRead: 0.35, cacheWrite: 0 },
  "composer-2": { input: 0.5, output: 2.5, cacheRead: 0.2, cacheWrite: 0 },
  "gemini-2.5-flash": { input: 0.3, output: 2.5, cacheRead: 0.03, cacheWrite: 0 },
  "gemini-3-flash": { input: 0.5, output: 3, cacheRead: 0.05, cacheWrite: 0 },
  "gemini-3-pro": { input: 2, output: 12, cacheRead: 0.2, cacheWrite: 0 },
  "gemini-3.1-pro": { input: 2, output: 12, cacheRead: 0.2, cacheWrite: 0 },
  "gpt-5": { input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: 0 },
  "gpt-5-mini": { input: 0.25, output: 2, cacheRead: 0.025, cacheWrite: 0 },
  "gpt-5.2": { input: 1.75, output: 14, cacheRead: 0.175, cacheWrite: 0 },
  "gpt-5.2-codex": { input: 1.75, output: 14, cacheRead: 0.175, cacheWrite: 0 },
  "gpt-5.3-codex": { input: 1.75, output: 14, cacheRead: 0.175, cacheWrite: 0 },
  "gpt-5.4": { input: 2.5, output: 15, cacheRead: 0.25, cacheWrite: 0 },
  "gpt-5.4-mini": { input: 0.75, output: 4.5, cacheRead: 0.075, cacheWrite: 0 },
  "gpt-5.5": { input: 2.5, output: 15, cacheRead: 0.25, cacheWrite: 0 },
  "grok-4.20": { input: 2, output: 6, cacheRead: 0.2, cacheWrite: 0 },
  "kimi-k2.5": { input: 0.6, output: 3, cacheRead: 0.1, cacheWrite: 0 },
};

const MODEL_COST_PATTERNS: Array<{ match: (id: string) => boolean; cost: ModelCost }> = [
  {
    match: (id) => /claude.*opus.*fast/i.test(id),
    cost: { input: 30, output: 150, cacheRead: 3, cacheWrite: 37.5 },
  },
  { match: (id) => /claude.*opus/i.test(id), cost: MODEL_COST_TABLE["claude-4.6-opus"]! },
  { match: (id) => /claude.*haiku/i.test(id), cost: MODEL_COST_TABLE["claude-4.5-haiku"]! },
  { match: (id) => /claude.*sonnet/i.test(id), cost: MODEL_COST_TABLE["claude-4.6-sonnet"]! },
  { match: (id) => /composer/i.test(id), cost: MODEL_COST_TABLE["composer-1"]! },
  { match: (id) => /gpt-5\.5/i.test(id), cost: MODEL_COST_TABLE["gpt-5.5"]! },
  { match: (id) => /gpt-5\.4.*mini/i.test(id), cost: MODEL_COST_TABLE["gpt-5.4-mini"]! },
  { match: (id) => /gpt-5\.4/i.test(id), cost: MODEL_COST_TABLE["gpt-5.4"]! },
  { match: (id) => /gpt-5\.3/i.test(id), cost: MODEL_COST_TABLE["gpt-5.3-codex"]! },
  { match: (id) => /gpt-5\.2/i.test(id), cost: MODEL_COST_TABLE["gpt-5.2"]! },
  { match: (id) => /gpt-5.*mini/i.test(id), cost: MODEL_COST_TABLE["gpt-5-mini"]! },
  { match: (id) => /gpt-5/i.test(id), cost: MODEL_COST_TABLE["gpt-5"]! },
  { match: (id) => /gemini.*3\.1/i.test(id), cost: MODEL_COST_TABLE["gemini-3.1-pro"]! },
  { match: (id) => /gemini.*flash/i.test(id), cost: MODEL_COST_TABLE["gemini-2.5-flash"]! },
  { match: (id) => /gemini/i.test(id), cost: MODEL_COST_TABLE["gemini-3-pro"]! },
  { match: (id) => /grok/i.test(id), cost: MODEL_COST_TABLE["grok-4.20"]! },
  { match: (id) => /kimi/i.test(id), cost: MODEL_COST_TABLE["kimi-k2.5"]! },
];

const DEFAULT_COST: ModelCost = { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 0 };

function estimateModelCost(modelId: string): ModelCost {
  const normalized = modelId.toLowerCase();
  const exact = MODEL_COST_TABLE[normalized];
  if (exact) return exact;
  const stripped = normalized.replace(
    /-(high|medium|low|preview|thinking|spark-preview|fast)$/g,
    "",
  );
  const strippedMatch = MODEL_COST_TABLE[stripped];
  if (strippedMatch) return strippedMatch;
  return MODEL_COST_PATTERNS.find((p) => p.match(normalized))?.cost ?? DEFAULT_COST;
}

// ── Effort-level dedup ──

const CURSOR_EFFORT_SUFFIXES: Array<{ suffix: string; effort: string }> = [
  { suffix: "extra-high", effort: "xhigh" },
  { suffix: "xhigh", effort: "xhigh" },
  { suffix: "medium", effort: "medium" },
  { suffix: "high", effort: "high" },
  { suffix: "low", effort: "low" },
  { suffix: "max", effort: "max" },
  { suffix: "none", effort: "none" },
];

export interface ParsedModelId {
  base: string; // model ID with effort stripped
  effort: string; // effort level, or "" if no effort suffix
  fast: boolean; // has -fast suffix
  thinking: boolean; // has -thinking suffix
}

function stripEffortSuffix(id: string): { remaining: string; effort: string } {
  for (const { suffix, effort } of CURSOR_EFFORT_SUFFIXES) {
    const marker = `-${suffix}`;
    if (id.endsWith(marker)) {
      return { remaining: id.slice(0, -marker.length), effort };
    }
  }
  return { remaining: id, effort: "" };
}

export function parseModelId(id: string): ParsedModelId {
  let remaining = id;
  let fast = false;
  let thinking = false;
  let effort = "";

  if (remaining.endsWith("-fast")) {
    fast = true;
    remaining = remaining.slice(0, -5);
  }

  // Cursor has used both orders for thinking effort variants:
  //   claude-4.6-opus-max-thinking       (effort before -thinking)
  //   claude-opus-4-7-thinking-max       (effort after -thinking)
  if (remaining.endsWith("-thinking")) {
    thinking = true;
    remaining = remaining.slice(0, -9);
    const parsed = stripEffortSuffix(remaining);
    remaining = parsed.remaining;
    effort = parsed.effort;
  } else {
    const parsed = stripEffortSuffix(remaining);
    remaining = parsed.remaining;
    effort = parsed.effort;
    if (remaining.endsWith("-thinking")) {
      thinking = true;
      remaining = remaining.slice(0, -9);
    }
  }

  return { base: remaining, effort, fast, thinking };
}

export interface CursorModelRouting {
  modelId: string;
  parameters?: CursorModelParameter[];
  requiresMaxMode?: boolean;
  requestedMaxMode?: boolean;
}

export interface ProcessedModel extends CursorModel {
  supportsEffort: boolean;
  effortMap?: Record<string, string>;
  rawModelByEffort?: Record<string, string>;
  rawRoutingByEffort?: Record<string, CursorModelRouting>;
}

export function buildNoReasoningEffortLookup(models: ProcessedModel[]): Map<string, string> {
  const lookup = new Map<string, string>();
  for (const model of models) {
    if (
      model.supportsEffort &&
      model.effortMap &&
      Object.values(model.effortMap).includes("none")
    ) {
      lookup.set(model.id, "none");
    }
  }
  return lookup;
}

function routingForModel(model: CursorModel): CursorModelRouting | undefined {
  if (
    !model.requestedModelId &&
    !model.parameters?.length &&
    !model.requiresMaxMode &&
    typeof model.requestedMaxMode !== "boolean"
  ) {
    return undefined;
  }
  return {
    modelId: model.requestedModelId ?? model.id,
    ...(model.parameters?.length ? { parameters: model.parameters } : {}),
    ...(model.requiresMaxMode ? { requiresMaxMode: true } : {}),
    ...(typeof model.requestedMaxMode === "boolean"
      ? { requestedMaxMode: model.requestedMaxMode }
      : {}),
  };
}

function defaultRoutingEffort(model: ProcessedModel): string | undefined {
  const routes = model.rawRoutingByEffort;
  if (!routes) return undefined;
  const mappedMedium = model.effortMap?.medium;
  for (const effort of [mappedMedium, "medium", "", "low", "high", "none", "xhigh", "max"]) {
    if (effort !== undefined && routes[effort]) return effort;
  }
  return Object.keys(routes)[0];
}

export function buildRawModelLookup(
  models: ProcessedModel[],
): Map<string, Record<string, CursorModelRouting>> {
  const lookup = new Map<string, Record<string, CursorModelRouting>>();
  for (const model of models) {
    if (model.supportsEffort && model.rawRoutingByEffort) {
      const routes = { ...model.rawRoutingByEffort };
      if (model.effortMap) {
        for (const [piEffort, cursorEffort] of Object.entries(model.effortMap)) {
          if (!routes[piEffort] && routes[cursorEffort]) routes[piEffort] = routes[cursorEffort];
        }
      }
      const defaultEffort = defaultRoutingEffort(model);
      if (defaultEffort !== undefined && !routes[""])
        routes[""] = model.rawRoutingByEffort[defaultEffort]!;
      lookup.set(model.id, routes);
      continue;
    }

    const routing = routingForModel(model);
    if (routing) lookup.set(model.id, { "": routing });
  }
  return lookup;
}

export function applyRawCursorModelId(
  payload: Record<string, unknown>,
  rawRoutingByEffortByModelId: Map<string, Record<string, CursorModelRouting>>,
): void {
  if (typeof payload.model !== "string") return;
  const rawRoutingByEffort = rawRoutingByEffortByModelId.get(payload.model);
  const effort = typeof payload.reasoning_effort === "string" ? payload.reasoning_effort : "";
  const routing = rawRoutingByEffort?.[effort];
  if (!routing) return;
  payload.cursor_model_id = routing.modelId;
  if (routing.parameters?.length) payload.cursor_model_parameters = routing.parameters;
  if (routing.requiresMaxMode) payload.cursor_requires_max_mode = true;
  if (typeof routing.requestedMaxMode === "boolean")
    payload.cursor_model_max_mode = routing.requestedMaxMode;
}

export function applyNoReasoningEffort(
  payload: Record<string, unknown>,
  thinkingLevel: string,
  noReasoningEffortByModelId: Map<string, string>,
): void {
  if (
    thinkingLevel !== "off" ||
    payload.reasoning_effort !== undefined ||
    typeof payload.model !== "string"
  )
    return;
  const noReasoningEffort = noReasoningEffortByModelId.get(payload.model);
  if (noReasoningEffort) payload.reasoning_effort = noReasoningEffort;
}

export function supportsReasoningModelId(id: string): boolean {
  const { base, effort, thinking } = parseModelId(id);
  if (effort || thinking) return true;
  if (base === "default" || base === "auto") return true;
  return /^(claude|composer|gemini|gpt|grok|kimi)(-|$)/i.test(base);
}

/**
 * Ordered effort levels from lowest to highest.
 * "" = default (no effort suffix in model ID).
 */
const EFFORT_ORDER = ["none", "low", "", "medium", "high", "xhigh", "max"] as const;

/**
 * Build a reasoning-effort map from the set of available effort suffixes.
 * For each pi effort level (minimal/low/medium/high/xhigh), picks the closest
 * available cursor effort, falling back to the lowest available.
 */
export function buildEffortMap(efforts: Set<string>): Record<string, string> {
  const sorted = EFFORT_ORDER.filter((e) => efforts.has(e));
  if (sorted.length === 0) return {};
  const lowest = sorted[0]!;

  const pick = (...targets: string[]) => {
    for (const t of targets) if (efforts.has(t)) return t;
    return lowest;
  };

  return {
    minimal: pick("none", "low", ""),
    low: pick("low", "none", ""),
    medium: pick("medium", "", "low"),
    high: pick("high", "medium", ""),
    xhigh: pick("max", "xhigh", "high", "medium", "", "low", "none"),
  };
}

/** Dedup raw models: collapse effort variants into one entry with supportsReasoningEffort. */
export function processModels(raw: CursorModel[]): ProcessedModel[] {
  // Group by (base, fast, thinking)
  const groups = new Map<
    string,
    {
      base: string;
      fast: boolean;
      thinking: boolean;
      efforts: Map<string, CursorModel>;
    }
  >();

  for (const model of raw) {
    const p = parseModelId(model.id);
    const key = `${p.base}|${p.fast}|${p.thinking}`;
    let g = groups.get(key);
    if (!g) {
      g = { base: p.base, fast: p.fast, thinking: p.thinking, efforts: new Map() };
      groups.set(key, g);
    }
    g.efforts.set(p.effort, model);
  }

  const result: ProcessedModel[] = [];

  for (const g of groups.values()) {
    const effortNames = new Set(g.efforts.keys());

    // Dedup when there are multiple effort variants, OR a single variant
    // whose effort is non-empty (e.g. claude-4.5-opus-high — strip the
    // mandatory effort suffix so the model appears as claude-4.5-opus
    // with effort mapping).
    const hasOnlyEffortVariants = g.efforts.size === 1 && !g.efforts.has("");
    const shouldDedup = effortNames.size >= 2 || hasOnlyEffortVariants;
    if (shouldDedup) {
      // Pick representative: prefer "medium" or default ("") for name/metadata
      const rep = g.efforts.get("medium") ?? g.efforts.get("") ?? [...g.efforts.values()][0]!;

      // Build deduped model ID: base + thinking/fast suffix (no effort)
      let id = g.base;
      if (g.thinking) id += "-thinking";
      if (g.fast) id += "-fast";

      const effortMap = buildEffortMap(effortNames);
      const rawModelByEffort = Object.fromEntries(
        [...g.efforts.entries()].map(([effort, model]) => [effort, model.id]),
      );
      const rawRoutingByEffort = Object.fromEntries(
        [...g.efforts.entries()].map(([effort, model]) => [
          effort,
          {
            modelId: model.requestedModelId ?? model.id,
            ...(model.parameters?.length ? { parameters: model.parameters } : {}),
            ...(model.requiresMaxMode ? { requiresMaxMode: true } : {}),
            ...(typeof model.requestedMaxMode === "boolean"
              ? { requestedMaxMode: model.requestedMaxMode }
              : {}),
          },
        ]),
      );

      result.push({
        ...rep,
        id,
        supportsEffort: true,
        effortMap,
        rawModelByEffort,
        rawRoutingByEffort,
      });
    } else {
      // Keep single entries as-is (base model without effort variants)
      for (const model of g.efforts.values()) {
        result.push({ ...model, supportsEffort: false });
      }
    }
  }

  return result.sort((a, b) => a.id.localeCompare(b.id));
}

export function modelConfig(m: ProcessedModel) {
  const input = (m.supportsImages === false ? ["text"] : ["text", "image"]) as ("text" | "image")[];
  return {
    id: m.id,
    name: m.name,
    reasoning: supportsReasoningModelId(m.id),
    ...(m.supportsEffort &&
      m.effortMap && {
        thinkingLevelMap: m.effortMap,
      }),
    input,
    cost: estimateModelCost(m.id),
    contextWindow: m.contextWindow,
    maxTokens: m.maxTokens,
    compat: {
      supportsDeveloperRole: false,
      supportsReasoningEffort: m.supportsEffort,
      ...(m.supportsEffort &&
        m.effortMap && {
          reasoningEffortMap: m.effortMap,
        }),
      maxTokensField: "max_tokens" as const,
    },
  };
}

// ── GPT-5.5 parameterized model expansion ──

const GPT55_VARIANTS = [
  {
    idPart: "",
    label: "272K",
    context: "272k",
    contextWindow: 272_000,
    requestedMaxMode: false,
    fastOptions: [false, true],
  },
  {
    idPart: "-max",
    label: "272K Max",
    context: "272k",
    contextWindow: 272_000,
    requestedMaxMode: true,
    fastOptions: [false, true],
  },
  {
    idPart: "-1m",
    label: "1M",
    context: "1m",
    contextWindow: 1_000_000,
    requestedMaxMode: true,
    fastOptions: [false],
  },
] as const;

const GPT55_REASONING_LEVELS = [
  { suffix: "none", label: "None", value: "none" },
  { suffix: "low", label: "Low", value: "low" },
  { suffix: "medium", label: "", value: "medium" },
  { suffix: "high", label: "High", value: "high" },
  { suffix: "extra-high", label: "Extra High", value: "extra-high" },
] as const;

function gpt55ParameterizedModels(): CursorModel[] {
  const models: CursorModel[] = [];
  for (const variant of GPT55_VARIANTS) {
    for (const fast of variant.fastOptions) {
      for (const reasoning of GPT55_REASONING_LEVELS) {
        const id = `gpt-5.5${variant.idPart}-${reasoning.suffix}${fast ? "-fast" : ""}`;
        const nameParts = ["GPT-5.5", variant.label, reasoning.label, fast ? "Fast" : ""].filter(
          Boolean,
        );
        models.push({
          id,
          name: nameParts.join(" "),
          reasoning: true,
          contextWindow: variant.contextWindow,
          maxTokens: 64_000,
          requestedModelId: "gpt-5.5",
          requiresMaxMode: variant.context === "1m",
          requestedMaxMode: variant.requestedMaxMode,
          parameters: [
            { id: "context", value: variant.context },
            { id: "reasoning", value: reasoning.value },
            { id: "fast", value: String(fast) },
          ],
        });
      }
    }
  }
  return models;
}

function parameterValue(parameters: CursorModelParameter[], id: string): string | undefined {
  return parameters.find((parameter) => parameter.id === id)?.value;
}

function contextWindowFromParameter(context: string | undefined, fallback = 200_000): number {
  if (context === "272k") return 272_000;
  if (context === "1m") return 1_000_000;
  const k = context?.match(/^(\d+)k$/i)?.[1];
  if (k) return Number(k) * 1_000;
  const m = context?.match(/^(\d+)m$/i)?.[1];
  if (m) return Number(m) * 1_000_000;
  return fallback;
}

function cursorEffortSuffix(value: string): string {
  return value;
}

function cursorEffortLabel(value: string): string {
  return (
    GPT55_REASONING_LEVELS.find((level) => level.value === value)?.label ||
    ({ xhigh: "Extra High", max: "Max", none: "None" } as Record<string, string>)[value] ||
    value.replace(/-/g, " ").replace(/\b\w/g, (char) => char.toUpperCase())
  );
}

function metadataEffortParameterId(
  variant: CursorParameterizedVariant,
): "reasoning" | "effort" | undefined {
  if (variant.parameters.some((parameter) => parameter.id === "reasoning")) return "reasoning";
  if (variant.parameters.some((parameter) => parameter.id === "effort")) return "effort";
  return undefined;
}

function isDefaultContext(context: string | undefined): boolean {
  if (!context) return true;
  return context === "200k" || context === "272k" || context === "300k";
}

function contextIdPart(context: string | undefined): string {
  return context && !isDefaultContext(context) ? `-${context.toLowerCase()}` : "";
}

function contextLabel(context: string | undefined): string | undefined {
  if (!context || isDefaultContext(context)) return undefined;
  return context.toUpperCase();
}

function maxModeIdPart(
  modelName: string,
  context: string | undefined,
  requestedMaxMode: boolean,
  hasEffortParameter: boolean,
): string {
  if (!requestedMaxMode || context === "1m") return "";
  return !hasEffortParameter || /(^|-)max($|-)/i.test(modelName) ? "-max-mode" : "-max";
}

function maxModeLabel(
  modelName: string,
  context: string | undefined,
  requestedMaxMode: boolean,
  hasEffortParameter: boolean,
): string | undefined {
  const idPart = maxModeIdPart(modelName, context, requestedMaxMode, hasEffortParameter);
  if (!idPart) return undefined;
  return idPart === "-max-mode" ? "Max Mode" : "Max";
}

function parameterizedBaseId(
  modelName: string,
  variant: CursorParameterizedVariant,
  requestedMaxMode: boolean,
  hasEffortParameter: boolean,
): string {
  const context = parameterValue(variant.parameters, "context");
  return `${modelName}${contextIdPart(context)}${maxModeIdPart(modelName, context, requestedMaxMode, hasEffortParameter)}`;
}

function parameterizedBaseLabel(
  model: CursorParameterizedModel,
  variant: CursorParameterizedVariant,
  requestedMaxMode: boolean,
  hasEffortParameter: boolean,
): string[] {
  const context = parameterValue(variant.parameters, "context");
  return [
    model.clientDisplayName || model.name,
    contextLabel(context),
    maxModeLabel(model.name, context, requestedMaxMode, hasEffortParameter),
  ].filter(Boolean) as string[];
}

function hasVariantParameterSet(
  model: CursorParameterizedModel,
  parameters: CursorModelParameter[],
): boolean {
  const normalized = normalizeParameterValues(parameters);
  return model.variants.some(
    (variant) => normalizeParameterValues(variant.parameters) === normalized,
  );
}

function normalizeParameterValues(parameters: CursorModelParameter[]): string {
  return parameters
    .map((parameter) => `${parameter.id}=${parameter.value}`)
    .sort()
    .join(";");
}

function buildParameterizedRowsFromGroup(options: {
  model: CursorParameterizedModel;
  variants: CursorParameterizedVariant[];
  requestedMaxMode: boolean;
  effortParameterId?: "reasoning" | "effort";
}): CursorModel[] {
  const first = options.variants[0];
  if (!first) return [];
  if (options.requestedMaxMode && !first.isMaxMode && !options.model.supportsMaxMode) return [];

  const context = parameterValue(first.parameters, "context");
  const fast = parameterValue(first.parameters, "fast") === "true";
  const thinking = parameterValue(first.parameters, "thinking") === "true";
  const hasEffortParameter = Boolean(options.effortParameterId);
  const baseId = parameterizedBaseId(
    options.model.name,
    first,
    options.requestedMaxMode,
    hasEffortParameter,
  );
  const baseLabelParts = parameterizedBaseLabel(
    options.model,
    first,
    options.requestedMaxMode,
    hasEffortParameter,
  );
  const contextWindow = contextWindowFromParameter(
    context,
    options.requestedMaxMode
      ? (options.model.contextTokenLimitForMaxMode ?? options.model.contextTokenLimit ?? 200_000)
      : (options.model.contextTokenLimit ?? 200_000),
  );

  return options.variants.flatMap((variant) => {
    const parameters = variant.parameters.map((parameter) => ({
      id: parameter.id,
      value: parameter.value,
    }));
    if (!hasVariantParameterSet(options.model, parameters)) return [];

    const effort = options.effortParameterId
      ? parameterValue(variant.parameters, options.effortParameterId)
      : undefined;
    if (options.effortParameterId === "reasoning" && (effort === "minimal" || effort === "max"))
      return [];

    const id = options.effortParameterId
      ? `${baseId}-${cursorEffortSuffix(effort!)}${thinking ? "-thinking" : ""}${fast ? "-fast" : ""}`
      : `${baseId}${thinking ? "-thinking" : ""}${fast ? "-fast" : ""}`;
    const name = [
      ...baseLabelParts,
      effort ? cursorEffortLabel(effort) : undefined,
      thinking ? "Thinking" : undefined,
      fast ? "Fast" : undefined,
    ]
      .filter(Boolean)
      .join(" ");

    return [
      {
        id,
        name,
        reasoning: Boolean(options.effortParameterId) || thinking,
        contextWindow,
        maxTokens: 64_000,
        requestedModelId: options.model.name,
        requiresMaxMode: variant.isMaxMode,
        requestedMaxMode: options.requestedMaxMode,
        supportsImages: options.model.supportsImages,
        parameters,
      } satisfies CursorModel,
    ];
  });
}

function parameterGroupKey(
  variant: CursorParameterizedVariant,
  effortParameterId?: string,
): string {
  const params = variant.parameters
    .filter((parameter) => parameter.id !== effortParameterId)
    .map((parameter) => `${parameter.id}=${parameter.value}`)
    .sort()
    .join(";");
  return `${variant.isMaxMode ? "max" : "nonmax"}|${params}`;
}

function shouldGenerateSyntheticMaxRows(
  model: CursorParameterizedModel,
  variant: CursorParameterizedVariant,
): boolean {
  return model.supportsMaxMode === true && !variant.isMaxMode;
}

export function modelsFromParameterizedMetadata(
  parameterizedModels: CursorParameterizedModel[],
): CursorModel[] {
  const rows: CursorModel[] = [];
  for (const model of parameterizedModels) {
    const groups = new Map<
      string,
      { effortParameterId?: "reasoning" | "effort"; variants: CursorParameterizedVariant[] }
    >();
    for (const variant of model.variants) {
      if (variant.parameters.length === 0) continue;
      const effortParameterId = metadataEffortParameterId(variant);
      const key = parameterGroupKey(variant, effortParameterId);
      const group = groups.get(key) ?? { effortParameterId, variants: [] };
      group.variants.push(variant);
      groups.set(key, group);
    }

    for (const group of groups.values()) {
      const first = group.variants[0];
      if (!first) continue;
      rows.push(
        ...buildParameterizedRowsFromGroup({
          model,
          variants: group.variants,
          requestedMaxMode: first.isMaxMode,
          effortParameterId: group.effortParameterId,
        }),
      );
      if (shouldGenerateSyntheticMaxRows(model, first)) {
        rows.push(
          ...buildParameterizedRowsFromGroup({
            model,
            variants: group.variants,
            requestedMaxMode: true,
            effortParameterId: group.effortParameterId,
          }),
        );
      }
    }
  }
  return rows;
}

function normalizeDisplayModel(model: CursorModel): CursorModel {
  if (model.id !== "default") return model;
  return {
    ...model,
    id: "auto",
    name: model.name && model.name !== "default" ? model.name : "Auto",
    requestedModelId: model.requestedModelId ?? "default",
  };
}

export function augmentCursorModels(
  raw: CursorModel[],
  parameterizedModels: CursorParameterizedModel[] = [],
): CursorModel[] {
  const byId = new Map<string, CursorModel>();
  const imageSupportByModelId = new Map(
    parameterizedModels
      .filter((model) => typeof model.supportsImages === "boolean")
      .map((model) => [model.name, model.supportsImages!]),
  );
  for (const model of raw.map(normalizeDisplayModel)) {
    const lookupId = model.requestedModelId ?? model.id;
    const metadataSupportsImages = imageSupportByModelId.get(lookupId);
    byId.set(model.id, {
      ...model,
      ...(model.supportsImages === undefined && metadataSupportsImages !== undefined
        ? { supportsImages: metadataSupportsImages }
        : {}),
    });
  }

  const metadataRows =
    modelsFromParameterizedMetadata(parameterizedModels).map(normalizeDisplayModel);
  for (const model of metadataRows) byId.set(model.id, model);

  // Fallback for static/offline discovery. Cursor exposes GPT-5.5 context as
  // parameters (272K vs 1M), not distinct backend model IDs.
  if (metadataRows.length === 0 && raw.some((model) => /^gpt-5\.5(?:-|$)/.test(model.id))) {
    for (const model of gpt55ParameterizedModels()) byId.set(model.id, model);
  }

  return [...byId.values()];
}

export const FALLBACK_MODELS: CursorModel[] = augmentCursorModels(
  rawFallbackModels as CursorModel[],
).map((model) => ({
  ...model,
  reasoning: supportsReasoningModelId(model.id),
}));
