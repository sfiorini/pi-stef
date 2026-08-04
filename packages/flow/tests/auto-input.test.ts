import { describe, it, expect } from "vitest";
import { classifyInput, resolveJiraRef, slugSourceFor } from "../src/auto/input.js";

describe("auto input", () => {
  it("classifies a prompt", () => {
    expect(classifyInput("add oauth")).toEqual({ kind: "prompt", value: "add oauth" });
  });
  it("classifies a markdown file", () => {
    expect(classifyInput("./PRD.md")).toEqual({ kind: "md-file", value: "./PRD.md" });
  });
  it("classifies a jira ref", () => {
    expect(classifyInput("jira PROJ-123")).toEqual({ kind: "jira", value: "PROJ-123" });
  });
  it("classifies a prd", () => {
    expect(classifyInput("prd:docs/spec")).toEqual({ kind: "prd", value: "docs/spec" });
  });
  it("resolveJiraRef extracts the id", () => {
    expect(resolveJiraRef("jira PROJ-123")).toBe("PROJ-123");
  });
  it("classifies uppercase .MD extension", () => {
    expect(classifyInput("NOTES.MD")).toEqual({ kind: "md-file", value: "NOTES.MD" });
  });
  it("falls back to prompt for a bare word", () => {
    expect(classifyInput("ship it")).toEqual({ kind: "prompt", value: "ship it" });
  });
});

describe("slugSourceFor", () => {
  it("md-file: strips the path, keeps the basename without extension", () => {
    expect(slugSourceFor(classifyInput("/Users/stefano/Projects/pi-stef/cursor-sunset-prompt.md"))).toBe(
      "cursor-sunset-prompt",
    );
  });
  it("md-file: relative path → basename without extension", () => {
    expect(slugSourceFor(classifyInput("./PRD.md"))).toBe("PRD");
  });
  it("md-file: uppercase extension stripped", () => {
    expect(slugSourceFor(classifyInput("NOTES.MD"))).toBe("NOTES");
  });
  it("prd: basename without extension", () => {
    expect(slugSourceFor(classifyInput("prd:docs/spec.prd"))).toBe("spec");
  });
  it("jira: the issue key (already short)", () => {
    expect(slugSourceFor(classifyInput("jira PROJ-123"))).toBe("PROJ-123");
  });
  it("prompt: the verbatim text (deriveSlug kebabs + truncates)", () => {
    expect(slugSourceFor(classifyInput("Add a login rate limiter"))).toBe("Add a login rate limiter");
  });
});
