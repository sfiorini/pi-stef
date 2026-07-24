import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  shouldUseHttp1,
  applyHttp1Config,
  __resetHttp1ConfigForTests,
} from "../src/http1-config.js";
import type { CursorSdkModule } from "../src/sdk-runtime.js";

function makeFakeSdk(): CursorSdkModule {
  const configure = vi.fn();
  return {
    Cursor: { configure } as unknown as CursorSdkModule["Cursor"],
    Agent: {} as unknown as CursorSdkModule["Agent"],
  } as unknown as CursorSdkModule;
}

describe("http1-config", () => {
  beforeEach(() => {
    __resetHttp1ConfigForTests();
    delete process.env.PI_CURSOR_HTTP_1_1;
  });

  describe("shouldUseHttp1", () => {
    it("returns true when PI_CURSOR_HTTP_1_1 is truthy", () => {
      process.env.PI_CURSOR_HTTP_1_1 = "1";
      expect(shouldUseHttp1()).toBe(true);
    });

    it("returns false when PI_CURSOR_HTTP_1_1 is unset", () => {
      expect(shouldUseHttp1()).toBe(false);
    });

    it('returns false when PI_CURSOR_HTTP_1_1 is "0"', () => {
      process.env.PI_CURSOR_HTTP_1_1 = "0";
      expect(shouldUseHttp1()).toBe(false);
    });

    it('returns false when PI_CURSOR_HTTP_1_1 is "false"', () => {
      process.env.PI_CURSOR_HTTP_1_1 = "false";
      expect(shouldUseHttp1()).toBe(false);
    });

    it('returns false when PI_CURSOR_HTTP_1_1 is "off"', () => {
      process.env.PI_CURSOR_HTTP_1_1 = "off";
      expect(shouldUseHttp1()).toBe(false);
    });

    it('returns false when PI_CURSOR_HTTP_1_1 is empty string', () => {
      process.env.PI_CURSOR_HTTP_1_1 = "";
      expect(shouldUseHttp1()).toBe(false);
    });
  });

  describe("applyHttp1Config", () => {
    it("calls sdk.Cursor.configure with the correct value", async () => {
      process.env.PI_CURSOR_HTTP_1_1 = "1";
      const sdk = makeFakeSdk();
      await applyHttp1Config(async () => sdk);
      expect(sdk.Cursor.configure).toHaveBeenCalledOnce();
      expect(sdk.Cursor.configure).toHaveBeenCalledWith({
        local: { useHttp1ForAgent: true },
      });
    });

    it("is idempotent — second call does NOT call configure again", async () => {
      process.env.PI_CURSOR_HTTP_1_1 = "1";
      const sdk = makeFakeSdk();
      const loadSdk = async () => sdk;
      await applyHttp1Config(loadSdk);
      await applyHttp1Config(loadSdk);
      expect(sdk.Cursor.configure).toHaveBeenCalledOnce();
    });
  });
});
