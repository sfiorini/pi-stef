import type { Api, Config, DeploymentConfig, Issue, Result } from "./types";

const ENV_NAME = /^[A-Z_][A-Z0-9_]*$/;
const DEPLOYMENT_ID = /^[a-z0-9][a-z0-9-]*$/;
const API_VALUES = ["openai-completions", "azure-openai-responses"] as const satisfies readonly Api[];
const DEPLOYMENT_KEYS = ["id", "name", "baseUrl", "apiKeyEnv", "api", "authHeader", "headers", "models"];
const MODEL_KEYS = ["id", "name", "reasoning", "input", "contextWindow", "maxTokens", "cost"];
const COST_KEYS = ["input", "output", "cacheRead", "cacheWrite"] as const;

export function validate(raw: unknown): Result<Config> {
  const issues: Issue[] = [];

  if (!isRecord(raw)) {
    return { ok: false, issues: [{ path: "", message: "Config must be an object." }] };
  }

  rejectUnknownKeys(raw, ["$schema", "deployments"], "", issues);
  if ("$schema" in raw && typeof raw.$schema !== "string") {
    issues.push({ path: "$schema", message: "Must be a string." });
  }
  if (!Array.isArray(raw.deployments)) {
    issues.push({ path: "deployments", message: "Must be an array." });
    return { ok: false, issues };
  }

  const seenIds = new Set<string>();
  raw.deployments.forEach((deployment, index) => {
    validateDeployment(deployment, index, seenIds, issues);
  });

  return issues.length === 0 ? { ok: true, value: raw as unknown as Config } : { ok: false, issues };
}

function validateDeployment(raw: unknown, index: number, seenIds: Set<string>, issues: Issue[]): void {
  const path = `deployments[${index}]`;
  if (!isRecord(raw)) {
    issues.push({ path, message: "Must be an object." });
    return;
  }

  rejectUnknownKeys(raw, DEPLOYMENT_KEYS, path, issues);
  requireKeys(raw, ["id", "name", "baseUrl", "apiKeyEnv", "api", "models"], path, issues);

  if (!isNonEmptyString(raw.id) || !DEPLOYMENT_ID.test(raw.id)) {
    issues.push({ path: `${path}.id`, message: "Must match ^[a-z0-9][a-z0-9-]*$." });
  } else if (seenIds.has(raw.id)) {
    issues.push({ path: `${path}.id`, message: `Duplicate deployment id "${raw.id}".` });
  } else {
    seenIds.add(raw.id);
  }

  if (!isNonEmptyString(raw.name)) {
    issues.push({ path: `${path}.name`, message: "Must be a non-empty string." });
  }
  if (!isHttpsString(raw.baseUrl)) {
    issues.push({ path: `${path}.baseUrl`, message: "Must be an https:// URL string." });
  }
  if (!isNonEmptyString(raw.apiKeyEnv) || !ENV_NAME.test(raw.apiKeyEnv)) {
    issues.push({ path: `${path}.apiKeyEnv`, message: "Must be an environment variable name." });
  }
  if (!isApi(raw.api)) {
    issues.push({ path: `${path}.api`, message: "Must be one of openai-completions, azure-openai-responses." });
  }

  if (typeof raw.authHeader !== "undefined" && typeof raw.authHeader !== "boolean") {
    issues.push({ path: `${path}.authHeader`, message: "Must be a boolean." });
  }
  validateHeaders(raw.headers, `${path}.headers`, issues);

  if (Array.isArray(raw.models)) {
    if (raw.models.length === 0) {
      issues.push({ path: `${path}.models`, message: "Must contain at least one model." });
    }
    raw.models.forEach((model, modelIndex) => validateModel(model, `${path}.models[${modelIndex}]`, issues));
  } else {
    issues.push({ path: `${path}.models`, message: "Must be an array." });
  }

  if (isApi(raw.api) && typeof raw.baseUrl === "string") {
    validateApiBaseUrl(raw as Pick<DeploymentConfig, "api" | "baseUrl">, `${path}.baseUrl`, issues);
  }
}

