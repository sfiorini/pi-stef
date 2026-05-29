import { describe, expect, it } from "vitest";

import webAccessExtension from "../extensions/web";

class FakePi {
  commands = new Map<string, unknown>();
  tools: Array<{ name: string; parameters?: unknown; promptGuidelines?: string[]; execute: (...args: any[]) => Promise<any> }> = [];

  constructor(private readonly blockedCommands = new Set<string>()) {}

  registerTool(tool: { name: string; parameters?: unknown; promptGuidelines?: string[]; execute: (...args: any[]) => Promise<any> }): void {
    this.tools.push(tool);
  }

  registerCommand(name: string, options: unknown): void {
    if (this.blockedCommands.has(name)) {
      throw new Error(`Command collision: ${name}`);
    }
    this.commands.set(name, options);
  }
}

describe("web extension registration", () => {
  it("registers namespaced tools and preferred slash commands", async () => {
    const pi = new FakePi();

    webAccessExtension(pi as never);

    expect(pi.tools.map((tool) => tool.name)).toEqual([
      "sf_web_search",
      "sf_web_fetch",
      "sf_web_flow",
      "sf_web_login",
      "sf_web_session",
    ]);
    expect(pi.commands.has("sf-web-search")).toBe(true);
    expect(pi.commands.has("sf-web")).toBe(true);
    await expect(pi.tools.find((tool) => tool.name === "sf_web_fetch")?.execute("call-1", {}, undefined)).resolves.toMatchObject({
      content: [{ type: "text", text: expect.stringContaining("Usage: sf_web_fetch") }],
    });
  });

  it("requires a url for sf_web_fetch in the Pi schema", () => {
    const pi = new FakePi();

    webAccessExtension(pi as never);

    const fetchSchema = pi.tools.find((tool) => tool.name === "sf_web_fetch")?.parameters as {
      properties?: Record<string, unknown>;
      required?: string[];
    };
    expect(fetchSchema.properties).toHaveProperty("url");
    expect(fetchSchema.required).toContain("url");
  });

  it("guides agents to retry missing-url fetch errors instead of narrating internal JSON failures", () => {
    const pi = new FakePi();

    webAccessExtension(pi as never);

    const guidelines = pi.tools.find((tool) => tool.name === "sf_web_fetch")?.promptGuidelines;
    expect(guidelines).toEqual([
      expect.stringContaining("retry with an exact URL already present"),
      expect.stringContaining("omit intermediate internal sf_web_fetch JSON"),
      expect.stringContaining("mode='browser'"),
    ]);
    expect(guidelines?.[0]).toContain("ask the user for the URL");
    expect(guidelines?.[1]).toContain("alternate-method");
    expect(guidelines?.[1]).toContain("unless the user asks for tool diagnostics");
  });

  it("exposes agent-friendly browser flow aliases in the Pi schema", () => {
    const pi = new FakePi();

    webAccessExtension(pi as never);

    const flowSchema = JSON.stringify(pi.tools.find((tool) => tool.name === "sf_web_flow")?.parameters);
    expect(flowSchema).toContain('"navigate"');
    expect(flowSchema).toContain('"fill"');
    expect(flowSchema).toContain('"keypress"');
  });

  it("exposes searxng-html as an explicit search provider option", () => {
    const pi = new FakePi();

    webAccessExtension(pi as never);

    const searchSchema = JSON.stringify(pi.tools.find((tool) => tool.name === "sf_web_search")?.parameters);
    expect(searchSchema).toContain('"searxng-html"');
  });

  it("falls back to /sf-search when /sf-web-search is already registered", () => {
    const pi = new FakePi(new Set(["sf-web-search"]));

    webAccessExtension(pi as never);

    expect(pi.commands.has("sf-web-search")).toBe(false);
    expect(pi.commands.has("sf-search")).toBe(true);
    expect(pi.commands.has("sf-web")).toBe(true);
  });
});
