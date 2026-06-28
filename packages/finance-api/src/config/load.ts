import { readFile } from "node:fs/promises";
import path from "node:path";
import { globalConfig, globalDir } from "@pi-stef/paths";
import type { FinanceApiConfig, DataFeed } from "./types";

export async function loadFinanceApiConfig(
  env: Record<string, string | undefined> = process.env,
  homeDir: string = process.env.HOME ?? process.cwd(),
): Promise<FinanceApiConfig> {
  const dir = globalDir("finance", homeDir);
  const defaults: FinanceApiConfig = {
    host: "127.0.0.1",
    port: 7780,
    dbPath: path.join(dir, "finance.db"),
    secretsPath: path.join(dir, "secrets.json"),
    tokenPath: path.join(dir, "token"),
    dataFeed: "stooq",
    timezone: "America/New_York",
  };

  let fileConfig: Partial<FinanceApiConfig> = {};
  try {
    const file = env.SF_FINANCE_CONFIG ?? globalConfig("finance", homeDir);
    fileConfig = JSON.parse(await readFile(file, "utf8")) as Partial<FinanceApiConfig>;
  } catch (e) {
    if (!(e instanceof Error && "code" in e && (e as { code: string }).code === "ENOENT")) throw e;
  }

  const envFeed: DataFeed | undefined = env.SF_FINANCE_DATA_FEED === "yfinance" ? "yfinance" : env.SF_FINANCE_DATA_FEED === "stooq" ? "stooq" : undefined;
  const envPort = env.SF_FINANCE_PORT ? Number(env.SF_FINANCE_PORT) : undefined;

  return {
    host: "127.0.0.1",
    port: envPort ?? fileConfig.port ?? defaults.port,
    dbPath: env.SF_FINANCE_DB ?? fileConfig.dbPath ?? defaults.dbPath,
    secretsPath: fileConfig.secretsPath ?? defaults.secretsPath,
    tokenPath: fileConfig.tokenPath ?? defaults.tokenPath,
    dataFeed: envFeed ?? fileConfig.dataFeed ?? defaults.dataFeed,
    timezone: fileConfig.timezone ?? defaults.timezone,
  };
}
