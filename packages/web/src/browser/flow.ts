import type { BrowserRuntime } from "./runtime";

export type FlowStep =
  | { action: "click"; name?: string; role?: string; selector?: string; text?: string }
  | { action: "extract"; count?: number; selector: string }
  | { action: "goto"; url: string }
  | { action: "press"; key: string; selector?: string }
  | { action: "screenshot"; path: string }
  | { action: "type"; selector?: string; text: string }
  | { action: "wait"; ms: number };

export type FlowStepInput =
  | FlowStep
  | { action: "fill"; selector?: string; text: string }
  | { action: "key"; key: string; selector?: string }
  | { action: "keypress"; key: string; selector?: string }
  | { action: "navigate"; url: string }
  | { action: "open"; url: string };

export interface FlowResult {
  extracted: Array<{ selector: string; values: string[] }>;
  finalUrl: string;
  pageText: string;
  screenshots: string[];
  stepsRun: number;
  title: string;
}

export interface RunWebFlowOptions {
  guardNavigation?: (url: string) => Promise<string> | string;
  runtime: BrowserRuntime;
  signal?: AbortSignal;
  steps: FlowStepInput[];
}

export function parseFlowSteps(instruction: string): FlowStep[] {
  const searchSteps = parseSiteSearchInstruction(instruction);
  if (searchSteps) return searchSteps;

  return instruction
    .split(/\band\s+then\b|\bthen\b|;/gi)
    .map((part) => part.trim())
    .filter(Boolean)
    .map(parseFlowStep);
}

export function normalizeFlowSteps(steps: FlowStepInput[]): FlowStep[] {
  return steps.map(normalizeFlowStep);
}

export async function runWebFlow(options: RunWebFlowOptions): Promise<FlowResult> {
  const page = await options.runtime.newPage();
  const screenshots: string[] = [];
  const extracted: FlowResult["extracted"] = [];
  const steps = normalizeFlowSteps(options.steps);
  let abort: (() => void) | undefined;

  try {
    if (options.signal?.aborted) {
      throw new Error("Browser flow aborted");
    }
    abort = () => {
      void options.runtime.close();
    };
    options.signal?.addEventListener("abort", abort, { once: true });
    for (const step of steps) {
      if (options.signal?.aborted) {
        throw new Error("Browser flow aborted");
      }
      if (step.action === "goto") {
        await page.goto(await guardNavigation(step.url, options.guardNavigation));
      } else if (step.action === "click") {
        if (step.selector) await page.click(step.selector);
        else if (step.role && step.name) await page.roleClick(step.role, step.name);
        else if (step.text) await page.roleClick("button", step.text);
        else throw new Error("click step requires selector, role/name, or text");
      } else if (step.action === "type") {
        await page.fill(step.selector ?? defaultInputSelector(), step.text);
      } else if (step.action === "press") {
        await page.press(step.selector, normalizeKey(step.key));
      } else if (step.action === "wait") {
        await page.wait(step.ms);
      } else if (step.action === "screenshot") {
        await page.screenshot(step.path);
        screenshots.push(step.path);
      } else if (step.action === "extract") {
        const values = (await page.selectorTexts(step.selector)).map((value) => value.trim()).filter(Boolean);
        extracted.push({ selector: step.selector, values: values.slice(0, step.count ?? values.length) });
      } else {
        throw new Error(`Unsupported flow action: ${(step as { action?: string }).action ?? "unknown"}`);
      }
    }

    const pageText = (await page.text()).trim();
    return {
      extracted,
      finalUrl: page.url(),
      pageText,
      screenshots,
      stepsRun: steps.length,
      title: await page.title(),
    };
  } finally {
    if (abort) options.signal?.removeEventListener("abort", abort);
    await options.runtime.close();
  }
}

async function guardNavigation(url: string, guard: RunWebFlowOptions["guardNavigation"]): Promise<string> {
  return guard ? guard(url) : url;
}

