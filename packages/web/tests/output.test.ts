import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { createTextOutput } from "../src/output";

describe("web output", () => {
  it("returns text unchanged when within limits", async () => {
    const output = await createTextOutput("short text", {
      maxBytes: 100,
      maxLines: 10,
      outputDir: await mkdtemp(path.join(tmpdir(), "fh-web-output-")),
    });

    expect(output).toMatchObject({
      fullOutputPath: undefined,
      originalBytes: Buffer.byteLength("short text"),
      returnedBytes: Buffer.byteLength("short text"),
      text: "short text",
      truncated: false,
    });
  });

  it("uses Pi truncation helpers and writes full output when truncated", async () => {
    const outputDir = await mkdtemp(path.join(tmpdir(), "fh-web-output-"));
    const text = Array.from({ length: 40 }, (_, index) => `line ${index}`).join("\n");

    const output = await createTextOutput(text, {
      filePrefix: "fetch",
      maxBytes: 80,
      maxLines: 5,
      outputDir,
    });

    expect(output.truncated).toBe(true);
    expect(output.text.split("\n")).toHaveLength(5);
    expect(output.fullOutputPath).toMatch(/fetch-.*\.txt$/);
    expect(await readFile(output.fullOutputPath!, "utf8")).toBe(text);
    expect(output.originalBytes).toBe(Buffer.byteLength(text));
    expect(output.returnedBytes).toBe(Buffer.byteLength(output.text));
  });
});
