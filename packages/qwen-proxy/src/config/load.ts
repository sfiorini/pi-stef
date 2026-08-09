import type { QwenProxyConfig } from "./types";

export async function loadQwenProxyConfig(
  env: Record<string, string | undefined> = process.env,
): Promise<QwenProxyConfig> {
  const port = Number(env.SF_QWEN_PORT);
  return {
    host: env.SF_QWEN_HOST ?? "127.0.0.1",
    port: Number.isFinite(port) && port > 0 ? port : 7790,
    dbPath: env.SF_QWEN_DB ?? "./data/qwen-proxy.db",
  };
}
