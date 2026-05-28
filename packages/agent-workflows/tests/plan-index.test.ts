import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  lookupEntries,
  readIndex,
  upsertEntry,
} from "../src/resume/plan-index";

// Override the home dir used by plan-index in tests
const testHome = path.join(os.tmpdir(), `plan-index-test-${process.pid}-${Date.now()}`);
const indexPath = path.join(testHome, ".sf-team", "plan-index.json");

// Patch homedir for tests
let originalHome: string;
beforeEach(() => {
  originalHome = os.homedir();
  Object.defineProperty(os, "homedir", { value: () => testHome, configurable: true });
  fs.mkdirSync(path.dirname(indexPath), { recursive: true });
});

afterEach(() => {
  Object.defineProperty(os, "homedir", { value: () => originalHome, configurable: true });
  fs.rmSync(testHome, { recursive: true, force: true });
});

describe("plan-index", () => {
  it("(a) read missing file → empty index (no throw)", () => {
    const idx = readIndex();
    expect(idx).toEqual({ version: 1, entries: {} });
  });

  it("(b) write + re-read round-trip", () => {
    upsertEntry("my-slug", { planRoot: "/plans/one", tool: "sf_team_plan" });
    const idx = readIndex();
    expect(idx.entries["my-slug"]).toHaveLength(1);
    expect(idx.entries["my-slug"][0].planRoot).toBe("/plans/one");
    expect(idx.entries["my-slug"][0].lastTool).toBe("sf_team_plan");
  });

  it("(c) atomic-rename pattern is used (tmp file is cleaned up)", () => {
    upsertEntry("my-slug", { planRoot: "/plans/one", tool: "sf_team_plan" });
    const dir = path.dirname(indexPath);
    const tmpFiles = fs.readdirSync(dir).filter((f) => f.endsWith(".tmp"));
    expect(tmpFiles).toHaveLength(0);
  });

  it("(d) invalid JSON → empty index (no throw)", () => {
    fs.writeFileSync(indexPath, "not-valid-json", "utf8");
    const idx = readIndex();
    expect(idx).toEqual({ version: 1, entries: {} });
  });

  it("(e) upsertEntry updates lastSeenAt for the same planRoot", async () => {
    upsertEntry("my-slug", { planRoot: "/plans/one", tool: "sf_team_plan" });
    const before = readIndex().entries["my-slug"][0].lastSeenAt;
    await new Promise((r) => setTimeout(r, 5));
    upsertEntry("my-slug", { planRoot: "/plans/one", tool: "sf_team_task" });
    const after = readIndex().entries["my-slug"][0].lastSeenAt;
    expect(after >= before).toBe(true);
    expect(readIndex().entries["my-slug"]).toHaveLength(1);
    expect(readIndex().entries["my-slug"][0].lastTool).toBe("sf_team_task");
  });

  it("(f) two planRoots same slug → array of two entries", () => {
    upsertEntry("my-slug", { planRoot: "/plans/one", tool: "sf_team_plan" });
    upsertEntry("my-slug", { planRoot: "/plans/two", tool: "sf_team_plan" });
    const entries = readIndex().entries["my-slug"];
    expect(entries).toHaveLength(2);
    const roots = entries.map((e) => e.planRoot);
    expect(roots).toContain("/plans/one");
    expect(roots).toContain("/plans/two");
  });

  it("(g) lookupEntries returns 2 entries when both workflow.json files exist", () => {
    // Create workflow.json files so lookup doesn't filter them as stale
    const slug = "my-slug";
    const planRoot1 = path.join(testHome, "plans/one");
    const planRoot2 = path.join(testHome, "plans/two");
    const wf1 = path.join(planRoot1, slug, ".sf-workflow", "workflow.json");
    const wf2 = path.join(planRoot2, slug, ".sf-workflow", "workflow.json");
    fs.mkdirSync(path.dirname(wf1), { recursive: true });
    fs.mkdirSync(path.dirname(wf2), { recursive: true });
    fs.writeFileSync(wf1, "{}", "utf8");
    fs.writeFileSync(wf2, "{}", "utf8");
    upsertEntry(slug, { planRoot: planRoot1, tool: "sf_team_plan" });
    upsertEntry(slug, { planRoot: planRoot2, tool: "sf_team_plan" });
    const live = lookupEntries(slug);
    expect(live).toHaveLength(2);
  });

  it("(h) lookupEntries filters out stale entries (workflow.json missing)", () => {
    upsertEntry("my-slug", { planRoot: "/nonexistent/plans", tool: "sf_team_plan" });
    const live = lookupEntries("my-slug");
    expect(live).toHaveLength(0);
  });

  it("(edge) malformed entries with null slug array are sanitized", () => {
    const p = path.join(testHome, ".sf-team", "plan-index.json");
    fs.writeFileSync(p, JSON.stringify({ version: 1, entries: { "my-slug": null } }), "utf8");
    const idx = readIndex();
    expect(idx.entries["my-slug"]).toBeUndefined();
  });
});
