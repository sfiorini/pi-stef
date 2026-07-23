import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  getCursorModelsCachePath,
  readCachedCursorModels,
  writeCachedCursorModels,
} from "../src/model-cache";
import type { CursorModel, CursorParameterizedModel } from "../src/proxy";

const sampleRaw: CursorModel[] = [
  { id: "gpt-5.4", name: "GPT-5.4", reasoning: false, contextWindow: 272_000, maxTokens: 64_000 },
];
const sampleParam: CursorParameterizedModel[] = [];

describe("model-cache path", () => {
  it("getCursorModelsCachePath returns ~/.pi/agent/cursor-models-cache.json", () => {
    expect(getCursorModelsCachePath("/home/u")).toBe(
      join("/home/u", ".pi", "agent", "cursor-models-cache.json"),
    );
  });
});

describe("model-cache round-trip", () => {
  let home: string;
  beforeEach(() => { home = mkdtempSync(join(tmpdir(), "cursor-cache-")); });
  afterEach(() => { rmSync(home, { recursive: true, force: true }); });

  it("write then read returns the same models, savedAt, and tokenHash", () => {
    writeCachedCursorModels(sampleRaw, sampleParam, "hash123", home);
    const cached = readCachedCursorModels(home);
    expect(cached).not.toBeNull();
    expect(cached!.rawModels).toEqual(sampleRaw);
    expect(cached!.parameterizedModels).toEqual(sampleParam);
    expect(cached!.tokenHash).toBe("hash123");
    expect(cached!.savedAt).toBeGreaterThan(0);
  });

  it("read returns null when the cache file is missing", () => {
    expect(readCachedCursorModels(home)).toBeNull();
  });

  it("read returns null for corrupt JSON", () => {
    mkdirSync(join(home, ".pi", "agent"), { recursive: true });
    writeFileSync(getCursorModelsCachePath(home), "{not json", "utf8");
    expect(readCachedCursorModels(home)).toBeNull();
  });

  it("read returns null when rawModels/parameterizedModels are not arrays", () => {
    mkdirSync(join(home, ".pi", "agent"), { recursive: true });
    writeFileSync(
      getCursorModelsCachePath(home),
      JSON.stringify({ rawModels: "nope", savedAt: 1, tokenHash: "x" }),
      "utf8",
    );
    expect(readCachedCursorModels(home)).toBeNull();
  });

  it("survives a restart: a fresh read returns the persisted models", () => {
    writeCachedCursorModels(sampleRaw, sampleParam, "restart-hash", home);
    const afterRestart = readCachedCursorModels(home);
    expect(afterRestart).not.toBeNull();
    expect(afterRestart!.rawModels).toEqual(sampleRaw);
    expect(afterRestart!.tokenHash).toBe("restart-hash");
  });

  it("write creates the ~/.pi/agent directory if it does not exist", () => {
    writeCachedCursorModels(sampleRaw, sampleParam, "mkdir-hash", home);
    expect(readCachedCursorModels(home)).not.toBeNull();
  });

  it("write is non-fatal when the directory cannot be created", () => {
    const bogus = join(home, "imafile");
    writeFileSync(bogus, "x");
    expect(() => writeCachedCursorModels(sampleRaw, sampleParam, "h", bogus)).not.toThrow();
  });
});