function validateModel(raw: unknown, path: string, issues: Issue[]): void {
  if (!isRecord(raw)) {
    issues.push({ path, message: "Must be an object." });
    return;
  }

  rejectUnknownKeys(raw, MODEL_KEYS, path, issues);
  requireKeys(raw, ["id", "name", "reasoning", "input", "contextWindow", "maxTokens", "cost"], path, issues);

  if (!isNonEmptyString(raw.id)) issues.push({ path: `${path}.id`, message: "Must be a non-empty string." });
  if (!isNonEmptyString(raw.name)) issues.push({ path: `${path}.name`, message: "Must be a non-empty string." });
  if (typeof raw.reasoning !== "boolean") issues.push({ path: `${path}.reasoning`, message: "Must be a boolean." });
  if (!Array.isArray(raw.input) || raw.input.length === 0) {
    issues.push({ path: `${path}.input`, message: "Must contain at least one input modality." });
  } else {
    raw.input.forEach((item, index) => {
      if (item !== "text" && item !== "image") {
        issues.push({ path: `${path}.input[${index}]`, message: "Must be text or image." });
      }
    });
  }
  validatePositiveInteger(raw.contextWindow, `${path}.contextWindow`, issues);
  validatePositiveInteger(raw.maxTokens, `${path}.maxTokens`, issues);
  validateCost(raw.cost, `${path}.cost`, issues);
}

function validateCost(raw: unknown, path: string, issues: Issue[]): void {
  if (!isRecord(raw)) {
    issues.push({ path, message: "Must be an object." });
    return;
  }

  rejectUnknownKeys(raw, [...COST_KEYS], path, issues);
  requireKeys(raw, [...COST_KEYS], path, issues);
  for (const key of COST_KEYS) {
    const value = raw[key];
    if (typeof value !== "number" || Number.isNaN(value) || value < 0) {
      issues.push({ path: `${path}.${key}`, message: "Must be a non-negative number." });
    }
  }
}

function validateHeaders(raw: unknown, path: string, issues: Issue[]): void {
  if (typeof raw === "undefined") return;
  if (!isRecord(raw)) {
    issues.push({ path, message: "Must be an object." });
    return;
  }
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value !== "string" || !ENV_NAME.test(value)) {
      issues.push({ path: `${path}.${key}`, message: "Header values must be environment variable names." });
    }
  }
}

function validateApiBaseUrl(dep: Pick<DeploymentConfig, "api" | "baseUrl">, path: string, issues: Issue[]): void {
  if (dep.api === "openai-completions") {
    let pathname = "";
    try {
      pathname = new URL(dep.baseUrl).pathname.replace(/\/$/, "");
    } catch {
      return;
    }
    if (pathname.endsWith("/chat/completions")) {
      issues.push({
        path,
        message:
          "When api is openai-completions, baseUrl must NOT end with /chat/completions; Pi's OpenAI SDK appends that path itself. Use https://<resource>.services.ai.azure.com/openai/v1/.",
      });
    }
    if (/api-version=/i.test(dep.baseUrl)) {
      issues.push({
        path,
        message:
          "Query strings on baseUrl, including api-version=, do not survive the OpenAI SDK URL composer. For Azure Foundry, use https://<resource>.services.ai.azure.com/openai/v1/.",
      });
    }
    return;
  }

  try {
    const hostname = new URL(dep.baseUrl).hostname;
    if (!hostname.endsWith(".openai.azure.com") && !hostname.endsWith(".cognitiveservices.azure.com")) {
      issues.push({
        path,
        message:
          "When api is azure-openai-responses, host must end with .openai.azure.com or .cognitiveservices.azure.com. For Azure Foundry endpoints, use api: openai-completions.",
      });
    }
  } catch {
    // The basic URL check reports the actionable issue.
  }
}

function requireKeys(raw: Record<string, unknown>, keys: readonly string[], path: string, issues: Issue[]): void {
  for (const key of keys) {
    if (!(key in raw)) {
      issues.push({ path: joinPath(path, key), message: "Required field is missing." });
    }
  }
}

function rejectUnknownKeys(raw: Record<string, unknown>, allowed: readonly string[], path: string, issues: Issue[]): void {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(raw)) {
    if (!allowedSet.has(key)) {
      issues.push({ path: joinPath(path, key), message: "Unknown field." });
    }
  }
}

function validatePositiveInteger(value: unknown, path: string, issues: Issue[]): void {
  if (!Number.isInteger(value) || (value as number) < 1) {
    issues.push({ path, message: "Must be a positive integer." });
  }
}

function joinPath(base: string, key: string): string {
  return base ? `${base}.${key}` : key;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isHttpsString(value: unknown): value is string {
  return typeof value === "string" && value.startsWith("https://");
}

function isApi(value: unknown): value is Api {
  return typeof value === "string" && (API_VALUES as readonly string[]).includes(value);
}