function parseFlowStep(part: string): FlowStep {
  const goto = part.match(/^(?:go to|open|navigate to)\s+(\S+)\s*$/i);
  if (goto) return { action: "goto", url: normalizeNavigationUrl(goto[1]) };

  const clickRole = part.match(/^click\s+(button|link|textbox|img|image|tab)\s+"([^"]+)"$/i);
  if (clickRole) {
    return { action: "click", role: clickRole[1].toLowerCase() === "image" ? "img" : clickRole[1].toLowerCase(), name: clickRole[2] };
  }
  const clickText = part.match(/^click(?: on)?\s+"([^"]+)"/i);
  if (clickText) return { action: "click", text: clickText[1] };
  const clickSelector = part.match(/^click(?: on)?\s+(#[\w-]+|\.[\w-]+|[a-z]+\[[^\]]+\])/i);
  if (clickSelector) return { action: "click", selector: clickSelector[1] };

  const typeInto = part.match(/^type\s+"([^"]+)"\s+in\s+(.+)$/i);
  if (typeInto) return { action: "type", text: typeInto[1], selector: typeInto[2].trim() };
  const typeOnly = part.match(/^type\s+"([^"]+)"$/i);
  if (typeOnly) return { action: "type", text: typeOnly[1] };

  const pressIn = part.match(/^press\s+(\w+)\s+in\s+(.+)$/i);
  if (pressIn) return { action: "press", key: normalizeKey(pressIn[1]), selector: pressIn[2].trim() };
  const pressOnly = part.match(/^press\s+(\w+)$/i);
  if (pressOnly) return { action: "press", key: normalizeKey(pressOnly[1]) };

  const waitS = part.match(/^wait\s+(\d+)\s*s(?:ec(?:onds?)?)?$/i);
  if (waitS) return { action: "wait", ms: Number.parseInt(waitS[1], 10) * 1000 };
  const waitMs = part.match(/^wait\s+(\d+)\s*ms$/i);
  if (waitMs) return { action: "wait", ms: Number.parseInt(waitMs[1], 10) };

  const shot = part.match(/^screenshot(?: to)?\s+(.+)$/i);
  if (shot) return { action: "screenshot", path: shot[1].trim() };

  throw new Error(`Could not parse flow step: "${part}"`);
}

function normalizeNavigationUrl(rawUrl: string): string {
  const cleaned = cleanNavigationUrl(rawUrl);
  const parsed = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(cleaned) ? cleaned : `https://${cleaned}`);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`Only http and https URLs are allowed in flow steps: ${rawUrl}`);
  }
  return parsed.toString();
}

function normalizeFlowStep(step: FlowStepInput): FlowStep {
  if (step.action === "goto" || step.action === "navigate" || step.action === "open") {
    return { action: "goto", url: normalizeNavigationUrl(step.url) };
  }
  if (step.action === "type" || step.action === "fill") {
    return { action: "type", selector: step.selector, text: step.text };
  }
  if (step.action === "press" || step.action === "keypress" || step.action === "key") {
    return { action: "press", key: normalizeKey(step.key), selector: step.selector };
  }
  return step;
}

function parseSiteSearchInstruction(instruction: string): FlowStep[] | undefined {
  const match = instruction
    .trim()
    .match(/^(?:go to|open|navigate to)\s+(\S+)\s+and\s+search(?:\s+for)?\s+(.+?)\.?$/i);
  if (!match) return undefined;

  return [
    { action: "goto", url: normalizeNavigationUrl(match[1]) },
    { action: "type", text: cleanSearchText(match[2]) },
    { action: "press", key: "Enter" },
    { action: "wait", ms: 2000 },
    { action: "extract", selector: "body" },
  ];
}

function cleanNavigationUrl(rawUrl: string): string {
  return rawUrl.trim().replace(/^["'(<]+|[>"')\],.;:]+$/g, "");
}

function cleanSearchText(value: string): string {
  return value.trim().replace(/^["']+|["'.]+$/g, "");
}

function normalizeKey(key: string): string {
  const lower = key.toLowerCase();
  if (lower === "enter" || lower === "return") return "Enter";
  if (lower === "esc" || lower === "escape") return "Escape";
  if (lower === "tab") return "Tab";
  return key || "Enter";
}

function defaultInputSelector(): string {
  return 'input[name="q"], input[type="search"], input[type="text"], textarea';
}
