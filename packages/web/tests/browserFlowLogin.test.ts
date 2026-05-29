import { describe, expect, it } from "vitest";

import { guardBrowserNavigation } from "../src/browser/navigation";
import { normalizeFlowSteps, parseFlowSteps, runWebFlow } from "../src/browser/flow";
import { runWebLogin } from "../src/browser/login";
import type { BrowserRuntime, BrowserPage } from "../src/browser/runtime";

describe("browser flow and login helpers", () => {
  it("parses natural-language flow instructions and executes steps", async () => {
    const page = new FakePage();
    const runtime = new FakeRuntime(page);
    const steps = parseFlowSteps(
      'go to https://example.com then click button "Search" then type "pi" in #q then press enter then wait 25ms then screenshot /tmp/a.png',
    );

    const result = await runWebFlow({ runtime, steps });

    expect(result.finalUrl).toBe("https://example.com/");
    expect(result.screenshots).toEqual(["/tmp/a.png"]);
    expect(page.calls).toEqual([
      ["goto", "https://example.com/"],
      ["role-click", "button", "Search"],
      ["fill", "#q", "pi"],
      ["press", undefined, "Enter"],
      ["wait", 25],
      ["screenshot", "/tmp/a.png"],
    ]);
    expect(runtime.closed).toBe(true);
  });

  it("parses host-only search instructions into a deterministic browser flow", () => {
    expect(parseFlowSteps("go to walmart.com and search for espresso machines")).toEqual([
      { action: "goto", url: "https://walmart.com/" },
      { action: "type", text: "espresso machines" },
      { action: "press", key: "Enter" },
      { action: "wait", ms: 2000 },
      { action: "extract", selector: "body" },
    ]);
  });

  it("normalizes common agent-generated browser action aliases", () => {
    expect(
      normalizeFlowSteps([
        { action: "navigate", url: "https://www.walmart.com," } as never,
        { action: "fill", selector: "input[name='q']", text: "espresso machines" } as never,
        { action: "keypress", key: "enter" } as never,
      ]),
    ).toEqual([
      { action: "goto", url: "https://www.walmart.com/" },
      { action: "type", selector: "input[name='q']", text: "espresso machines" },
      { action: "press", key: "Enter" },
    ]);
  });

  it("extracts selector text during a flow", async () => {
    const page = new FakePage(["One", "Two", "Three"]);

    const result = await runWebFlow({
      runtime: new FakeRuntime(page),
      steps: [{ action: "extract", count: 2, selector: ".item" }],
    });

    expect(result.extracted).toEqual([{ selector: ".item", values: ["One", "Two"] }]);
  });

  it("applies a navigation guard before flow goto steps", async () => {
    const page = new FakePage();
    const guarded: string[] = [];

    await runWebFlow({
      guardNavigation: async (url) => {
        guarded.push(url);
        return "https://safe.example.com/";
      },
      runtime: new FakeRuntime(page),
      steps: [{ action: "goto", url: "https://example.com" }],
    });

    expect(guarded).toEqual(["https://example.com/"]);
    expect(page.calls).toContainEqual(["goto", "https://safe.example.com/"]);
  });

  it("blocks private browser navigations through the shared guard", async () => {
    await expect(
      guardBrowserNavigation("http://127.0.0.1/admin", {
        allowPrivateNetworks: false,
        fetchMaxBytes: 2 * 1024 * 1024,
        fetchTimeoutMs: 1000,
        maxBytes: 1000,
        maxLines: 100,
        maxResults: 5,
        outputDir: "/tmp/fh-web",
        profilesDir: "/tmp/fh-web-profiles",
        searchProviders: ["duckduckgo"],
        sensitiveQueryKeys: [],
        userAgent: "test",
      }),
    ).rejects.toThrow(/blocked/i);
  });

  it("uses credential environment names for form login without raw password parameters", async () => {
    const page = new FakePage();

    const result = await runWebLogin({
      env: {
        SF_WEB_PASSWORD: "secret",
        SF_WEB_USERNAME: "user@example.com",
      },
      passwordEnv: "SF_WEB_PASSWORD",
      runtime: new FakeRuntime(page),
      url: "https://example.com/login",
      usernameEnv: "SF_WEB_USERNAME",
    });

    expect(result.success).toBe(true);
    expect(page.calls).toContainEqual(["fill", 'input[type="email"], input[name*="user" i], input[name*="email" i], input[id*="user" i], input[id*="email" i], input[autocomplete="username"], input[type="text"]', "user@example.com"]);
    expect(page.calls).toContainEqual(["fill", 'input[type="password"], input[name*="password" i], input[id*="password" i], input[autocomplete="current-password"]', "secret"]);
    expect(result.message).not.toContain("secret");
  });

  it("does not report login success when the login form is still present after submit", async () => {
    const result = await runWebLogin({
      env: {
        SF_WEB_PASSWORD: "wrong",
        SF_WEB_USERNAME: "user@example.com",
      },
      passwordEnv: "SF_WEB_PASSWORD",
      runtime: new FakeRuntime(new FakePage([], '<form><input type="password"><div class="login-error">Bad login</div></form>')),
      url: "https://example.com/login",
      usernameEnv: "SF_WEB_USERNAME",
    });

    expect(result.success).toBe(false);
    expect(result.message).toContain("not verified");
  });

  it("keeps interactive login open for the requested wait before closing the profile", async () => {
    const page = new FakePage();
    const runtime = new FakeRuntime(page);

    const result = await runWebLogin({
      interactive: true,
      interactiveWaitMs: 25,
      runtime,
      url: "https://example.com/login",
    });

    expect(result.interactive).toBe(true);
    expect(page.calls).toContainEqual(["wait", 25]);
    expect(runtime.closed).toBe(true);
  });

  it("requires env-name credentials unless interactive login is requested", async () => {
    await expect(
      runWebLogin({
        env: {},
        passwordEnv: "MISSING_PASSWORD",
        runtime: new FakeRuntime(new FakePage()),
        url: "https://example.com/login",
        usernameEnv: "MISSING_USERNAME",
      }),
    ).rejects.toThrow(/credentials/i);
  });
});

