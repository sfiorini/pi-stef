import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import webAccessExtension from "../extensions/web-access";

const maybeDescribe = process.env.SF_WEB_RUN_BROWSER_TESTS === "1" ? describe : describe.skip;

class FakePi {
  commands = new Map<string, unknown>();
  tools: Array<{ name: string; execute: (...args: any[]) => Promise<any> }> = [];

  registerTool(tool: { name: string; execute: (...args: any[]) => Promise<any> }): void {
    this.tools.push(tool);
  }

  registerCommand(name: string, options: unknown): void {
    this.commands.set(name, options);
  }
}

maybeDescribe("web-access registered tools e2e", () => {
  let baseUrl = "";
  let closeServer: (() => Promise<void>) | undefined;
  let tmp = "";
  let previousEnv: Record<string, string | undefined> = {};

  beforeAll(async () => {
    previousEnv = {
      SF_WEB_CONFIG: process.env.SF_WEB_CONFIG,
      SF_WEB_PASSWORD: process.env.SF_WEB_PASSWORD,
      SF_WEB_USERNAME: process.env.SF_WEB_USERNAME,
    };
    tmp = await mkdtemp(path.join(tmpdir(), "fh-web-tools-e2e-"));
    const server = createServer(handleRequest);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    closeServer = () => new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    const address = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;

    const configPath = path.join(tmp, "config.json");
    await writeFile(
      configPath,
      `${JSON.stringify(
        {
          allowPrivateNetworks: true,
          fetchTimeoutMs: 20_000,
          outputDir: path.join(tmp, "output"),
          profilesDir: path.join(tmp, "profiles"),
          searchProviders: ["searxng", "duckduckgo", "google", "bing"],
        },
        null,
        2,
      )}\n`,
    );
    process.env.SF_WEB_CONFIG = configPath;
    process.env.SF_WEB_USERNAME = "tool-user@example.com";
    process.env.SF_WEB_PASSWORD = "tool-password";
  }, 60_000);

  afterAll(async () => {
    process.env.SF_WEB_CONFIG = previousEnv.SF_WEB_CONFIG;
    process.env.SF_WEB_USERNAME = previousEnv.SF_WEB_USERNAME;
    process.env.SF_WEB_PASSWORD = previousEnv.SF_WEB_PASSWORD;
    await closeServer?.();
    await rm(tmp, { force: true, recursive: true });
  });

  it("executes every registered Pi tool through the extension boundary", async () => {
    const pi = new FakePi();
    webAccessExtension(pi as never);

    const searchOutput = await executeText(pi, "web_search", {
      maxResults: 2,
      query: "espresso machines",
      searxngUrl: baseUrl,
    });
    expect(searchOutput).toContain("Local Espresso Result");
    expect(searchOutput).toContain(`${baseUrl}/article`);

    const fetchOutput = await executeText(pi, "web_fetch", {
      mode: "browser",
      profile: "fetch-profile",
      screenshot: true,
      url: `${baseUrl}/article`,
    });
    expect(fetchOutput).toContain("Local Article");
    expect(fetchOutput).toContain("Screenshot:");
    const screenshotPath = fetchOutput.match(/Screenshot: (.+)/)?.[1]?.trim();
    expect(screenshotPath).toBeTruthy();
    await expect(stat(screenshotPath!)).resolves.toMatchObject({ size: expect.any(Number) });

    const flowOutput = await executeText(pi, "web_flow", {
      headless: true,
      profile: "flow-profile",
      steps: [
        { action: "navigate", url: `${baseUrl}/flow,` },
        { action: "fill", selector: "input[name='q']", text: "espresso machines" },
        { action: "keypress", key: "enter" },
        { action: "wait", ms: 250 },
        { action: "extract", count: 1, selector: ".result" },
      ],
    });
    const flowResult = JSON.parse(flowOutput) as { extracted: Array<{ values: string[] }>; finalUrl: string };
    expect(flowResult.finalUrl).toContain("/flow-results");
    expect(flowResult.extracted[0]?.values[0]).toContain("espresso machines");

    const loginOutput = await executeText(pi, "web_login", {
      headless: true,
      profile: "login-profile",
      url: `${baseUrl}/login`,
    });
    expect(loginOutput).toContain('"success": true');

    const listOutput = await executeText(pi, "web_session", { action: "list" });
    expect(listOutput).toContain("login-profile");
    expect(listOutput).toContain(`${baseUrl}/login`);

    const inspectOutput = await executeText(pi, "web_session", { action: "inspect", profile: "login-profile" });
    expect(inspectOutput).toContain('"name": "login-profile"');

    const locateOutput = await executeText(pi, "web_session", { action: "locate", profile: "login-profile" });
    expect(await readFile(path.join(locateOutput.trim(), "sf-session.json"), "utf8")).toContain(`${baseUrl}/login`);

    const clearOutput = await executeText(pi, "web_session", { action: "clear", profile: "login-profile", yes: true });
    expect(clearOutput).toContain("Session login-profile removed");
  }, 120_000);
});

async function executeText(pi: FakePi, name: string, params: Record<string, unknown>): Promise<string> {
  const tool = pi.tools.find((candidate) => candidate.name === name);
  expect(tool, `missing tool ${name}`).toBeTruthy();
  const result = await tool!.execute(`${name}-call`, params, undefined);
  return result.content[0].text;
}

async function handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const url = new URL(request.url ?? "/", `http://${request.headers.host}`);
  if (url.pathname === "/search") {
    sendJson(response, {
      results: [
        {
          content: "Local SearXNG-style result for espresso machines.",
          title: "Local Espresso Result",
          url: `${url.origin}/article`,
        },
      ],
    });
    return;
  }
  if (url.pathname === "/article") {
    sendHtml(
      response,
      `<html><head><title>Local Article</title></head><body><main><h1>Local Article</h1><p>Rendered browser content for espresso machines.</p></main></body></html>`,
    );
    return;
  }
  if (url.pathname === "/flow") {
    sendHtml(
      response,
      `<html><head><title>Local Flow</title></head><body><form action="/flow-results" method="get"><input name="q" aria-label="Search"><button type="submit">Search</button></form></body></html>`,
    );
    return;
  }
  if (url.pathname === "/flow-results") {
    sendHtml(
      response,
      `<html><head><title>Flow Results</title></head><body><main><div class="result">Search result for ${escapeHtml(url.searchParams.get("q") ?? "")}</div></main></body></html>`,
    );
    return;
  }
  if (url.pathname === "/login" && request.method === "POST") {
    await readBody(request);
    sendHtml(response, `<html><head><title>Logged In</title></head><body><main><h1>Logged in</h1></main></body></html>`);
    return;
  }
  if (url.pathname === "/login") {
    sendHtml(
      response,
      `<html><head><title>Login</title></head><body><form action="/login" method="post"><input type="email" name="email"><input type="password" name="password"><button type="submit">Login</button></form></body></html>`,
    );
    return;
  }
  response.writeHead(404, { "content-type": "text/plain" });
  response.end("not found");
}

function sendHtml(response: ServerResponse, html: string): void {
  response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  response.end(html);
}

function sendJson(response: ServerResponse, data: unknown): void {
  response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(data));
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => {
    if (char === "&") return "&amp;";
    if (char === "<") return "&lt;";
    if (char === ">") return "&gt;";
    if (char === '"') return "&quot;";
    return "&#39;";
  });
}
