/**
 * 37-field browser-fingerprint generator.
 * Faithful TypeScript port of Git-think/Qwen-Proxy src/utils/fingerprint.js.
 */

// ── Presets ─────────────────────────────────────────────────────────────────

interface Template {
  sdkVersion: string;
  initTimestamp: string;
  field3: string;
  field4: string;
  language: string;
  timezoneOffset: string;
  colorDepth: string;
  screenInfo: string;
  field9: string;
  platform: string;
  field11: string;
  webglRenderer: string;
  field13: string;
  field14: string;
  field15: string;
  pluginCount: string;
  vendor: string;
  field29: string;
  touchInfo: string;
  field32: string;
  field35: string;
  mode: string;
}

const DEFAULT_TEMPLATE: Template = {
  sdkVersion: "websdk-2.3.15d",
  initTimestamp: "1765348410850",
  field3: "91",
  field4: "1|15",
  language: "zh-CN",
  timezoneOffset: "-480",
  colorDepth: "16705151|12791",
  screenInfo: "1470|956|283|797|158|0|1470|956|1470|798|0|0",
  field9: "5",
  platform: "MacIntel",
  field11: "10",
  webglRenderer:
    "ANGLE (Apple, ANGLE Metal Renderer: Apple M4, Unspecified Version)|Google Inc. (Apple)",
  field13: "30|30",
  field14: "0",
  field15: "28",
  pluginCount: "5",
  vendor: "Google Inc.",
  field29: "8",
  touchInfo: "-1|0|0|0|0",
  field32: "11",
  field35: "0",
  mode: "P",
};

const SCREEN_PRESETS: Record<string, string> = {
  "1920x1080":
    "1920|1080|283|1080|158|0|1920|1080|1920|922|0|0",
  "2560x1440":
    "2560|1440|283|1440|158|0|2560|1440|2560|1282|0|0",
  "1470x956":
    "1470|956|283|797|158|0|1470|956|1470|798|0|0",
  "1440x900":
    "1440|900|283|900|158|0|1440|900|1440|742|0|0",
  "1536x864":
    "1536|864|283|864|158|0|1536|864|1536|706|0|0",
};

interface PlatformPreset {
  platform: string;
  webglRenderer: string;
  vendor: string;
}

const PLATFORM_PRESETS: Record<string, PlatformPreset> = {
  macIntel: {
    platform: "MacIntel",
    webglRenderer:
      "ANGLE (Apple, ANGLE Metal Renderer: Apple M4, Unspecified Version)|Google Inc. (Apple)",
    vendor: "Google Inc.",
  },
  macM1: {
    platform: "MacIntel",
    webglRenderer:
      "ANGLE (Apple, ANGLE Metal Renderer: Apple M1, Unspecified Version)|Google Inc. (Apple)",
    vendor: "Google Inc.",
  },
  win64: {
    platform: "Win32",
    webglRenderer:
      "ANGLE (NVIDIA, NVIDIA GeForce RTX 3080 Direct3D11 vs_5_0 ps_5_0, D3D11)|Google Inc. (NVIDIA)",
    vendor: "Google Inc.",
  },
  linux: {
    platform: "Linux x86_64",
    webglRenderer:
      "ANGLE (Intel, Mesa Intel(R) UHD Graphics 630, OpenGL 4.6)|Google Inc. (Intel)",
    vendor: "Google Inc.",
  },
};

interface LocalePreset {
  language: string;
  timezoneOffset: string;
}

const LANGUAGE_PRESETS: Record<string, LocalePreset> = {
  "zh-CN": { language: "zh-CN", timezoneOffset: "-480" },
  "zh-TW": { language: "zh-TW", timezoneOffset: "-480" },
  "en-US": { language: "en-US", timezoneOffset: "480" },
  "ja-JP": { language: "ja-JP", timezoneOffset: "-540" },
  "ko-KR": { language: "ko-KR", timezoneOffset: "-540" },
};

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Generate a device ID: 20 random hex characters. */
function generateDeviceId(): string {
  return Array.from({ length: 20 }, () =>
    Math.floor(Math.random() * 16).toString(16),
  ).join("");
}

/** Generate a random 32-bit unsigned integer hash. */
function generateHash(): number {
  return Math.floor(Math.random() * 4294967296);
}

// ── Options ─────────────────────────────────────────────────────────────────

export interface FingerprintOptions {
  deviceId?: string;
  platform?: string;
  screen?: string;
  locale?: string;
  custom?: Partial<Template>;
}

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Build a 37-field caret-delimited browser-fingerprint string.
 * Each call randomizes deviceId, hashes, and current timestamp.
 */
export function generateFingerprint(options: FingerprintOptions = {}): string {
  const config: Template = { ...DEFAULT_TEMPLATE };

  // Apply platform preset
  if (options.platform && PLATFORM_PRESETS[options.platform]) {
    Object.assign(config, PLATFORM_PRESETS[options.platform]);
  }

  // Apply screen preset
  if (options.screen && SCREEN_PRESETS[options.screen]) {
    config.screenInfo = SCREEN_PRESETS[options.screen];
  }

  // Apply locale preset
  if (options.locale && LANGUAGE_PRESETS[options.locale]) {
    Object.assign(config, LANGUAGE_PRESETS[options.locale]);
  }

  // Apply custom overrides
  if (options.custom) {
    Object.assign(config, options.custom);
  }

  // Device ID
  const deviceId = options.deviceId || generateDeviceId();

  // Current timestamp
  const currentTimestamp = Date.now();

  // Random per-call hashes
  const pluginHash = generateHash();
  const canvasHash = generateHash();
  const uaHash1 = generateHash();
  const uaHash2 = generateHash();
  const urlHash = generateHash();
  const docHash = Math.floor(Math.random() * 91) + 10;

  // The 37 fields (0-indexed)
  const fields = [
    deviceId,                               // 0:  device ID
    config.sdkVersion,                      // 1:  SDK version
    config.initTimestamp,                   // 2:  init timestamp
    config.field3,                          // 3
    config.field4,                          // 4
    config.language,                        // 5:  language
    config.timezoneOffset,                  // 6:  timezone offset
    config.colorDepth,                      // 7:  color depth
    config.screenInfo,                      // 8:  screen info
    config.field9,                          // 9
    config.platform,                        // 10: platform
    config.field11,                         // 11
    config.webglRenderer,                   // 12: WebGL renderer
    config.field13,                         // 13
    config.field14,                         // 14
    config.field15,                         // 15
    `${config.pluginCount}|${pluginHash}`,  // 16: plugin count | plugin hash
    String(canvasHash),                     // 17: canvas hash
    String(uaHash1),                        // 18: UA hash 1
    "1",                                    // 19
    "0",                                    // 20
    "1",                                    // 21
    "0",                                    // 22
    config.mode,                            // 23: mode (P/M)
    "0",                                    // 24
    "0",                                    // 25
    "0",                                    // 26
    "416",                                  // 27
    config.vendor,                          // 28: vendor
    config.field29,                         // 29
    config.touchInfo,                       // 30: touch info
    String(uaHash2),                        // 31: UA hash 2
    config.field32,                         // 32: constant (11)
    String(currentTimestamp),               // 33: current timestamp
    String(urlHash),                        // 34: URL hash
    config.field35,                         // 35
    String(docHash),                        // 36: document property hash
  ];

  return fields.join("^");
}
