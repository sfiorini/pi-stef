/**
 * Model alias resolution.
 *
 * parseModelAliases: JSON string → Map<alias, upstreamId>
 * resolveModel: strip capability suffixes (-thinking, -search) then alias-lookup
 */

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
 * 2. Look up the remainder in the alias map (passthrough if unmapped)
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

  // Alias lookup (passthrough if unmapped)
  const upstreamId = aliases.get(id) ?? id;

  return { upstreamId, thinking, search };
}
