/**
 * Model alias resolution.
 *
 * parseModelAliases: JSON string → Map<alias, upstreamId> (user-configured only;
 *   NOT advertised in /v1/models beyond what the user set).
 * resolveModel: strip capability suffixes (-thinking, -search), then alias-lookup
 *   (user aliases win, then built-in defaults, then passthrough).
 */

/**
 * Built-in default aliases mapping common short/legacy model names to the
 * current chat.qwen.ai guest-mode model ids. chat.qwen.ai silently returns an
 * empty completion for unrecognized model names, so mapping the names clients
 * naturally send (e.g. `qwen3-max`) avoids those mysterious empties. Applied as
 * a FALLBACK in resolveModel (user aliases via SF_QWEN_MODEL_ALIASES override
 * these); NOT merged into parseModelAliases, so they don't pollute /v1/models.
 */
const DEFAULT_ALIASES: Record<string, string> = {
  "qwen3-max": "qwen3.8-max",
  "qwen-max": "qwen3.8-max",
  "qwen-plus": "qwen3.7-plus",
  "qwen3-plus": "qwen3.7-plus",
};

export function parseModelAliases(raw: string | undefined): Map<string, string> {
  if (!raw || raw.trim() === "") return new Map();

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(`SF_QWEN_MODEL_ALIASES is not valid JSON: ${(e as Error).message}`);
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("SF_QWEN_MODEL_ALIASES must be a JSON object");
  }

  const map = new Map<string, string>();
  for (const [alias, upstreamId] of Object.entries(parsed)) {
    if (typeof upstreamId === "string") {
      map.set(alias, upstreamId);
    }
  }
  return map;
}

export interface ResolvedModel {
  upstreamId: string;
  thinking: boolean;
  search: boolean;
}

/**
 * Resolve a model input string:
 * 1. Strip trailing capability suffixes: -thinking, -search, -thinking-search, -search-thinking
 * 2. Look up the remainder: user aliases (SF_QWEN_MODEL_ALIASES) win, then the
 *    built-in DEFAULT_ALIASES (common short/legacy names → current ids), then passthrough.
 */
export function resolveModel(
  input: string,
  aliases: Map<string, string>,
): ResolvedModel {
  let thinking = false;
  let search = false;
  let id = input;

  // Strip suffixes iteratively (order-independent)
  // Try longest suffixes first to avoid partial matches
  if (id.endsWith("-thinking-search") || id.endsWith("-search-thinking")) {
    id = id.slice(0, -"-thinking-search".length);
    thinking = true;
    search = true;
  } else if (id.endsWith("-thinking")) {
    id = id.slice(0, -"-thinking".length);
    thinking = true;
  } else if (id.endsWith("-search")) {
    id = id.slice(0, -"-search".length);
    search = true;
  }

  // Alias lookup: user aliases win, then built-in defaults, then passthrough.
  const upstreamId = aliases.get(id) ?? DEFAULT_ALIASES[id] ?? id;

  return { upstreamId, thinking, search };
}
