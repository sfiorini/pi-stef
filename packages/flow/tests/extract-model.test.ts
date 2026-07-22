import { describe, it, expect } from "vitest";
import {
  isValidModelToken,
  extractReviewerModelFromPrompt,
  extractResearcherModelFromPrompt,
  extractDesignerModelFromPrompt,
} from "../src/register.js";

describe("isValidModelToken", () => {
  it("accepts known aliases (case-insensitive)", () => {
    expect(isValidModelToken("sonnet")).toBe(true);
    expect(isValidModelToken("CLAUDE")).toBe(true);
    expect(isValidModelToken("gpt")).toBe(true);
    expect(isValidModelToken("flash")).toBe(true);
    expect(isValidModelToken("haiku")).toBe(true);
    expect(isValidModelToken("opus")).toBe(true);
  });

  it("accepts versioned / slash-suffixed names", () => {
    expect(isValidModelToken("gpt-4o")).toBe(true);
    expect(isValidModelToken("anthropic/sonnet-4-6")).toBe(true);
    expect(isValidModelToken("claude-3.5-sonnet")).toBe(true);
  });

  it("rejects undefined, empty, and single-char tokens", () => {
    expect(isValidModelToken(undefined)).toBe(false);
    expect(isValidModelToken("")).toBe(false);
    expect(isValidModelToken("a")).toBe(false);
  });

  it("rejects common English connector / filler words", () => {
    expect(isValidModelToken("and")).toBe(false);
    expect(isValidModelToken("or")).toBe(false);
    expect(isValidModelToken("with")).toBe(false);
    expect(isValidModelToken("model")).toBe(false);
    expect(isValidModelToken("the")).toBe(false);
  });
});

describe("extractReviewerModelFromPrompt", () => {
  it("extracts from 'use X as reviewer'", () => {
    expect(extractReviewerModelFromPrompt("use opus as reviewer")).toBe("opus");
  });

  it("extracts from 'reviewer: X'", () => {
    expect(extractReviewerModelFromPrompt("reviewer: sonnet")).toBe("sonnet");
  });

  it("extracts from 'review with X'", () => {
    expect(extractReviewerModelFromPrompt("review with claude-3.5-sonnet")).toBe("claude-3.5-sonnet");
  });

  it("rejects 'and' misfire (reviewer: and)", () => {
    expect(extractReviewerModelFromPrompt("reviewer: and")).toBeUndefined();
  });

  it("returns undefined when no match", () => {
    expect(extractReviewerModelFromPrompt("hello world")).toBeUndefined();
  });
});

describe("extractResearcherModelFromPrompt", () => {
  it("extracts from 'use X as researcher'", () => {
    expect(extractResearcherModelFromPrompt("use sonnet as researcher")).toBe("sonnet");
  });

  it("extracts from 'researcher: X'", () => {
    expect(extractResearcherModelFromPrompt("researcher: haiku")).toBe("haiku");
  });

  it("extracts from 'research with X'", () => {
    expect(extractResearcherModelFromPrompt("research with gpt-4o")).toBe("gpt-4o");
  });

  it("rejects 'and' misfire (research with and)", () => {
    expect(extractResearcherModelFromPrompt("research with and")).toBeUndefined();
  });

  it("returns undefined when no match", () => {
    expect(extractResearcherModelFromPrompt("hello world")).toBeUndefined();
  });
});

describe("extractDesignerModelFromPrompt", () => {
  it("extracts from 'use X as designer'", () => {
    expect(extractDesignerModelFromPrompt("use opus as designer")).toBe("opus");
  });

  it("extracts from 'designer: X'", () => {
    expect(extractDesignerModelFromPrompt("designer: flash")).toBe("flash");
  });

  it("extracts from 'design with X'", () => {
    expect(extractDesignerModelFromPrompt("design with claude-3.5-sonnet")).toBe("claude-3.5-sonnet");
  });

  it("rejects 'and' misfire (designer: and)", () => {
    expect(extractDesignerModelFromPrompt("designer: and")).toBeUndefined();
  });

  it("returns undefined when no match", () => {
    expect(extractDesignerModelFromPrompt("hello world")).toBeUndefined();
  });
});
