/**
 * Real-Chrome smoke test for BaxiaTokenManager.
 * Gated behind SMOKE=1 — skipped by default vitest run.
 */
import { describe, it, expect } from "vitest";
import { BaxiaTokenManager } from "../../src/upstream/baxia-token";

const SMOKE = process.env.SMOKE === "1";

(SMOKE ? describe : describe.skip)("baxia-token smoke", () => {
  it("ensureToken returns a real T2gA token via host Chrome", async () => {
    const mgr = new BaxiaTokenManager({
      chatUrl: "https://chat.qwen.ai",
      chromePath: process.env.SF_QWEN_CHROME_PATH,
      cacheTtlMs: 1_500_000,
      baxiaVersion: "2.5.37",
      fallback: false,
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36",
      log: console,
    });

    try {
      const t = await mgr.ensureToken();

      expect(t.bxUmidToken).toMatch(/^T2gA/i);
      expect(t.bxUmidToken.length).toBeGreaterThan(20);
      expect(t.bxV).toBe("2.5.37");
      expect(t.cookies.length).toBeGreaterThan(0);
    } finally {
      mgr.stop();
    }
  });
});
