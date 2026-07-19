import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { globalConfig, globalDir } from "@pi-stef/paths";

export interface SnaptradeProviderConfig {
  clientId: string;
  consumerKey: string;
}

export interface SimplefinProviderConfig {
  /** One-time setup token from SimpleFIN Bridge. Exchanged for accessUrl on first sync, then discarded. */
  setupToken?: string;
  /** Persistent access URL with embedded Basic Auth. Set automatically after first sync. */
  accessUrl?: string;
}

export interface FinanceConfig {
  apiUrl: string;
  token: string;
  /** Per-provider credentials, supplied per-call so one finance-api can serve different users. */
  providers?: {
    snaptrade?: SnaptradeProviderConfig;
    simplefin?: SimplefinProviderConfig;
  };
}

export async function loadFinanceConfig(
  env: Record<string, string | undefined> = process.env,
  homeDir: string = process.env.HOME ?? process.cwd(),
): Promise<FinanceConfig> {
  let fileToken = "";
  let fileUrl = "";
  let fileProviders: FinanceConfig["providers"];
  try {
    const raw = JSON.parse(await readFile(globalConfig("finance", homeDir), "utf8")) as Partial<FinanceConfig>;
    fileToken = raw.token ?? "";
    fileUrl = raw.apiUrl ?? "";
    fileProviders = raw.providers;
  } catch (e) {
    if (!(e instanceof Error && "code" in e && (e as { code: string }).code === "ENOENT")) throw e;
  }
  
  // Try to read auto-generated token from ~/.pi/sf/finance/token
  let autoToken = "";
  if (!fileToken && !env.SF_FINANCE_TOKEN) {
    try {
      const tokenPath = path.join(globalDir("finance", homeDir), "token");
      autoToken = (await readFile(tokenPath, "utf8")).trim();
    } catch {
      // Token file doesn't exist yet (service not started)
    }
  }
  
  return {
    apiUrl: env.SF_FINANCE_API_URL || fileUrl || "http://127.0.0.1:7780",
    token: env.SF_FINANCE_TOKEN || fileToken || autoToken || "",
    providers: fileProviders,
  };
}

export async function saveProviderConfig(
  provider: string,
  creds: Record<string, string>,
  homeDir: string = process.env.HOME ?? process.cwd(),
): Promise<void> {
  const configPath = globalConfig("finance", homeDir);
  let config: FinanceConfig;
  try {
    const raw = JSON.parse(await readFile(configPath, "utf8"));
    config = {
      apiUrl: raw.apiUrl ?? "http://127.0.0.1:7780",
      token: raw.token ?? "",
      providers: raw.providers,
    };
  } catch {
    config = { apiUrl: "http://127.0.0.1:7780", token: "" };
  }
  config.providers = { ...config.providers, [provider]: creds };
  await mkdir(path.dirname(configPath), { recursive: true });
  await writeFile(configPath, JSON.stringify(config, null, 2) + "\n", "utf8");
}
