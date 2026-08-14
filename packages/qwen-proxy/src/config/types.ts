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
  proxyCount: number;         // SF_QWEN_PROXY_COUNT          default 0  (0=legacy, >1=rotation)
  proxyUrlsRaw: string;       // SF_QWEN_PROXY_URLS           default "" (explicit SOCKS5 URLs, comma-separated)
  proxyUser?: string;         // SF_QWEN_PROXY_USER           default undefined (NordVPN service creds)
  proxyPass?: string;         // SF_QWEN_PROXY_PASS           default undefined
  proxyCountriesRaw: string;  // SF_QWEN_PROXY_COUNTRIES      default "" (comma-separated country codes)
  timeoutMs: number;          // SF_QWEN_TIMEOUT_MS           default 60000  (TTFB timeout, ms)
  firstPayloadTimeoutMs: number; // SF_QWEN_FIRST_PAYLOAD_TIMEOUT_MS default 30000 (abort with EmptyCompletionError if no payload chunk within this many ms after headers; 0 disables)
  streamIdleTimeoutMs: number;  // SF_QWEN_STREAM_IDLE_TIMEOUT_MS default 30000 (end the stream gracefully if silent this many ms after content started; 0 disables)
  apiKeyEnv: string[];       // SF_QWEN_API_KEY           default []  (comma-split)
  modelAliasesRaw: string;   // SF_QWEN_MODEL_ALIASES     default ""  (JSON object)
  logLevel: string;           // SF_QWEN_LOG_LEVEL            default "info"
  adminKey?: string;          // SF_QWEN_ADMIN_KEY      default undefined (dashboard disabled)
  baxia: BaxiaConfig;
}
