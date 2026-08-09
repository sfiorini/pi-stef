/**
 * ssxmod cookie generator.
 * Faithful TypeScript port of Git-think/Qwen-Proxy src/utils/cookie-generator.js.
 * LZW-compresses the fingerprint → custom Base64 → two ssxmod cookies.
 */

import { generateFingerprint } from "./fingerprint";

// ── Types ───────────────────────────────────────────────────────────────────

export interface CookiePair {
  ssxmod_itna: string;
  ssxmod_itna2: string;
}

// ── Constants ───────────────────────────────────────────────────────────────

/** Custom Base64 character table (NOT standard Base64). */
const CUSTOM_BASE64_CHARS =
  "DGi0YA7BemWnQjCl4_bR3f8SKIF9tUz/xhr2oEOgPpac=61ZqwTudLkM5vHyNXsVJ";

/**
 * Hash field positions that need random re-generation on each call.
 * "split" = field 16 format is "count|hash" (only replace the hash part).
 * "full"  = replace the entire field with a random hash.
 */
const HASH_FIELDS: Record<number, "split" | "full"> = {
  16: "split",
  17: "full",
  18: "full",
  31: "full",
  34: "full",
  36: "full",
};

// ── LZW Compression ────────────────────────────────────────────────────────

function randomHash(): number {
  return Math.floor(Math.random() * 4294967296);
}

/**
 * LZW-compress `data` using `bits` bits per code, outputting via `charFunc`.
 * Byte-faithful port of the reference lzwCompress.
 */
function lzwCompress(
  data: string,
  bits: number,
  charFunc: (index: number) => string,
): string {
  if (data == null) return "";

  const dict: Record<string, number> = {};
  const dictToCreate: Record<string, boolean> = {};
  let c = "";
  let wc = "";
  let w = "";
  let enlargeIn = 2;
  let dictSize = 3;
  let numBits = 2;
  const result: string[] = [];
  let value = 0;
  let position = 0;

  function emitBit(b: number): void {
    value = (value << 1) | b;
    if (position === bits - 1) {
      position = 0;
      result.push(charFunc(value));
      value = 0;
    } else {
      position++;
    }
  }

  for (let i = 0; i < data.length; i++) {
    c = data.charAt(i);

    if (!Object.prototype.hasOwnProperty.call(dict, c)) {
      dict[c] = dictSize++;
      dictToCreate[c] = true;
    }

    wc = w + c;

    if (Object.prototype.hasOwnProperty.call(dict, wc)) {
      w = wc;
    } else {
      if (Object.prototype.hasOwnProperty.call(dictToCreate, w)) {
        if (w.charCodeAt(0) < 256) {
          // Emit numBits zeros (code for "literal < 256" marker)
          for (let j = 0; j < numBits; j++) {
            emitBit(0);
          }
          // Emit 8 bits of the char code (LSB first)
          let charCode = w.charCodeAt(0);
          for (let j = 0; j < 8; j++) {
            emitBit(charCode & 1);
            charCode >>= 1;
          }
        } else {
          // Emit numBits with leading 1 (code for "literal >= 256" marker)
          let charCode = 1;
          for (let j = 0; j < numBits; j++) {
            emitBit(charCode);
            charCode = 0;
          }
          // Emit 16 bits of the char code (LSB first)
          charCode = w.charCodeAt(0);
          for (let j = 0; j < 16; j++) {
            emitBit(charCode & 1);
            charCode >>= 1;
          }
        }

        enlargeIn--;
        if (enlargeIn === 0) {
          enlargeIn = Math.pow(2, numBits);
          numBits++;
        }
        delete dictToCreate[w];
      } else {
        // Emit dictionary code
        let charCode = dict[w];
        for (let j = 0; j < numBits; j++) {
          emitBit(charCode & 1);
          charCode >>= 1;
        }
      }

      enlargeIn--;
      if (enlargeIn === 0) {
        enlargeIn = Math.pow(2, numBits);
        numBits++;
      }

      dict[wc] = dictSize++;
      w = String(c);
    }
  }

  // Flush remaining `w`
  if (w !== "") {
    if (Object.prototype.hasOwnProperty.call(dictToCreate, w)) {
      if (w.charCodeAt(0) < 256) {
        for (let j = 0; j < numBits; j++) {
          emitBit(0);
        }
        let charCode = w.charCodeAt(0);
        for (let j = 0; j < 8; j++) {
          emitBit(charCode & 1);
          charCode >>= 1;
        }
      } else {
        let charCode = 1;
        for (let j = 0; j < numBits; j++) {
          emitBit(charCode);
          charCode = 0;
        }
        charCode = w.charCodeAt(0);
        for (let j = 0; j < 16; j++) {
          emitBit(charCode & 1);
          charCode >>= 1;
        }
      }

      enlargeIn--;
      if (enlargeIn === 0) {
        enlargeIn = Math.pow(2, numBits);
        numBits++;
      }
      delete dictToCreate[w];
    } else {
      let charCode = dict[w];
      for (let j = 0; j < numBits; j++) {
        emitBit(charCode & 1);
        charCode >>= 1;
      }
    }

    enlargeIn--;
    if (enlargeIn === 0) {
      enlargeIn = Math.pow(2, numBits);
      numBits++;
    }
  }

  // Emit end-of-stream marker (code 2)
  let charCode = 2;
  for (let j = 0; j < numBits; j++) {
    emitBit(charCode & 1);
    charCode >>= 1;
  }

  // Pad remaining bits
  while (true) {
    value = value << 1;
    if (position === bits - 1) {
      result.push(charFunc(value));
      break;
    }
    position++;
  }

  return result.join("");
}

