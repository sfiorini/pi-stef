import { describe, it, expect } from "vitest";
import { classifyInput, resolveJiraRef } from "../src/auto/input.js";

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
});
