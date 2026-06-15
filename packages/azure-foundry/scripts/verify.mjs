#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { request } from "node:https";
import { homedir } from "node:os";
import { join } from "node:path";

const configPath = process.env.PI_AZURE_FOUNDRY_CONFIG || join(homedir(), ".pi", "azure-foundry", "config.json");

if (!existsSync(configPath)) {
  console.error(`[verify] No config at ${configPath}. Run Pi once to seed it.`);
  process.exit(1);
}

function stripComments(source) {
  return source.replace(/("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')|\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, (match, stringLiteral) => stringLiteral ?? "");
}

function sdkConcat(baseURL, path) {
  const concat = baseURL.endsWith("/") && path.startsWith("/") ? baseURL + path.slice(1) : baseURL + path;
  return new URL(concat).toString();
}

function composeRequestUrl(dep) {
  if (dep.api === "openai-completions") {
    return sdkConcat(dep.baseUrl, "/chat/completions");
  }

  const url = new URL(dep.baseUrl);
  const isAzureHost = url.hostname.endsWith(".openai.azure.com") || url.hostname.endsWith(".cognitiveservices.azure.com");
  if (isAzureHost) {
    url.pathname = "/openai/v1/responses";
    const apiVersion = (process.env.AZURE_OPENAI_API_VERSION || "v1").trim();
    url.search = `?api-version=${encodeURIComponent(apiVersion)}`;
    return url.toString();
  }

  return sdkConcat(dep.baseUrl, "/responses");
}

function buildPayload(dep) {
  const modelId = dep.models[0].id;
  if (dep.api === "azure-openai-responses") {
    return JSON.stringify({ input: "ping", max_output_tokens: 1, model: modelId });
  }

  return JSON.stringify({
    messages: [{ role: "user", content: "ping" }],
    max_tokens: 1,
    model: modelId,
  });
}

function resolveHeaders(map) {
  const out = {};
  for (const [key, envName] of Object.entries(map || {})) {
    const value = process.env[envName];
    if (value) {
      out[key] = value;
    } else {
      console.log(`[verify] Warning: header env var ${envName} is not set; sending literal "${envName}" as the value to match Pi runtime fallback.`);
      out[key] = envName;
    }
  }
  return out;
}

async function checkDeployment(dep, key) {
  const url = new URL(composeRequestUrl(dep));
  const body = buildPayload(dep);
  const headers = {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body),
    ...resolveHeaders(dep.headers),
  };
  if (dep.authHeader !== false) {
    headers.Authorization = `Bearer ${key}`;
  }

  const status = await new Promise((resolve, reject) => {
    const req = request(
      {
        method: "POST",
        hostname: url.hostname,
        port: url.port || 443,
        path: url.pathname + url.search,
        headers,
        timeout: 10000,
      },
      (res) => resolve(res.statusCode),
    );
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("timeout after 10s")));
    req.write(body);
    req.end();
  });

  if (status === 200) console.log(`[${dep.id}] OK 200 - provider reachable at ${url.toString()}`);
  else if (status === 401) throw new Error(`401 - bearer token rejected. Check ${dep.apiKeyEnv}.`);
  else if (status === 404) throw new Error(`404 - model "${dep.models[0].id}" not found at ${url.toString()}.`);
  else throw new Error(`HTTP ${status} at ${url.toString()}`);
}

const cfg = JSON.parse(stripComments(readFileSync(configPath, "utf8")));
let failed = 0;

for (const dep of cfg.deployments) {
  const key = process.env[dep.apiKeyEnv];
  if (!key) {
    console.log(`[${dep.id}] FAIL env var ${dep.apiKeyEnv} is not set`);
    failed++;
    continue;
  }
  try {
    await checkDeployment(dep, key);
  } catch (error) {
    console.log(`[${dep.id}] FAIL ${error instanceof Error ? error.message : String(error)}`);
    failed++;
  }
}

process.exit(failed > 0 ? 1 : 0);