// ── Custom Encode ───────────────────────────────────────────────────────────

/**
 * LZW-compress `data` with bits=6 using CUSTOM_BASE64_CHARS.
 * urlSafe=true skips padding (matches the reference behavior).
 */
function customEncode(data: string, urlSafe: boolean): string {
  if (data == null) return "";

  const compressed = lzwCompress(data, 6, (index) =>
    CUSTOM_BASE64_CHARS.charAt(index),
  );

  if (!urlSafe) {
    switch (compressed.length % 4) {
      case 1:
        return compressed + "===";
      case 2:
        return compressed + "==";
      case 3:
        return compressed + "=";
      default:
        return compressed;
    }
  }

  return compressed;
}

// ── Field Processing ────────────────────────────────────────────────────────

function processFields(fields: string[]): string[] {
  const processed = [...fields];
  const currentTimestamp = Date.now();

  for (const [index, type] of Object.entries(HASH_FIELDS)) {
    const idx = parseInt(index, 10);

    if (type === "split") {
      // Field 16: format "count|hash", only replace hash part
      const parts = processed[idx].split("|");
      if (parts.length === 2) {
        processed[idx] = `${parts[0]}|${randomHash()}`;
      }
    } else if (type === "full") {
      if (idx === 36) {
        // Field 36: document property hash (random int 10-100)
        processed[idx] = String(Math.floor(Math.random() * 91) + 10);
      } else {
        processed[idx] = String(randomHash());
      }
    }
  }

  processed[33] = String(currentTimestamp); // Field 33: current timestamp

  return processed;
}

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Generate the two ssxmod cookies from a browser fingerprint.
 * Calls `generateFingerprint()` internally, randomizes hash fields,
 * LZW-compresses with the custom Base64 table, and returns both cookies.
 */
export function generateCookies(
  realData?: string,
): CookiePair {
  const fingerprint = realData ?? generateFingerprint();
  const fields = fingerprint.split("^");
  const processedFields = processFields(fields);

  // ssxmod_itna: all 37 fields, LZW+Base64 encoded
  const ssxmod_itna_data = processedFields.join("^");
  const ssxmod_itna = "1-" + customEncode(ssxmod_itna_data, true);

  // ssxmod_itna2: 18-field subset, LZW+Base64 encoded
  const ssxmod_itna2_data = [
    processedFields[0],  // Device ID
    processedFields[1],  // SDK version
    processedFields[23], // Mode (P/M)
    "0",
    "",
    "0",
    "",
    "",
    "0",
    "0",
    "0",
    processedFields[32], // Constant (11)
    processedFields[33], // Current timestamp
    "0",
    "0",
    "0",
    "0",
    "0",
  ].join("^");
  const ssxmod_itna2 = "1-" + customEncode(ssxmod_itna2_data, true);

  return { ssxmod_itna, ssxmod_itna2 };
}
