import { describe, it, expect } from "vitest";
import {
  stripDetails,
  DetailsStreamStripper,
} from "../../src/upstream/details-strip";

// ── stripDetails (non-stream) ───────────────────────────────────────────────

describe("stripDetails", () => {
  it("strips trailing <details>…</details> block and trims", () => {
    const text =
      'Here is the answer.\n<details>Response ID: abc123\nRequest ID: def456</details>\n';
    expect(stripDetails(text)).toBe("Here is the answer.");
  });

  it("returns text unchanged when no <details> block present", () => {
    const text = "Just a normal response.";
    expect(stripDetails(text)).toBe("Just a normal response.");
  });

  it("only strips trailing <details> — not mid-text", () => {
    const text = "Before <details>inner</details> after.";
    expect(stripDetails(text)).toBe("Before <details>inner</details> after.");
  });

  it("strips <details> with multiline content", () => {
    const text =
      'Answer text\n<details>\nResponse ID: x\nRequest ID: y\nModel: qwen3-max\n</details>';
    expect(stripDetails(text)).toBe("Answer text");
  });

  it("trims trailing whitespace after stripping", () => {
    const text = "Answer\n<details>info</details>   \n\n";
    expect(stripDetails(text)).toBe("Answer");
  });
});

// ── DetailsStreamStripper (streaming) ───────────────────────────────────────

describe("DetailsStreamStripper", () => {
  it("passes through text when no <details> tag appears (total output correct)", () => {
    const stripper = new DetailsStreamStripper();
    const parts: string[] = [];
    parts.push(stripper.push("Hello "));     // 6 chars ≤ 9 → hold
    parts.push(stripper.push("world!"));     // 12 chars > 9 → emit "Hel", retain "lo world!"
    parts.push(stripper.finalize());          // flush "lo world!"
    expect(parts.join("")).toBe("Hello world!");
  });

  it("emits safe prefix once buffer exceeds 9 chars, then seals on <details>", () => {
    const stripper = new DetailsStreamStripper();
    // "Answer text" = 11 chars → emit first 2 ("An"), retain "swer text" (9)
    const out1 = stripper.push("Answer text");
    expect(out1).toBe("An");

    // buffer = "swer text" + "<details>Response ID: abc</details>"
    // = "swer text<details>Response ID: abc</details>"
    // <details> at index 9 → emit "swer text" before it → seal
    const out2 = stripper.push("<details>Response ID: abc</details>");
    expect(out2).toBe("swer text");

    // Sealed — subsequent pushes return ""
    expect(stripper.push("more")).toBe("");
    expect(stripper.finalize()).toBe("");
  });

  it("handles <details> tag split across 2 pushes", () => {
    const stripper = new DetailsStreamStripper();
    // "Hello <det" = 10 chars → emit first 1 ("H"), retain "ello <det" (9)
    const out1 = stripper.push("Hello <det");
    expect(out1).toBe("H");

    // buffer = "ello <details>info</details>"
    // <details> at index 5 → emit "ello " → seal
    const out2 = stripper.push("ails>info</details>");
    expect(out2).toBe("ello ");

    expect(stripper.finalize()).toBe("");
    // Total: "H" + "ello " = "Hello " ✓
  });

  it("handles <details> tag split across 3 pushes", () => {
    const stripper = new DetailsStreamStripper();
    // "Hi <" = 4 chars ≤ 9 → hold
    expect(stripper.push("Hi <")).toBe("");

    // "Hi <detail" = 10 chars → emit first 1 ("H"), retain "i <detail" (9)
    expect(stripper.push("detail")).toBe("H");

    // buffer = "i <details>x</details>"
    // <details> at index 2 → emit "i " → seal
    expect(stripper.push("s>x</details>")).toBe("i ");

    expect(stripper.finalize()).toBe("");
    // Total: "H" + "i " = "Hi " ✓
  });

  it("holdback: retains last 9 chars when no <details> found", () => {
    const stripper = new DetailsStreamStripper();
    // "abcdefghi" = 9 chars ≤ 9 → nothing emitted
    expect(stripper.push("abcdefghi")).toBe("");

    // buffer = "abcdefghijkl" = 12 chars → emit first 3 ("abc"), retain 9
    expect(stripper.push("jkl")).toBe("abc");

    expect(stripper.finalize()).toBe("defghijkl");
  });

  it("seal drops all subsequent content after <details> seen", () => {
    const stripper = new DetailsStreamStripper();
    // "before" = 6 chars → hold. Then "<details>info</details>" appended.
    // buffer = "before<details>info</details>"
    // <details> at index 6 → emit "before" → seal
    const out = stripper.push("before<details>info</details>");
    expect(out).toBe("before");

    expect(stripper.push("ignored after seal")).toBe("");
    expect(stripper.finalize()).toBe("");
  });

  it("<details> at buffer start emits nothing", () => {
    const stripper = new DetailsStreamStripper();
    // buffer = "<details>info</details>" → <details> at 0 → emit "" → seal
    const out = stripper.push("<details>info</details>");
    expect(out).toBe("");
    expect(stripper.finalize()).toBe("");
  });

  it("finalize on empty buffer returns empty string", () => {
    const stripper = new DetailsStreamStripper();
    expect(stripper.finalize()).toBe("");
  });
});
