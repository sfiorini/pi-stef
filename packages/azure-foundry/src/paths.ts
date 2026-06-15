import { homedir } from "node:os";
import { dirname, join } from "node:path";

const ENV_OVERRIDE = "PI_AZURE_FOUNDRY_CONFIG";

export function getConfigPath(): string {
  const override = process.env[ENV_OVERRIDE]?.trim();
  if (override) return override;

  return join(homedir(), ".pi", "azure-foundry", "config.json");
}

export function getConfigDir(): string {
  return dirname(getConfigPath());
}
