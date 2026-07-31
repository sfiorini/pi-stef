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
  const slugs = await page.evaluate(() => {
    const seen = new Set<string>();
    for (const a of Array.from(document.querySelectorAll<HTMLAnchorElement>('a[href^="/docs/models/"]'))) {
      const m = a.href.match(/\/docs\/models\/([^/?#]+)/);
      if (m && m[1]) seen.add(m[1]);
    }
    return [...seen];
  });
  return slugs;
}

async function scrapeModelDetail(
  page: Page,
  slug: string,
): Promise<{ modelId: string; contextWindow?: number; maxContext?: number } | null> {
  await page.goto(`https://cursor.com/docs/models/${slug}`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2500);

  // page.evaluate returns RAW strings. The DOM-only helpers (collectLeafTexts,
  // findValue, isLabel) are inlined here because they use document/TreeWalker.
  // parseContextText is NOT called here — it runs OUTSIDE evaluate (Node) so the
  // top-level import is used (single source of truth for parsing; no TS6133).
  const raw = await page.evaluate(() => {
    const LABEL_RE: RegExp[] = [/^model\s+id$/i, /^context\s+window$/i, /^max(?:imum)?\s+context$/i];
    const isLabel = (t: string): boolean => LABEL_RE.some((re) => re.test(t.trim()));
    function collectLeafTexts(root: Element): string[] {
      const out: string[] = [];
      const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      let n: Node | null;
      while ((n = w.nextNode())) {
        const t = (n.textContent ?? "").trim();
        if (t) out.push(t);
      }
      return out;
    }
    function findValue(leaves: string[], labelRe: RegExp): string | undefined {
      for (let i = 0; i < leaves.length; i++) {
        if (labelRe.test(leaves[i]!.trim())) {
          const nxt = leaves[i + 1];
          // ambiguity guard: if the next leaf is itself a label, the value is absent
          if (nxt === undefined || isLabel(nxt)) return undefined;
          return nxt;
        }
      }
      return undefined;
    }
    const root = document.querySelector("main") ?? document.body;
    if (!root) return null;
    const leaves = collectLeafTexts(root);
    const modelIdRaw = findValue(leaves, /^model\s+id$/i);
    if (!modelIdRaw) return null;
    return {
      modelId: modelIdRaw.trim(),
      contextWindowRaw: findValue(leaves, /^context\s+window$/i),
      maxContextRaw: findValue(leaves, /^max(?:imum)?\s+context$/i),
    };
  });

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