class FakeRuntime implements BrowserRuntime {
  closed = false;

  constructor(private readonly page: FakePage) {}

  async close(): Promise<void> {
    this.closed = true;
  }

  async newPage(): Promise<BrowserPage> {
    return this.page;
  }
}

class FakePage implements BrowserPage {
  calls: unknown[][] = [];

  constructor(private readonly extracted: string[] = [], private readonly html = "<main><h1>Title</h1></main>") {}

  async click(selector: string): Promise<void> {
    this.calls.push(["click", selector]);
  }

  async content(): Promise<string> {
    return this.html;
  }

  async fill(selector: string, text: string): Promise<void> {
    this.calls.push(["fill", selector, text]);
  }

  async goto(url: string): Promise<void> {
    this.calls.push(["goto", new URL(url).toString()]);
  }

  url(): string {
    const goto = this.calls.find((call) => call[0] === "goto");
    return typeof goto?.[1] === "string" ? goto[1] : "about:blank";
  }

  async press(selector: string | undefined, key: string): Promise<void> {
    this.calls.push(["press", selector, key]);
  }

  async roleClick(role: string, name: string): Promise<void> {
    this.calls.push(["role-click", role, name]);
  }

  async screenshot(path: string): Promise<void> {
    this.calls.push(["screenshot", path]);
  }

  async selectorTexts(): Promise<string[]> {
    return this.extracted;
  }

  async text(): Promise<string> {
    return this.extracted.join("\n");
  }

  async title(): Promise<string> {
    return "Title";
  }

  async wait(ms: number): Promise<void> {
    this.calls.push(["wait", ms]);
  }
}
