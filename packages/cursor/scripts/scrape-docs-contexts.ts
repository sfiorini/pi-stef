#!/usr/bin/env tsx
/**
 * Scrape model context windows from cursor.com/docs/models.
 *
 * Manual — not run in CI. Requires playwright-core + a chromium browser
 * (`npx playwright install chromium`, or set PI_CURSOR_SCRAPE_CHANNEL=chrome).
 * Called by refresh-models.ts.
 */
import { chromium } from "playwright-core";
import type { Browser, Page } from "playwright-core";
import { parseContextText } from "../src/model-config.js";

export interface ScrapedModelContext {
  /** Canonical API model ID from the "Model ID" spec row (NOT the URL slug). */
  modelId: string;
  /** Parsed from "Context window" row, in tokens. */
  contextWindow?: number;
  /** Parsed from "Max context" row, in tokens. */
  maxContext?: number;
  /** The docs URL slug used to reach this detail page. */
  slug: string;
}

const INDEX_URL = "https://cursor.com/docs/models-and-pricing";

async function discoverSlugs(page: Page): Promise<string[]> {
  await page.goto(INDEX_URL, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(3000);
  // The rendered page links only ~10 featured models; the full ~45 live in the
  // page's RSC payload (Next.js __next_f manifest of /docs/models/* paths) inside
  // the raw HTML's inline <script> chunks. Regex the full HTML to catch them all
  // (tolerates JSON-escaped slashes \/). Runs in Node — no in-browser helper, so
  // esbuild's __name injection is a non-issue here.
  const html = await page.content();
  const seen = new Set<string>();
  for (const m of html.matchAll(/\\?\/docs\\?\/models\\?\/([a-z0-9][a-z0-9-]+)/g)) {
    seen.add(m[1]!);
  }
  return [...seen];
}

async function scrapeModelDetail(
  page: Page,
  slug: string,
): Promise<{ modelId: string; contextWindow?: number; maxContext?: number } | null> {
  await page.goto(`https://cursor.com/docs/models/${slug}`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2500);

  // page.evaluate returns RAW strings; parseContextText runs OUTSIDE in Node
  // (single source of truth; the top-level import is used → no TS6133).
  //
  // IMPORTANT: the evaluate body is passed as a STRING (an IIFE), not a function.
  // tsx/esbuild injects a `__name(...)` helper around named function declarations
  // to preserve names — but `__name` is undefined in the browser context, so a
  // function-typed evaluate with inner named helpers throws ReferenceError.
  // A string is not transpiled, so the browser sees plain JS. Regex escapes are
  // doubled (\\s) because they live inside a template-literal string.
  const raw = await page.evaluate(`(function () {
    var LABEL_RE = [/^model\\s+id$/i, /^context\\s+window$/i, /^max(?:imum)?\\s+context$/i];
    function isLabel(t) { return LABEL_RE.some(function (re) { return re.test(t.trim()); }); }
    function collectLeafTexts(root) {
      var out = [];
      var w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      var n;
      while ((n = w.nextNode())) { var t = (n.textContent || "").trim(); if (t) out.push(t); }
      return out;
    }
    function findValue(leaves, labelRe) {
      for (var i = 0; i < leaves.length; i++) {
        if (labelRe.test(leaves[i].trim())) {
          var nxt = leaves[i + 1];
          if (nxt === undefined || isLabel(nxt)) return undefined;
          return nxt;
        }
      }
      return undefined;
    }
    var root = document.querySelector("main") || document.body;
    if (!root) return null;
    var leaves = collectLeafTexts(root);
    var modelIdRaw = findValue(leaves, /^model\\s+id$/i);
    if (!modelIdRaw) return null;
    return {
      modelId: modelIdRaw.trim(),
      contextWindowRaw: findValue(leaves, /^context\\s+window$/i),
      maxContextRaw: findValue(leaves, /^max(?:imum)?\\s+context$/i)
    };
  })()`) as { modelId: string; contextWindowRaw?: string; maxContextRaw?: string } | null;

  if (!raw) return null;

  // OUTSIDE evaluate: parse raw strings → numbers using the imported helper.
  const contextWindow = parseContextText(raw.contextWindowRaw);
  const maxContext = parseContextText(raw.maxContextRaw);
  if (contextWindow === undefined && maxContext === undefined) return null;
  return { modelId: raw.modelId, contextWindow, maxContext };
}

export async function scrapeCursorModelContexts(): Promise<ScrapedModelContext[]> {
  const launchOpts: Parameters<typeof chromium.launch>[0] = { headless: true };
  if (process.env.PI_CURSOR_SCRAPE_CHANNEL) {
    (launchOpts as { channel?: string }).channel = process.env.PI_CURSOR_SCRAPE_CHANNEL;
  }
  const browser: Browser = await chromium.launch(launchOpts);
  const results: ScrapedModelContext[] = [];
  try {
    const page = await browser.newPage();
    const slugs = await discoverSlugs(page);
    if (slugs.length === 0) {
      console.warn("[scrape] no model slugs found on index page");
      return [];
    }
    for (const slug of slugs) {
      try {
        const detail = await scrapeModelDetail(page, slug);
        if (detail) {
          results.push({ ...detail, slug });
          console.error(`[scrape] ${detail.modelId} → cw=${detail.contextWindow ?? "-"} max=${detail.maxContext ?? "-"}`);
        } else {
          console.error(`[scrape] ${slug} → skipped (no data)`);
        }
      } catch (err: unknown) {
        // per-slug failure is non-fatal — skip and continue
        console.error(`[scrape] ${slug} → FAILED: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  } finally {
    await browser.close();
  }
  // F5 smoke: warn if suspiciously few entries (docs DOM may have changed)
  if (results.length < 10) {
    console.warn(`[scrape] WARNING: only ${results.length} entries collected — cursor.com/docs DOM may have changed.`);
  }
  return results;
}
