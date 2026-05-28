import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { AGENT_WORKFLOWS_PACKAGE_NAME } from "../src";

describe("@pi-stef/agent-workflows package scaffold", () => {
  it("exposes a stable package name from the entrypoint", () => {
    expect(AGENT_WORKFLOWS_PACKAGE_NAME).toBe("@pi-stef/agent-workflows");
  });

  it("declares runnable package-local test and typecheck scripts", () => {
    const pkg = JSON.parse(readFileSync(path.join(__dirname, "..", "package.json"), "utf8")) as {
      scripts?: Record<string, string>;
      exports?: Record<string, string>;
    };

    expect(pkg.scripts?.test).toBe("vitest run");
    expect(pkg.scripts?.typecheck).toBe("tsc --noEmit -p tsconfig.json");
    expect(pkg.exports?.["."]).toBe("./src/index.ts");
  });
});
