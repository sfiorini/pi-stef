import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { seedFile, seedAgents, seedWorkflows, renderSeedReport, AGENT_FILES, WORKFLOW_FILES } from "../src/seed.js";

const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

describe("seedFile — write-once", () => {
  it("writes the template when the target is absent", async () => {
    const dir = mkdtempSync(join(tmpdir(), "seed-"));
    const r = await seedFile(join(dir, "a.md"), "TEMPLATE", "write-once");
    expect(r.status).toBe("written");
    expect(readFileSync(join(dir, "a.md"), "utf8")).toBe("TEMPLATE");
  });

  it("skips (no clobber) when the target already exists, even if it differs", async () => {
    const dir = mkdtempSync(join(tmpdir(), "seed-"));
    writeFileSync(join(dir, "a.md"), "USER");
    const r = await seedFile(join(dir, "a.md"), "TEMPLATE", "write-once");
    expect(r.status).toBe("skipped");
    expect(readFileSync(join(dir, "a.md"), "utf8")).toBe("USER");
  });

  it("propagates non-ENOENT read errors (EISDIR)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "seed-"));
    mkdirSync(join(dir, "a.md")); // directory where a file is expected
    await expect(seedFile(join(dir, "a.md"), "T", "write-once")).rejects.toThrow();
  });
});

describe("seedFile — with-new", () => {
  it("writes the template when absent", async () => {
    const dir = mkdtempSync(join(tmpdir(), "seed-"));
    const r = await seedFile(join(dir, "a.md"), "TEMPLATE", "with-new");
    expect(r.status).toBe("written");
    expect(readFileSync(join(dir, "a.md"), "utf8")).toBe("TEMPLATE");
  });

  it("reports up-to-date when the existing file matches the template", async () => {
    const dir = mkdtempSync(join(tmpdir(), "seed-"));
    writeFileSync(join(dir, "a.md"), "TEMPLATE");
    const r = await seedFile(join(dir, "a.md"), "TEMPLATE", "with-new");
    expect(r.status).toBe("up-to-date");
  });

  it("writes <name>.new (not overwriting the user file) when content differs", async () => {
    const dir = mkdtempSync(join(tmpdir(), "seed-"));
    writeFileSync(join(dir, "reviewer.md"), "USER-EDITED");
    const r = await seedFile(join(dir, "reviewer.md"), "NEW-DEFAULT", "with-new");
    expect(r.status).toBe("saved-as-new");
    expect(r.newPath).toBe(join(dir, "reviewer.md.new"));
    // user file untouched
    expect(readFileSync(join(dir, "reviewer.md"), "utf8")).toBe("USER-EDITED");
    // .new holds the latest template
    expect(readFileSync(join(dir, "reviewer.md.new"), "utf8")).toBe("NEW-DEFAULT");
  });

  it("overwrites a stale .new on re-seed so it always holds the latest template", async () => {
    const dir = mkdtempSync(join(tmpdir(), "seed-"));
    writeFileSync(join(dir, "a.md"), "USER");
    await seedFile(join(dir, "a.md"), "V1", "with-new");
    const r = await seedFile(join(dir, "a.md"), "V2", "with-new");
    expect(r.status).toBe("saved-as-new");
    expect(readFileSync(join(dir, "a.md.new"), "utf8")).toBe("V2");
  });
});

describe("seedAgents / seedWorkflows", () => {
  it("write-once: seeds all bundled agents, content matches templates", async () => {
    const dir = mkdtempSync(join(tmpdir(), "seed-"));
    const results = await seedAgents(dir, "write-once");
    expect(results.map((r) => r.file).sort()).toEqual([...AGENT_FILES].sort());
    expect(results.every((r) => r.status === "written")).toBe(true);
    for (const f of AGENT_FILES) {
      expect(readFileSync(join(dir, f), "utf8")).toBe(
        readFileSync(join(pkgRoot, "agents", f), "utf8"),
      );
    }
  });

  it("write-once is idempotent (second run all skipped)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "seed-"));
    await seedWorkflows(dir, "write-once");
    const r2 = await seedWorkflows(dir, "write-once");
    expect(r2.every((x) => x.status === "skipped")).toBe(true);
  });

  it("with-new first run writes all workflows matching templates", async () => {
    const dir = mkdtempSync(join(tmpdir(), "seed-"));
    const results = await seedWorkflows(dir, "with-new");
    expect(results.map((r) => r.file).sort()).toEqual([...WORKFLOW_FILES].sort());
    expect(results.every((r) => r.status === "written")).toBe(true);
    for (const f of WORKFLOW_FILES) {
      expect(existsSync(join(dir, f))).toBe(true);
    }
  });
});

describe("renderSeedReport", () => {
  it("summarizes counts and lists .new paths", () => {
    const out = renderSeedReport({
      agents: [
        { file: "reviewer.md", status: "saved-as-new", newPath: "/h/.pi/agent/agents/reviewer.md.new" },
        { file: "researcher.md", status: "up-to-date" },
      ],
      workflows: [{ file: "code-review.yaml", status: "written" }],
    });
    expect(out).toContain("written: 1");
    expect(out).toContain("up-to-date: 1");
    expect(out).toContain("saved-as-new: 1");
    expect(out).toContain("reviewer.md.new");
  });
});
