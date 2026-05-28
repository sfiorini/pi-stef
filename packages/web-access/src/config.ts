import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { WebAccessConfig, WebAccessConfigParams, WebBrowserHumanPreset, WebSearchProviderName } from "./types";

const DEFAULT_SENSITIVE_QUERY_KEYS = [
  "api_key",
  "apikey",
  "auth",
  "code",
  "jwt",
  "key",
  "passwd",
  "password",
  "secret",
  "session",
  "sig",
  "signature",
  "token",
];

const DEFAULT_SEARCH_PROVIDERS: WebSearchProviderName[] = ["searxng", "duckduckgo", "google", "bing"];
const DEFAULT_FETCH_MAX_BYTES = 2 * 1024 * 1024;

export async function loadWebAccessConfig(
  params: WebAccessConfigParams = {},
  env: Record<string, string | undefined> = process.env,
  homeDir = process.env.HOME ?? process.cwd(),
): Promise<WebAccessConfig> {
  const defaults = defaultConfig(homeDir);
  const fileConfig = await readConfigFile(env.FH_WEB_CONFIG ?? path.join(homeDir, ".pi", "web-access", "config.json"));
  const envConfig = configFromEnv(env);
  const paramConfig = sanitizeConfig(params);
  const merged = mergeConfig(defaults, fileConfig, envConfig, paramConfig);

  return {
    ...merged,
    sensitiveQueryKeys: uniqueLower([
      ...DEFAULT_SENSITIVE_QUERY_KEYS,
      ...(fileConfig.sensitiveQueryKeys ?? []),
      ...(envConfig.sensitiveQueryKeys ?? []),
      ...(paramConfig.sensitiveQueryKeys ?? []),
    ]),
  };
}

export function defaultConfig(homeDir = process.env.HOME ?? process.cwd()): WebAccessConfig {
  return {
    allowPrivateNetworks: false,
    fetchMaxBytes: DEFAULT_FETCH_MAX_BYTES,
    fetchTimeoutMs: 15_000,
    maxBytes: 50 * 1024,
    maxLines: 2000,
    maxResults: 10,
    outputDir: path.join(tmpdir(), "sf-web-access"),
    profilesDir: path.join(homeDir, ".pi", "web-access", "profiles"),
    searchProviders: DEFAULT_SEARCH_PROVIDERS,
    sensitiveQueryKeys: DEFAULT_SENSITIVE_QUERY_KEYS,
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36",
  };
}

async function readConfigFile(configPath: string): Promise<WebAccessConfigParams> {
  try {
    const parsed = JSON.parse(await readFile(configPath, "utf8")) as WebAccessConfigParams;
    return sanitizeConfig(parsed);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return {};
    }
    throw error;
  }
}

function configFromEnv(env: Record<string, string | undefined>): WebAccessConfigParams {
  return sanitizeConfig({
    allowPrivateNetworks: parseBoolean(env.FH_WEB_ALLOW_PRIVATE_NETWORKS),
    browserFingerprintSeed: parseFingerprintSeed(env.FH_WEB_BROWSER_FINGERPRINT_SEED),
    browserGeoip: parseBoolean(env.FH_WEB_BROWSER_GEOIP),
    browserHumanPreset: parseHumanPreset(env.FH_WEB_BROWSER_HUMAN_PRESET),
    browserLocale: env.FH_WEB_BROWSER_LOCALE,
    browserProxy: parseBrowserProxy(env.FH_WEB_BROWSER_PROXY),
    browserTimezone: env.FH_WEB_BROWSER_TIMEZONE,
    fetchMaxBytes: parsePositiveInteger(env.FH_WEB_FETCH_MAX_BYTES),
    fetchTimeoutMs: parsePositiveInteger(env.FH_WEB_FETCH_TIMEOUT_MS),
    maxBytes: parsePositiveInteger(env.FH_WEB_MAX_BYTES),
    maxLines: parsePositiveInteger(env.FH_WEB_MAX_LINES),
    maxResults: parsePositiveInteger(env.FH_WEB_MAX_RESULTS),
    outputDir: env.FH_WEB_OUTPUT_DIR,
    profilesDir: env.FH_WEB_PROFILES_DIR,
    searchProviders: parseProviders(env.FH_WEB_SEARCH_PROVIDERS),
    searxngUrl: env.FH_WEB_SEARXNG_URL,
    sensitiveQueryKeys: splitCsv(env.FH_WEB_SENSITIVE_QUERY_KEYS),
    userAgent: env.FH_WEB_USER_AGENT,
  });
}

function mergeConfig(...configs: WebAccessConfigParams[]): WebAccessConfig {
  return Object.assign({}, ...configs) as WebAccessConfig;
}

function sanitizeConfig(config: WebAccessConfigParams): WebAccessConfigParams {
  const sanitized = Object.fromEntries(Object.entries(config).filter(([, value]) => value !== undefined && value !== "")) as WebAccessConfigParams;
  sanitized.browserFingerprintSeed = parseFingerprintSeed(sanitized.browserFingerprintSeed);
  sanitized.browserGeoip = typeof sanitized.browserGeoip === "boolean" ? sanitized.browserGeoip : undefined;
  sanitized.browserHumanPreset = parseHumanPreset(sanitized.browserHumanPreset);
  sanitized.browserLocale = sanitizePlainString(sanitized.browserLocale);
  sanitized.browserProxy = parseBrowserProxy(sanitized.browserProxy);
  sanitized.browserTimezone = sanitizePlainString(sanitized.browserTimezone);
  return Object.fromEntries(Object.entries(sanitized).filter(([, value]) => value !== undefined && value !== "")) as WebAccessConfigParams;
}

function parsePositiveInteger(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function parseBoolean(value: string | undefined): boolean | undefined {
  if (value === undefined) return undefined;
  if (["1", "true", "yes", "on"].includes(value.toLowerCase())) return true;
  if (["0", "false", "no", "off"].includes(value.toLowerCase())) return false;
  return undefined;
}

function parseBrowserProxy(value: string | undefined): string | undefined {
  const sanitized = sanitizePlainString(value);
  if (!sanitized) return undefined;
  try {
    const parsed = new URL(sanitized);
    return ["http:", "https:", "socks5:"].includes(parsed.protocol) ? parsed.toString() : undefined;
  } catch {
    return undefined;
  }
}

function parseFingerprintSeed(value: string | undefined): string | undefined {
  const sanitized = sanitizePlainString(value);
  if (!sanitized) return undefined;
  return /^[1-9]\d{0,9}$/.test(sanitized) ? sanitized : undefined;
}

function parseHumanPreset(value: string | undefined): WebBrowserHumanPreset | undefined {
  return value === "careful" || value === "default" ? value : undefined;
}

function parseProviders(value: string | undefined): WebSearchProviderName[] | undefined {
  const providers = splitCsv(value).filter(isSearchProvider);
  return providers.length > 0 ? providers : undefined;
}

function sanitizePlainString(value: string | undefined): string | undefined {
  const sanitized = typeof value === "string" ? value.trim() : undefined;
  return sanitized ? sanitized : undefined;
}

function splitCsv(value: string | undefined): string[] {
  return value?.split(",").map((item) => item.trim()).filter(Boolean) ?? [];
}

function isSearchProvider(value: string): value is WebSearchProviderName {
  return ["bing", "duckduckgo", "google", "searxng", "searxng-html"].includes(value);
}

function uniqueLower(values: string[]): string[] {
  return [...new Set(values.map((value) => value.toLowerCase()))];
}
