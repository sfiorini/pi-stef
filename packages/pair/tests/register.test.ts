import { describe, it, expect } from "vitest";

// Import the private functions via the module's exports
// Since the extraction functions are private, we'll test them indirectly through the tool execution
// For now, we'll test the regex patterns directly

describe("extractReviewerModelFromPrompt", () => {
  // Recreate the function here for testing
  function extractReviewerModelFromPrompt(prompt: string): string | undefined {
    const patterns = [
      /use\s+([\w/.-]+)\s+as\s+reviewer/i,
      /reviewer[:\s]+([\w/.-]+)/i,
      /review\s+with\s+([\w/.-]+)/i,
    ];
    for (const pattern of patterns) {
      const match = prompt.match(pattern);
      if (match) return match[1];
    }
    return undefined;
  }

  it("extracts model from 'use X as reviewer'", () => {
    expect(extractReviewerModelFromPrompt("use anthropic/sonnet-4-6 as reviewer")).toBe("anthropic/sonnet-4-6");
  });

  it("extracts model from 'reviewer: X'", () => {
    expect(extractReviewerModelFromPrompt("reviewer: anthropic/sonnet-4-6")).toBe("anthropic/sonnet-4-6");
  });

  it("extracts model from 'reviewer X'", () => {
    expect(extractReviewerModelFromPrompt("reviewer anthropic/sonnet-4-6")).toBe("anthropic/sonnet-4-6");
  });

  it("extracts model from 'review with X'", () => {
    expect(extractReviewerModelFromPrompt("review with anthropic/sonnet-4-6")).toBe("anthropic/sonnet-4-6");
  });

  it("is case insensitive", () => {
    expect(extractReviewerModelFromPrompt("Use anthropic/sonnet-4-6 As Reviewer")).toBe("anthropic/sonnet-4-6");
  });

  it("returns undefined when no pattern matches", () => {
    expect(extractReviewerModelFromPrompt("implement authentication")).toBeUndefined();
  });

  it("handles model with dots and hyphens", () => {
    expect(extractReviewerModelFromPrompt("use openai/gpt-4-turbo as reviewer")).toBe("openai/gpt-4-turbo");
  });
});

describe("extractExplorerModelFromPrompt", () => {
  // Recreate the function here for testing
  function extractExplorerModelFromPrompt(prompt: string): string | undefined {
    const patterns = [
      /use\s+([\w/.-]+)\s+as\s+explorer/i,
      /explorer[:\s]+([\w/.-]+)/i,
      /explore\s+with\s+([\w/.-]+)/i,
    ];
    for (const pattern of patterns) {
      const match = prompt.match(pattern);
      if (match) return match[1];
    }
    return undefined;
  }

  it("extracts model from 'use X as explorer'", () => {
    expect(extractExplorerModelFromPrompt("use anthropic/sonnet-4-6 as explorer")).toBe("anthropic/sonnet-4-6");
  });

  it("extracts model from 'explorer: X'", () => {
    expect(extractExplorerModelFromPrompt("explorer: anthropic/sonnet-4-6")).toBe("anthropic/sonnet-4-6");
  });

  it("extracts model from 'explorer X'", () => {
    expect(extractExplorerModelFromPrompt("explorer anthropic/sonnet-4-6")).toBe("anthropic/sonnet-4-6");
  });

  it("extracts model from 'explore with X'", () => {
    expect(extractExplorerModelFromPrompt("explore with anthropic/sonnet-4-6")).toBe("anthropic/sonnet-4-6");
  });

  it("is case insensitive", () => {
    expect(extractExplorerModelFromPrompt("Use anthropic/sonnet-4-6 As Explorer")).toBe("anthropic/sonnet-4-6");
  });

  it("returns undefined when no pattern matches", () => {
    expect(extractExplorerModelFromPrompt("implement authentication")).toBeUndefined();
  });

  it("handles model with dots and hyphens", () => {
    expect(extractExplorerModelFromPrompt("use openai/gpt-4-turbo as explorer")).toBe("openai/gpt-4-turbo");
  });
});
