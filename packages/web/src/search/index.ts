import { fetchGuardedText } from "../fetch/httpFetch";
import { loadWebAccessConfig } from "../config";
import type { WebAccessConfig, WebSearchProviderName } from "../types";
import { runProvider } from "./providers";
import type { BrowserSearchAdapter, FetchText, WebSearchResponse, WebSearchResult } from "./types";

export interface SearchWebOptions {
  browser?: BrowserSearchAdapter;
  config?: WebAccessConfig;
  fetchText?: FetchText;
  maxResults?: number;
  providers?: WebSearchProviderName[];
  query: string;
  searxngUrl?: string;
  signal?: AbortSignal;
}

export async function searchWeb(options: SearchWebOptions): Promise<WebSearchResponse> {
  const config =
    options.config ??
    (await loadWebAccessConfig({
      maxResults: options.maxResults,
      searchProviders: options.providers,
      searxngUrl: options.searxngUrl,
    }));
  const providers = providerPlan(config.searchProviders, config.searxngUrl, Boolean(options.browser));
  const attempts = [];
  const fetchText = options.fetchText ?? ((url, fetchOptions) => fetchGuardedText(url, { config, signal: fetchOptions?.signal }));

  for (const provider of providers) {
    const { attempt, results } = await runProvider(provider, {
      browser: options.browser,
      fetchText,
      maxResults: config.maxResults,
      query: options.query,
      searxngUrl: config.searxngUrl,
      signal: options.signal,
    });
    attempts.push(attempt);
    if (results.length > 0) {
      return { attempts, query: options.query, results };
    }
  }

  return { attempts, query: options.query, results: [] };
}

export function renderSearchResults(response: WebSearchResponse): string {
  const lines = [`# Search results for "${response.query}"`, ""];
  if (response.results.length === 0) {
    lines.push("No results found.");
  } else {
    response.results.forEach((result, index) => {
      lines.push(`${index + 1}. [${result.title}](${result.url})${result.source ? ` (${result.source})` : ""}`);
      if (result.snippet) {
        lines.push(`   ${result.snippet}`);
      }
    });
  }
  lines.push("", "Provider attempts:");
  for (const attempt of response.attempts) {
    const status = attempt.ok ? `ok, ${attempt.resultCount ?? 0} results` : `failed: ${attempt.error ?? "unknown error"}`;
    lines.push(`- ${attempt.provider}: ${status} (${attempt.elapsedMs}ms)`);
  }
  return lines.join("\n");
}

export async function handleSearchCommand(
  input: string,
  options: Omit<SearchWebOptions, "query"> = {},
): Promise<string> {
  const query = input.trim();
  if (!query) {
    return "Usage: sf_web_search { query: string }";
  }
  return renderSearchResults(await searchWeb({ ...options, query }));
}

function providerPlan(providers: string[], searxngUrl?: string, hasBrowser = false): string[] {
  const result: string[] = [];
  for (const provider of providers) {
    if (provider === "searxng" && searxngUrl) {
      pushUnique(result, "searxng");
      pushUnique(result, "searxng-html");
      continue;
    }
    if (provider === "searxng-html" && !searxngUrl) {
      continue;
    }
    if ((provider === "google" || provider === "bing") && !hasBrowser) {
      continue;
    }
    if (provider !== "searxng") {
      pushUnique(result, provider);
    }
  }
  return result;
}

function pushUnique(values: string[], value: string): void {
  if (!values.includes(value)) {
    values.push(value);
  }
}

export type { BrowserSearchAdapter, FetchText, WebSearchResponse, WebSearchResult };
