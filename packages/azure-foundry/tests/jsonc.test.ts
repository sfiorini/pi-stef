import { describe, expect, it } from "vitest";

import { stripJsonc } from "../src/jsonc";

describe("stripJsonc", () => {
  it("strips line and block comments", () => {
    const stripped = stripJsonc(`{
      // line comment
      "deployments": [] /* block */
    }`);

    expect(JSON.parse(stripped)).toEqual({ deployments: [] });
  });

  it("preserves comment markers and escaped quotes inside strings", () => {
    const stripped = stripJsonc(`{
      "url": "https://example.com/openai/v1/",
      "quoted": "a \\"// not a comment\\" value",
      "block": "/* not a comment */"
    }`);

    expect(JSON.parse(stripped)).toEqual({
      url: "https://example.com/openai/v1/",
      quoted: 'a "// not a comment" value',
      block: "/* not a comment */",
    });
  });
});
