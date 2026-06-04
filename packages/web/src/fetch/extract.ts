import { Readability } from "@mozilla/readability";
import { JSDOM } from "jsdom";
import TurndownService from "turndown";

const turndown = new TurndownService({
  bulletListMarker: "-",
  codeBlockStyle: "fenced",
  emDelimiter: "*",
  headingStyle: "atx",
  linkStyle: "inlined",
  strongDelimiter: "**",
});
turndown.remove(["script", "style", "noscript"]);
import { Defuddle } from "defuddle/node";

import type { ExtractedContent } from "./types";

const CHALLENGE_PATTERNS = [
  /checking your browser/i,
  /just a moment/i,
  /verify you are human/i,
  /press and hold/i,
  /enable javascript/i,
  /enable JavaScript/i,
  /captcha/i,
];

const BOILERPLATE_SELECTORS = [
  "script",
  "style",
  "noscript",
  "iframe",
  "nav",
  "header",
  "footer",
  "aside",
  ".cookie-banner",
  ".advertisement",
  ".ads",
  "#ads",
  ".social-share",
  ".comments",
  "#comments",
  ".sidebar",
];

export async function extractHtmlContent(options: {
  html: string;
  selector?: string;
  url: string;
}): Promise<ExtractedContent> {
  const dom = new JSDOM(options.html, { url: options.url });
  const document = dom.window.document;
  const challengeDetected = detectChallengeContent(document);

  if (options.selector) {
    const element = document.querySelector(options.selector);
    if (!element) {
      throw new Error(`Selector not found: ${options.selector}`);
    }
    return contentFromHtml(element.outerHTML, options.url, {
      challengeDetected,
      extractor: "selector",
      title: titleFromDocument(document),
    });
  }

  const titleHint = titleFromDocument(document);
  const defuddle = await tryDefuddle(options.html, options.url, challengeDetected, titleHint);
  if (defuddle) {
    return defuddle;
  }

  const readability = tryReadability(options.html, options.url, challengeDetected);
  if (readability) {
    return readability;
  }

  cleanupDocument(document);
  return contentFromHtml(document.body?.innerHTML ?? options.html, options.url, {
    challengeDetected,
    extractor: "dom",
    title: titleHint,
  });
}

export function detectChallengeText(value: string): boolean {
  return CHALLENGE_PATTERNS.some((pattern) => pattern.test(value));
}

function detectChallengeContent(document: Document): boolean {
  const text = document.body?.textContent ?? "";
  return (
    detectChallengeText(text) ||
    document.querySelector('iframe[src*="challenge"], iframe[src*="cloudflare"], [id*="captcha"], [class*="captcha"]') !== null ||
    looksLikeJavascriptShell(document)
  );
}

function looksLikeJavascriptShell(document: Document): boolean {
  const bodyText = (document.body?.textContent ?? "").replace(/\s+/g, " ").trim();
  return bodyText.length < 120 && document.scripts.length > 0 && document.querySelector("main, article") === null;
}

async function tryDefuddle(
  html: string,
  url: string,
  challengeDetected: boolean,
  titleHint: string | undefined,
): Promise<ExtractedContent | undefined> {
  try {
    const parsed = await Defuddle(html, url, {
      markdown: true,
      removeImages: true,
      separateMarkdown: true,
      useAsync: false,
    });
    if (!parsed.content && !parsed.contentMarkdown) {
      return undefined;
    }
    const content = contentFromHtml(parsed.content || html, url, {
      challengeDetected,
      extractor: parsed.extractorType ? `defuddle:${parsed.extractorType}` : "defuddle",
      markdown: parsed.contentMarkdown,
      title: titleHint ?? parsed.title ?? undefined,
    });
    return content;
  } catch {
    return undefined;
  }
}

function tryReadability(html: string, url: string, challengeDetected: boolean): ExtractedContent | undefined {
  try {
    const dom = new JSDOM(html, { url });
    const article = new Readability(dom.window.document).parse();
    if (!article?.content && !article?.textContent) {
      return undefined;
    }
    return contentFromHtml(article.content ?? article.textContent ?? html, url, {
      challengeDetected,
      extractor: "readability",
      title: article.title ?? undefined,
    });
  } catch {
    return undefined;
  }
}

function contentFromHtml(
  html: string,
  url: string,
  options: { challengeDetected: boolean; extractor: string; markdown?: string; title?: string },
): ExtractedContent {
  const dom = new JSDOM(html, { url });
  const document = dom.window.document;
  cleanupDocument(document);
  const contentHtml = document.body?.innerHTML || document.documentElement.innerHTML || html;
  const markdown = options.markdown?.trim() || htmlToMarkdown(contentHtml);
  return {
    challengeDetected: options.challengeDetected,
    extractor: options.extractor,
    html: contentHtml,
    markdown: ensureMarkdownTitle(markdown, options.title ?? titleFromDocument(document)),
    text: textFromHtml(contentHtml, url),
    title: options.title ?? titleFromDocument(document),
  };
}

function htmlToMarkdown(html: string): string {
  return turndown.turndown(html).replace(/\n{4,}/g, "\n\n\n").trim();
}

function textFromHtml(html: string, url: string): string {
  const dom = new JSDOM(html, { url });
  return (dom.window.document.body?.textContent ?? dom.window.document.documentElement.textContent ?? "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function cleanupDocument(document: Document): void {
  for (const selector of BOILERPLATE_SELECTORS) {
    document.querySelectorAll(selector).forEach((node) => node.remove());
  }
}

function ensureMarkdownTitle(markdown: string, title: string | undefined): string {
  const cleanTitle = title?.trim();
  if (!cleanTitle || markdown.startsWith("# ")) {
    return markdown;
  }
  return `# ${cleanTitle}\n\n${markdown}`.trim();
}

function titleFromDocument(document: Document): string | undefined {
  const title = document.querySelector("main h1, article h1, h1")?.textContent ?? document.title;
  return title.replace(/\s+/g, " ").trim() || undefined;
}
