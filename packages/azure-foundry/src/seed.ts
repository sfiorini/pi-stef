import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { CONFIG_SCHEMA } from "./schema.mjs";

const SEED_CONFIG = `{
  "$schema": "./config.schema.json",
  "deployments": [
    // {
    //   "id": "azure-foundry",
    //   "name": "Azure Foundry",
    //   "baseUrl": "https://<resource>.services.ai.azure.com/openai/v1/",
    //   // trailing slash matters; do not add /chat/completions or api-version=
    //   "apiKeyEnv": "AZURE_API_KEY",
    //   "api": "openai-completions",
    //   "models": [
    //     {
    //       "id": "Kimi-K2.6",
    //       "name": "Kimi K2.6",
    //       "reasoning": false,
    //       "input": ["text"],
    //       "contextWindow": 128000,
    //       "maxTokens": 2048,
    //       "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 }
    //     }
    //   ]
    // }
  ]
}
`;

export function writeSeed(configPath: string): boolean {
  if (existsSync(configPath)) return false;

  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(configPath, SEED_CONFIG, "utf8");
  return true;
}

export function writeSchemaFile(configDir: string): boolean {
  const schemaPath = join(configDir, "config.schema.json");
  if (existsSync(schemaPath)) return false;

  mkdirSync(configDir, { recursive: true });
  writeFileSync(schemaPath, JSON.stringify(CONFIG_SCHEMA, null, 2) + "\n", "utf8");
  return true;
}

export const __testInternals = { SEED_CONFIG };
