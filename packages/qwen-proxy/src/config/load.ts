import type { QwenProxyConfig } from "./types";

function parseIntEnv(
  raw: string | undefined,
  fallback: number,
): number {
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function parseNonNegativeIntEnv(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : fallback; // rejects 1.5, NaN, all-whitespace
}

export async function loadQwenProxyConfig(
  env: Record<string, string | undefined> = process.env,
): Promise<QwenProxyConfig> {
  return {
    host: env.SF_QWEN_HOST || "127.0.0.1",
    port: parseIntEnv(env.SF_QWEN_PORT, 7790),
    dbPath: env.SF_QWEN_DB || "./data/qwen-proxy.db",
    emptyCooldownMs: parseIntEnv(env.SF_QWEN_EMPTY_COOLDOWN_MS, 10_000),
    emptyRetryMax: parseNonNegativeIntEnv(env.SF_QWEN_EMPTY_RETRY_MAX, 3),
    emptyRetryGapMs: parseIntEnv(env.SF_QWEN_EMPTY_RETRY_GAP_MS, 1_000),
    minRequestGapMs: parseIntEnv(env.SF_QWEN_MIN_REQUEST_GAP_MS, 4_000),
    maxConcurrency: parseIntEnv(env.SF_QWEN_MAX_CONCURRENCY, 1),
    proxyCount: parseNonNegativeIntEnv(env.SF_QWEN_PROXY_COUNT, 0),
    proxyUrlsRaw: env.SF_QWEN_PROXY_URLS || "",
    proxyUser: env.SF_QWEN_PROXY_USER || undefined,
    proxyPass: env.SF_QWEN_PROXY_PASS || undefined,
    proxyCountriesRaw: env.SF_QWEN_PROXY_COUNTRIES || "",
    timeoutMs: parseIntEnv(env.SF_QWEN_TIMEOUT_MS, 60_000),
    apiKeyEnv: (env.SF_QWEN_API_KEY || "").split(",").map(s => s.trim()).filter(Boolean),
    modelAliasesRaw: env.SF_QWEN_MODEL_ALIASES || "",
    logLevel: env.SF_QWEN_LOG_LEVEL || "info",
    adminKey: env.SF_QWEN_ADMIN_KEY || undefined,
    baxia: {
      chromePath: env.SF_QWEN_CHROME_PATH || undefined,
      cacheTtlMs: parseIntEnv(env.SF_QWEN_BAXIA_CACHE_TTL_MS, 1_500_000),
      baxiaVersion: env.SF_QWEN_BAXIA_VERSION || "2.5.37",
      preWarm: env.SF_QWEN_BAXIA_PRE_WARM !== "false",
      fallback: env.SF_QWEN_BAXIA_FALLBACK === "true",
    },
  };
}
