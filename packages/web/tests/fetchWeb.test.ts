import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { fetchWeb, renderFetchResult } from "../src/fetch";
import type { FetchText } from "../src/search/types";

let outputDir = "";

beforeEach(async () => {
  outputDir = await mkdtemp(path.join(tmpdir(), "fh-web-fetch-test-"));
});

afterEach(async () => {
  await rm(outputDir, { force: true, recursive: true });
});

function response(text: string, contentType = "text/html", status = 200): Awaited<ReturnType<FetchText>> {
  return { contentType, status, text, url: "https://example.com/final" };
}

describe("web fetch", () => {
  it("fetches HTML without a browser and extracts clean markdown", async () => {
    const result = await fetchWeb({
      fetchText: async () =>
        response(`
          <html>
            <head><title>Ignored Browser Title</title></head>
            <body>
              <nav>Navigation</nav>
              <main>
                <article>
                  <h1>Article Title</h1>
                  <p>Main content with <a href="https://example.com/link">a link</a>.</p>
                </article>
              </main>
            </body>
          </html>
        `),
      url: "https://example.com/article",
    });

    expect(result.modeUsed).toBe("fast");
    expect(result.format).toBe("markdown");
    expect(result.title).toBe("Article Title");
    expect(result.output.text).toContain("# Article Title");
    expect(result.output.text).toContain("Main content with");
    expect(result.output.text).not.toContain("Navigation");
  });

  it("supports selector extraction and text output", async () => {
    const result = await fetchWeb({
      fetchText: async () =>
        response(`
          <html><body>
            <section id="target"><h2>Selected</h2><p>Only this text.</p></section>
            <section>Ignored text.</section>
          </body></html>
        `),
      format: "text",
      selector: "#target",
      url: "https://example.com/page",
    });

    expect(result.output.text).toContain("Selected");
    expect(result.output.text).toContain("Only this text.");
    expect(result.output.text).not.toContain("Ignored text.");
  });

  it("returns structured JSON when requested", async () => {
    const result = await fetchWeb({
      fetchText: async () => response('{"ok":true}', "application/json"),
      format: "json",
      url: "https://example.com/data.json",
    });

    const parsed = JSON.parse(result.output.text) as { content: unknown; contentType: string; status: number };
    expect(parsed.status).toBe(200);
    expect(parsed.contentType).toBe("application/json");
    expect(parsed.content).toEqual({ ok: true });
  });

  it("uses a browser adapter in auto mode when fast HTML looks challenge gated", async () => {
    const result = await fetchWeb({
      browser: {
        async fetch(options) {
          return {
            contentType: "text/html",
            finalUrl: `${options.url}/browser`,
            html: "<main><h1>Rendered</h1><p>Human verified content.</p></main>",
            screenshotPath: "/tmp/rendered.png",
            status: 200,
            title: "Rendered",
          };
        },
      },
      fetchText: async () => response("<html><body>Checking your browser before accessing this site</body></html>"),
      mode: "auto",
      screenshot: true,
      url: "https://example.com/challenge",
    });

    expect(result.modeUsed).toBe("browser");
    expect(result.challengeDetected).toBe(true);
    expect(result.screenshotPath).toBe("/tmp/rendered.png");
    expect(result.output.text).toContain("Human verified content");
  });

  it("uses a browser adapter in auto mode when fast fetch is blocked by HTTP status", async () => {
    const result = await fetchWeb({
      browser: {
        async fetch(options) {
          return {
            contentType: "text/html",
            finalUrl: `${options.url}/browser`,
            html: "<main><h1>Rendered Reuters</h1><p>Browser content.</p></main>",
            status: 200,
            title: "Rendered Reuters",
          };
        },
      },
      fetchText: async () => response("Unauthorized", "text/html", 401),
      mode: "auto",
      url: "https://www.reuters.com/world/",
    });

    expect(result.modeUsed).toBe("browser");
    expect(result.status).toBe(200);
    expect(result.output.text).toContain("Browser content");
  });

  it("does not escalate missing pages to browser mode in auto mode", async () => {
    let browserCalled = false;

    await expect(
      fetchWeb({
        browser: {
          async fetch() {
            browserCalled = true;
            throw new Error("browser should not be called");
          },
        },
        fetchText: async () => response("Not Found", "text/html", 404),
        mode: "auto",
        url: "https://example.com/missing",
      }),
    ).rejects.toThrow(/HTTP 404/);

    expect(browserCalled).toBe(false);
  });

  it("escalates likely bot-block statuses to browser mode in auto mode", async () => {
    const result = await fetchWeb({
      browser: {
        async fetch(options) {
          return {
            contentType: "text/html",
            finalUrl: options.url,
            html: "<main><h1>Rendered after block</h1></main>",
            status: 200,
            title: "Rendered after block",
          };
        },
      },
      fetchText: async () => response("Forbidden", "text/html", 403),
      mode: "auto",
      url: "https://example.com/protected",
    });

    expect(result.modeUsed).toBe("browser");
    expect(result.output.text).toContain("Rendered after block");
  });

  it("still reports non-2xx fast fetch errors when no browser adapter is available", async () => {
    await expect(
      fetchWeb({
        fetchText: async () => response("Unauthorized", "text/html", 401),
        mode: "auto",
        url: "https://www.reuters.com/world/",
      }),
    ).rejects.toThrow(/HTTP 401/);
  });

  it("reports challenge detection when no browser adapter is available", async () => {
    const result = await fetchWeb({
      fetchText: async () => response("<html><body>Please enable JavaScript to continue.</body></html>"),
      mode: "auto",
      url: "https://example.com/js",
    });

    expect(result.modeUsed).toBe("fast");
    expect(result.challengeDetected).toBe(true);
    expect(renderFetchResult(result)).toContain("Challenge or JavaScript shell detected");
  });

  it("requires a browser adapter for browser mode", async () => {
    await expect(fetchWeb({ mode: "browser", url: "https://example.com" })).rejects.toThrow(/browser adapter/i);
  });

  it("writes full extracted output to a temp file when returned text is truncated", async () => {
    const result = await fetchWeb({
      configParams: {
        maxBytes: 80,
        maxLines: 3,
        outputDir,
      },
      fetchText: async () => response(`<main>${Array.from({ length: 20 }, (_, index) => `<p>line ${index}</p>`).join("")}</main>`),
      format: "markdown",
      url: "https://example.com/long",
    });

    expect(result.output.truncated).toBe(true);
    expect(result.output.fullOutputPath).toMatch(outputDir);
    expect(await readFile(result.output.fullOutputPath!, "utf8")).toContain("line 19");
  });
});
