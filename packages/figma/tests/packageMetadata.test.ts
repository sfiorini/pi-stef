import fs from "fs";
import path from "path";
import { describe, expect, it } from "vitest";

const packageRoot = path.resolve(import.meta.dirname, "..");

describe("figma package metadata", () => {
  it("declares the new package identity, extension path, docs, and canonical config file", () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(packageRoot, "package.json"), "utf8")) as {
      name: string;
      pi?: { extensions?: string[] };
    };
    const metadata = JSON.parse(
      fs.readFileSync(path.join(packageRoot, "fh-agent.package.json"), "utf8"),
    ) as {
      configuration?: { summary?: string; files?: Array<{ path: string }> };
      documentation?: { readme?: string };
    };

    expect(manifest.name).toBe("@pi-stef/figma");
    expect(manifest.pi?.extensions).toEqual(["./extensions"]);
    expect(metadata.documentation?.readme).toBe("packages/figma/README.md");
    expect(metadata.configuration?.summary).toContain("~/.pi/figma/config.json");
    expect(metadata.configuration?.files?.map((file) => file.path)).toContain("~/.pi/figma/config.json");
  });
});
