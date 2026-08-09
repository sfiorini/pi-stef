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
    authUrl: env.SF_QWEN_AUTH_URL || "https://chat.qwen.ai",
    apiUrl: env.SF_QWEN_API_URL || "https://chat.qwen.ai",
    refreshIntervalMs: parseIntEnv(env.SF_QWEN_REFRESH_INTERVAL_MS, 900_000),
    jwtRefreshMs: parseIntEnv(env.SF_QWEN_JWT_REFRESH_MS, 21_600_000),
    refreshThresholdMs: parseIntEnv(env.SF_QWEN_REFRESH_THRESHOLD_MS, 21_600_000),
    loginTimeoutMs: parseIntEnv(env.SF_QWEN_LOGIN_TIMEOUT_MS, 10_000),
    staggerMs: parseIntEnv(env.SF_QWEN_STAGGER_MS, 5_000),
    logLevel: env.SF_QWEN_LOG_LEVEL || "info",
    accounts: [],
  };
}
