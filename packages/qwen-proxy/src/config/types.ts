export interface Account {
  id: number;
  email: string;
  password: string;
  ord: number;
}

export interface QwenProxyConfig {
  host: string;               // SF_QWEN_HOST            default "127.0.0.1"
  port: number;               // SF_QWEN_PORT            default 7790
  dbPath: string;             // SF_QWEN_DB              default "./data/qwen-proxy.db"
  authUrl: string;            // SF_QWEN_AUTH_URL        default "https://chat.qwen.ai"
  apiUrl: string;             // SF_QWEN_API_URL         default "https://chat.qwen.ai"
  refreshIntervalMs: number;  // SF_QWEN_REFRESH_INTERVAL_MS  default 900000   (15 min)
  jwtRefreshMs: number;       // SF_QWEN_JWT_REFRESH_MS       default 21600000 (6 h)
  refreshThresholdMs: number; // SF_QWEN_REFRESH_THRESHOLD_MS default 21600000 (6 h)
  loginTimeoutMs: number;     // SF_QWEN_LOGIN_TIMEOUT_MS     default 10000
  staggerMs: number;          // SF_QWEN_STAGGER_MS           default 5000
  rateLimitCooldownMs: number;// SF_QWEN_RATE_LIMIT_COOLDOWN_MS default 86400000 (24h)
  reenableIntervalMs: number; // SF_QWEN_REENABLE_INTERVAL_MS default 60000   (1 min)
  apiKeyEnv: string[];       // SF_QWEN_API_KEY           default []  (comma-split)
  modelAliasesRaw: string;   // SF_QWEN_MODEL_ALIASES     default ""  (JSON object)
  logLevel: string;           // SF_QWEN_LOG_LEVEL            default "info"
  accounts: Account[];
  adminKey?: string;          // SF_QWEN_ADMIN_KEY      default undefined (dashboard disabled)
}
