import { existsSync, readFileSync } from "node:fs";

import { stripJsonc } from "./jsonc";
import { getConfigDir, getConfigPath } from "./paths";
import { writeSchemaFile, writeSeed } from "./seed";
import type { Config } from "./types";

export function loadConfig(): Config {
  const configPath = getConfigPath();
  const configDir = getConfigDir();

  writeSchemaFile(configDir);
  if (!existsSync(configPath)) {
    writeSeed(configPath);
  }

  const raw = readFileSync(configPath, "utf8");
  return JSON.parse(stripJsonc(raw)) as Config;
}
