import { readFile } from "node:fs/promises";
import { globalConfig } from "@pi-stef/paths";

export interface FinanceConfig {
  apiUrl: string;
  token: string;
}

export async function loadFinanceConfig(
  env: Record<string, string | undefined> = process.env,
  homeDir: string = process.env.HOME ?? process.cwd(),
): Promise<FinanceConfig> {
  let fileToken = "";
  let fileUrl = "";
  try {
    const raw = JSON.parse(await readFile(globalConfig("finance", homeDir), "utf8")) as Partial<FinanceConfig>;
    fileToken = raw.token ?? "";
    fileUrl = raw.apiUrl ?? "";
  } catch (e) {
    if (!(e instanceof Error && "code" in e && (e as { code: string }).code === "ENOENT")) throw e;
  }
  return {
    apiUrl: env.SF_FINANCE_API_URL || fileUrl || "http://127.0.0.1:7780",
    token: env.SF_FINANCE_TOKEN || fileToken || "",
  };
}
