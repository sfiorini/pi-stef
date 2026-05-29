import { beforeEach, describe, expect, it, vi } from "vitest";

const handleSearchCommand = vi.fn(async () => "search ok");
const createCloakBrowserSearchAdapter = vi.fn(() => ({ search: vi.fn() }));

vi.mock("../src/search", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/search")>()),
  handleSearchCommand,
}));

vi.mock("../src/browser/cloak", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/browser/cloak")>()),
  createCloakBrowserSearchAdapter,
}));

describe("web tool wiring", () => {
  beforeEach(() => {
    handleSearchCommand.mockClear();
    createCloakBrowserSearchAdapter.mockClear();
  });

  it("wires web_search to the CloakBrowser search adapter for browser provider fallback", async () => {
    const { default: webAccessExtension } = await import("../extensions/web");
    const pi = new FakePi();
    webAccessExtension(pi as never);

    await pi.tools.find((tool) => tool.name === "web_search")?.execute("call-1", {
      headless: true,
      maxResults: 3,
      profile: "search-profile",
      providers: ["google"],
      query: "espresso machines",
    });

    expect(createCloakBrowserSearchAdapter).toHaveBeenCalledWith(expect.any(Object), {
      headless: true,
      profile: "search-profile",
    });
    expect(handleSearchCommand).toHaveBeenCalledWith(
      "espresso machines",
      expect.objectContaining({
        browser: expect.objectContaining({ search: expect.any(Function) }),
        maxResults: 3,
        providers: ["google"],
      }),
    );
  });
});

class FakePi {
  tools: Array<{ name: string; execute: (...args: any[]) => Promise<any> }> = [];

  registerTool(tool: { name: string; execute: (...args: any[]) => Promise<any> }): void {
    this.tools.push(tool);
  }

  registerCommand(): void {}
}
