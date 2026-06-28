const SENSITIVE_KEYS = new Set(["token", "privateKey", "consumerKey", "accessKey", "secret", "password"]);

function redact(obj: unknown): unknown {
  if (typeof obj !== "object" || obj === null) return obj;
  if (Array.isArray(obj)) return obj.map(redact);
  const result: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    result[k] = SENSITIVE_KEYS.has(k) ? "[REDACTED]" : redact(v);
  }
  return result;
}

export interface Logger {
  info(msg: string, ctx?: unknown): void;
  warn(msg: string, ctx?: unknown): void;
  error(msg: string, ctx?: unknown): void;
}

export function createLogger(): Logger {
  const log = (level: string, msg: string, ctx?: unknown) => {
    const entry = { level, msg, ts: new Date().toISOString(), ...(ctx ? { ctx: redact(ctx) } : {}) };
    process.stderr.write(JSON.stringify(entry) + "\n");
  };
  return {
    info: (msg, ctx) => log("info", msg, ctx),
    warn: (msg, ctx) => log("warn", msg, ctx),
    error: (msg, ctx) => log("error", msg, ctx),
  };
}
