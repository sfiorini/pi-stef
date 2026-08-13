export interface BaxiaConfig {
  chromePath?: string;
  cacheTtlMs: number;
  baxiaVersion: string;
  preWarm: boolean;
  fallback: boolean;
}

export interface QwenProxyConfig {
  host: string;               // SF_QWEN_HOST            default "127.0.0.1"
  port: number;               // SF_QWEN_PORT            default 7790
  dbPath: string;             // SF_QWEN_DB              default "./data/qwen-proxy.db"
  emptyCooldownMs: number;    // SF_QWEN_EMPTY_COOLDOWN_MS    default 10000  (10s — flat pool cooldown applied AFTER inline empty-retries are exhausted)
  emptyRetryMax: number;     // SF_QWEN_EMPTY_RETRY_MAX    default 3   (inline retries on an empty completion before giving up; 0 disables)
  emptyRetryGapMs: number;   // SF_QWEN_EMPTY_RETRY_GAP_MS default 1000 (sleep between inline empty-retries, ms)
  minRequestGapMs: number;    // SF_QWEN_MIN_REQUEST_GAP_MS   default 4000   (look-human throttle, 0 disables)
  maxConcurrency: number;     // SF_QWEN_MAX_CONCURRENCY      default 1        (max in-flight chat.qwen.ai calls; 1 = serialize like the web chat)
  apiKeyEnv: string[];       // SF_QWEN_API_KEY           default []  (comma-split)
  modelAliasesRaw: string;   // SF_QWEN_MODEL_ALIASES     default ""  (JSON object)
  logLevel: string;           // SF_QWEN_LOG_LEVEL            default "info"
  adminKey?: string;          // SF_QWEN_ADMIN_KEY      default undefined (dashboard disabled)
  baxia: BaxiaConfig;
}
