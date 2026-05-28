import { describe, expect, it } from "vitest";

import { _internal, notifyTelegram } from "../src/notify/telegram";
import { existsSync } from "node:fs";

describe("M9 notifyTelegram (S-907/S-908)", () => {
  it("returns attempted=false when telegram is disabled in config", () => {
    const r = notifyTelegram("hi", { enabled: false });
    expect(r).toEqual({ attempted: false, ok: false, reason: "telegram disabled in config" });
  });

  it("returns attempted=false when bundled helper is missing", () => {
    const r = notifyTelegram("hi", { enabled: true, helperPath: "/nope/notify-telegram.sh" });
    expect(r.attempted).toBe(false);
    expect(r.reason).toMatch(/missing/);
  });

  it("returns attempted=false when TELEGRAM env vars are not set", () => {
    const prevToken = process.env.TELEGRAM_BOT_TOKEN;
    const prevChat = process.env.TELEGRAM_CHAT_ID;
    delete process.env.TELEGRAM_BOT_TOKEN;
    delete process.env.TELEGRAM_CHAT_ID;
    try {
      const r = notifyTelegram("hi", { enabled: true });
      expect(r.attempted).toBe(false);
      expect(r.reason).toMatch(/TELEGRAM_BOT_TOKEN/);
    } finally {
      if (prevToken) process.env.TELEGRAM_BOT_TOKEN = prevToken;
      if (prevChat) process.env.TELEGRAM_CHAT_ID = prevChat;
    }
  });

  it("bundled helper is shipped at packages/sf-team/bin/notify-telegram.sh", () => {
    expect(existsSync(_internal.BUNDLED_HELPER)).toBe(true);
  });
});
