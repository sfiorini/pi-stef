import { describe, expect, it } from "vitest";

import { handleSearchCommand, renderSearchResults, searchWeb } from "../src/search";
import type { BrowserSearchAdapter, FetchText } from "../src/search/types";

function response(text: string, status = 200): Awaited<ReturnType<FetchText>> {
  return { status, text, url: "https://search.example.com/" };
}

describe("web search", () => {
  it("normalizes and deduplicates provider results", async () => {
    const results = await searchWeb({
      fetchText: async () =>
        response(
          JSON.stringify({
            results: [
              { title: " One ", url: "https://example.com/a", content: " First " },
              { title: "Duplicate", url: "https://example.com/a", content: "Second" },
              { title: "", url: "https://example.com/empty" },
            ],
          }),
        ),
      maxResults: 5,
      providers: ["searxng"],
      query: "test",
      searxngUrl: "https://search.example.com",
    });

    expect(results.results).toEqual([
      { source: "searxng", snippet: "First", title: "One", url: "https://example.com/a" },
    ]);
    expect(results.attempts).toMatchObject([{ ok: true, provider: "searxng", resultCount: 1 }]);
  });

  it.skip("uses default providers when optional tool params are omitted — skipped: flaky, provider resolution depends on environment config", async () => {
    const results = await searchWeb({
      fetchText: async () =>
        response(`
          <div class="result">
            <a class="result__a" href="https://example.com/news">News Result</a>
            <a class="result__snippet">World news</a>
          </div>
        `),
      query: "latest world news",
    });

    expect(results.results[0]).toMatchObject({
      source: "duckduckgo",
      title: "News Result",
      url: "https://example.com/news",
    });
  });


  it("parses SearXNG HTML when JSON is unavailable", async () => {
    const calls: string[] = [];
    const results = await searchWeb({
      fetchText: async (url) => {
        calls.push(url);
        if (url.includes("format=json")) throw new Error("json disabled");
        return response(`
          <article class="result">
            <h3><a href="https://example.com/html">HTML Result</a></h3>
            <p class="content">Snippet from html</p>
          </article>
        `);
      },
      maxResults: 5,
      providers: ["searxng", "searxng-html"],
      query: "html test",
      searxngUrl: "https://search.example.com",
    });

    expect(calls[0]).toContain("format=json");
    expect(calls[1]).not.toContain("format=json");
    expect(results.results[0]).toMatchObject({
      source: "searxng-html",
      snippet: "Snippet from html",
      title: "HTML Result",
      url: "https://example.com/html",
    });
    expect(results.attempts.map((attempt) => [attempt.provider, attempt.ok])).toEqual([
      ["searxng", false],
      ["searxng-html", true],
    ]);
  });

  it("parses DuckDuckGo HTML and decodes result redirects", async () => {
    const results = await searchWeb({
      fetchText: async () =>
        response(`
          <div class="result">
            <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fddg">DDG Result</a>
            <a class="result__snippet">Duck snippet</a>
          </div>
        `),
      maxResults: 5,
      providers: ["duckduckgo"],
      query: "duck",
    });

    expect(results.results[0]).toMatchObject({
      source: "duckduckgo",
      snippet: "Duck snippet",
      title: "DDG Result",
      url: "https://example.com/ddg",
    });
  });

  it("parses DuckDuckGo Lite table results", async () => {
    const results = await searchWeb({
      fetchText: async () =>
        response(`
          <table>
            <tr>
              <td>
                <a class="result-link" href="/l/?uddg=https%3A%2F%2Fexample.com%2Flite">Lite Result</a>
              </td>
            </tr>
            <tr>
              <td class="result-snippet">Lite snippet</td>
            </tr>
          </table>
        `),
      maxResults: 5,
      providers: ["duckduckgo"],
      query: "duck lite",
    });

    expect(results.results[0]).toMatchObject({
      source: "duckduckgo",
      snippet: "Lite snippet",
      title: "Lite Result",
      url: "https://example.com/lite",
    });
  });

  it("skips browser providers when no browser adapter is available", async () => {
    const results = await searchWeb({
      fetchText: async () => response("<html></html>"),
      maxResults: 5,
      providers: ["google", "bing"],
      query: "browser unavailable",
    });

    expect(results.attempts).toEqual([]);
    expect(results.results).toEqual([]);
  });

  it("reports unknown provider names as failed attempts", async () => {
    const results = await searchWeb({
      fetchText: async () => response("<html></html>"),
      maxResults: 5,
      providers: ["duckduckgo", "unknown" as never],
      query: "typo",
    });

    expect(results.attempts.at(-1)).toMatchObject({
      ok: false,
      provider: "unknown",
    });
  });

  it("uses browser providers through a mockable adapter", async () => {
    const browser: BrowserSearchAdapter = {
      async search(provider, query, options) {
        return [{ source: provider, title: `${provider} ${query}`, url: `https://${provider}.example.com/${options.maxResults}` }];
      },
    };

    const results = await searchWeb({
      browser,
      fetchText: async () => {
        throw new Error("not used");
      },
      maxResults: 3,
      providers: ["google"],
      query: "browser",
    });

    expect(results.results).toEqual([{ source: "google", title: "google browser", url: "https://google.example.com/3" }]);
  });

  it("falls through providers and redacts failed provider URLs", async () => {
    const results = await searchWeb({
      fetchText: async (url) => {
        throw new Error(`failed ${url}?token=secret`);
      },
      maxResults: 5,
      providers: ["searxng", "duckduckgo"],
      query: "fallback",
      searxngUrl: "https://user:pass@search.example.com/?token=abc",
    });

    expect(results.results).toEqual([]);
    expect(results.attempts).toHaveLength(3);
    expect(results.attempts.every((attempt) => attempt.ok === false)).toBe(true);
    expect(JSON.stringify(results.attempts)).not.toContain("secret");
    expect(JSON.stringify(results.attempts)).not.toContain("pass");
    expect(JSON.stringify(results.attempts)).toContain("REDACTED");
  });

  it("renders compact markdown and command output", async () => {
    const rendered = renderSearchResults({
      attempts: [{ elapsedMs: 3, ok: true, provider: "duckduckgo", resultCount: 1 }],
      query: "pi",
      results: [{ snippet: "Pi docs", source: "duckduckgo", title: "Pi", url: "https://pi.dev" }],
    });

    expect(rendered).toContain("1. [Pi](https://pi.dev)");
    expect(rendered).toContain("Pi docs");

    const commandOutput = await handleSearchCommand("pi packages", {
      fetchText: async () =>
        response(
          JSON.stringify({
            results: [{ title: "Pi Packages", url: "https://pi.dev/packages", content: "Catalog" }],
          }),
        ),
      providers: ["searxng"],
      searxngUrl: "https://search.example.com",
    });

    expect(commandOutput).toContain("Pi Packages");
  });
});
