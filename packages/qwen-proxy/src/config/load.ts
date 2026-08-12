import type { QwenProxyConfig } from "./types";

function parseIntEnv(
  raw: string | undefined,
  fallback: number,
): number {
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export async function loadQwenProxyConfig(
  env: Record<string, string | undefined> = process.env,
): Promise<QwenProxyConfig> {
  return {
    host: env.SF_QWEN_HOST || "127.0.0.1",
    port: parseIntEnv(env.SF_QWEN_PORT, 7790),
    dbPath: env.SF_QWEN_DB || "./data/qwen-proxy.db",
    rateLimitCooldownMs: parseIntEnv(env.SF_QWEN_RATE_LIMIT_COOLDOWN_MS, 86_400_000),
    emptyCooldownMs: parseIntEnv(env.SF_QWEN_EMPTY_COOLDOWN_MS, 600_000),
    minRequestGapMs: parseIntEnv(env.SF_QWEN_MIN_REQUEST_GAP_MS, 4_000),
    apiKeyEnv: (env.SF_QWEN_API_KEY || "").split(",").map(s => s.trim()).filter(Boolean),
    modelAliasesRaw: env.SF_QWEN_MODEL_ALIASES || "",
    logLevel: env.SF_QWEN_LOG_LEVEL || "info",
    adminKey: env.SF_QWEN_ADMIN_KEY || undefined,
    baxia: {
      useChromeBaxia: env.SF_QWEN_USE_CHROME_BAXIA !== "false",
      chromePath: env.SF_QWEN_CHROME_PATH || undefined,
      cacheTtlMs: parseIntEnv(env.SF_QWEN_BAXIA_CACHE_TTL_MS, 1_500_000),
      baxiaVersion: env.SF_QWEN_BAXIA_VERSION || "2.5.37",
      preWarm: env.SF_QWEN_BAXIA_PRE_WARM !== "false",
      fallback: env.SF_QWEN_BAXIA_FALLBACK === "true",
    },
  };
}
