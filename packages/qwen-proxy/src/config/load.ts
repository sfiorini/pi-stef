import { readFile } from "node:fs/promises";
import { z } from "zod";
import type { QwenProxyConfig, Account } from "./types";

function parseIntEnv(
  raw: string | undefined,
  fallback: number,
): number {
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

const accountSchema = z.object({
  id: z.number().int(),
  email: z.string().email(),
  password: z.string().min(1),
  ord: z.number().int(),
});

function validateAccounts(raw: unknown, source: string): Account[] {
  if (!Array.isArray(raw)) {
    throw new Error(`${source} must be a JSON array`);
  }
  const result = accountSchema.array().safeParse(raw);
  if (!result.success) {
    throw new Error(
      `${source} contains invalid account: ${result.error.issues.map((i) => i.message).join("; ")}`,
    );
  }
  return result.data;
}

function resolveAccountsFromNumberedEnv(
  env: Record<string, string | undefined>,
): Account[] {
  const groups = new Map<string, Record<string, string | undefined>>();
  for (const key of Object.keys(env)) {
    const m = key.match(/^SF_QWEN_ACCOUNT_(\d+)_(EMAIL|PASSWORD|ID|ORD)$/);
    if (m) {
      const n = m[1];
      if (!groups.has(n)) groups.set(n, {});
      groups.get(n)![m[2]] = env[key];
    }
  }

  const accounts: Account[] = [];
  for (const [n, fields] of groups) {
    if (!fields.EMAIL || !fields.PASSWORD) continue;
    const id = fields.ID ? Number(fields.ID) : Number(n);
    const ord = fields.ORD ? Number(fields.ORD) : fields.ID ? Number(fields.ID) : Number(n);
    accounts.push({ id, email: fields.EMAIL, password: fields.PASSWORD, ord });
  }
  return validateAccounts(accounts, "SF_QWEN_ACCOUNT_N env vars");
}

async function resolveAccounts(
  env: Record<string, string | undefined>,
): Promise<Account[]> {
  // Mode 1: SF_QWEN_ACCOUNTS JSON
  if (env.SF_QWEN_ACCOUNTS && env.SF_QWEN_ACCOUNTS.trim() !== "") {
    let parsed: unknown;
    try {
      parsed = JSON.parse(env.SF_QWEN_ACCOUNTS);
    } catch (e) {
      throw new Error(
        `SF_QWEN_ACCOUNTS is not valid JSON: ${(e as Error).message}`,
      );
    }
    return validateAccounts(parsed, "SF_QWEN_ACCOUNTS");
  }

  // Mode 2: SF_QWEN_ACCOUNTS_FILE
  if (env.SF_QWEN_ACCOUNTS_FILE && env.SF_QWEN_ACCOUNTS_FILE.trim() !== "") {
    let text: string;
    try {
      text = await readFile(env.SF_QWEN_ACCOUNTS_FILE, "utf8");
    } catch (e) {
      throw new Error(
        `Failed to read SF_QWEN_ACCOUNTS_FILE (${env.SF_QWEN_ACCOUNTS_FILE}): ${(e as Error).message}`,
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (e) {
      throw new Error(
        `SF_QWEN_ACCOUNTS_FILE contains invalid JSON: ${(e as Error).message}`,
      );
    }
    return validateAccounts(parsed, "SF_QWEN_ACCOUNTS_FILE");
  }

  // Mode 3: numbered env vars
  return resolveAccountsFromNumberedEnv(env);
}

export async function loadQwenProxyConfig(
  env: Record<string, string | undefined> = process.env,
): Promise<QwenProxyConfig> {
  return {
    host: env.SF_QWEN_HOST || "127.0.0.1",
    port: parseIntEnv(env.SF_QWEN_PORT, 7790),
    dbPath: env.SF_QWEN_DB || "./data/qwen-proxy.db",
    authUrl: env.SF_QWEN_AUTH_URL || "https://chat.qwen.ai",
    apiUrl: env.SF_QWEN_API_URL || "https://qwen.aikit.club",
    jwtRefreshMs: parseIntEnv(env.SF_QWEN_JWT_REFRESH_MS, 21_600_000),
    refreshThresholdMs: parseIntEnv(env.SF_QWEN_REFRESH_THRESHOLD_MS, 21_600_000),
    loginTimeoutMs: parseIntEnv(env.SF_QWEN_LOGIN_TIMEOUT_MS, 10_000),
    staggerMs: parseIntEnv(env.SF_QWEN_STAGGER_MS, 5_000),
    rateLimitCooldownMs: parseIntEnv(env.SF_QWEN_RATE_LIMIT_COOLDOWN_MS, 86_400_000),
    emptyCooldownMs: parseIntEnv(env.SF_QWEN_EMPTY_COOLDOWN_MS, 600_000),
    minRequestGapMs: parseIntEnv(env.SF_QWEN_MIN_REQUEST_GAP_MS, 4_000),
    reenableIntervalMs: parseIntEnv(env.SF_QWEN_REENABLE_INTERVAL_MS, 60_000),
    apiKeyEnv: (env.SF_QWEN_API_KEY || "").split(",").map(s => s.trim()).filter(Boolean),
    modelAliasesRaw: env.SF_QWEN_MODEL_ALIASES || "",
    logLevel: env.SF_QWEN_LOG_LEVEL || "info",
    accounts: await resolveAccounts(env),
    adminKey: env.SF_QWEN_ADMIN_KEY || undefined,
  };
}
