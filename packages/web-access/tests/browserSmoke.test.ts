import { describe, expect, it } from "vitest";

import { loadWebAccessConfig } from "../src/config";
import { createCloakBrowserRuntime } from "../src/browser/cloak";

const maybeIt = process.env.FH_WEB_RUN_BROWSER_TESTS === "1" ? it : it.skip;

describe("CloakBrowser smoke", () => {
  maybeIt("launches only when explicitly enabled", async () => {
    const config = await loadWebAccessConfig({ profilesDir: "/tmp/sf-web-access-smoke" });
    const runtime = await createCloakBrowserRuntime(config, { headless: true, profile: "smoke" });
    try {
      const page = await runtime.newPage();
      await page.goto("https://example.com");
      expect(await page.title()).toContain("Example");
    } finally {
      await runtime.close();
    }
  });
});
