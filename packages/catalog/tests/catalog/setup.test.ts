import { describe, expect, it, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { checkSetup, formatSetupStatus } from "../../src/catalog/setup.js";

describe("checkSetup", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "setup-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns undefined when no .pi-setup.json exists", () => {
    const result = checkSetup(tmpDir, tmpDir);
    expect(result).toBeUndefined();
  });

  it("returns undefined for malformed .pi-setup.json", () => {
    fs.writeFileSync(path.join(tmpDir, ".pi-setup.json"), "not json", "utf-8");
    const result = checkSetup(tmpDir, tmpDir);
    expect(result).toBeUndefined();
  });

  it("returns ok: true when all requirements are met", () => {
    // Set an env var for testing
    const origEnv = process.env.TEST_SETUP_VAR;
    process.env.TEST_SETUP_VAR = "yes";

    fs.writeFileSync(
      path.join(tmpDir, ".pi-setup.json"),
      JSON.stringify({ env: ["TEST_SETUP_VAR"] }),
      "utf-8",
    );

    const result = checkSetup(tmpDir, tmpDir);
    expect(result).toBeDefined();
    expect(result!.ok).toBe(true);
    expect(result!.missingEnv).toEqual([]);

    // Cleanup
    if (origEnv === undefined) {
      delete process.env.TEST_SETUP_VAR;
    } else {
      process.env.TEST_SETUP_VAR = origEnv;
    }
  });

  it("detects missing environment variables", () => {
    // Use a var that's definitely not set
    delete process.env.__DEFINITELY_NOT_SET_VAR_12345__;

    fs.writeFileSync(
      path.join(tmpDir, ".pi-setup.json"),
      JSON.stringify({ env: ["__DEFINITELY_NOT_SET_VAR_12345__"] }),
      "utf-8",
    );

    const result = checkSetup(tmpDir, tmpDir);
    expect(result).toBeDefined();
    expect(result!.ok).toBe(false);
    expect(result!.missingEnv).toEqual(["__DEFINITELY_NOT_SET_VAR_12345__"]);
  });

  it("detects missing config files", () => {
    fs.writeFileSync(
      path.join(tmpDir, ".pi-setup.json"),
      JSON.stringify({ files: ["config.json"] }),
      "utf-8",
    );

    const result = checkSetup(tmpDir, tmpDir);
    expect(result).toBeDefined();
    expect(result!.ok).toBe(false);
    expect(result!.missingFiles).toEqual(["config.json"]);
  });

  it("detects present config files", () => {
    fs.writeFileSync(
      path.join(tmpDir, ".pi-setup.json"),
      JSON.stringify({ files: ["config.json"] }),
      "utf-8",
    );
    fs.writeFileSync(path.join(tmpDir, "config.json"), "{}", "utf-8");

    const result = checkSetup(tmpDir, tmpDir);
    expect(result).toBeDefined();
    expect(result!.ok).toBe(true);
    expect(result!.missingFiles).toEqual([]);
  });

  it("detects missing CLI tools", () => {
    fs.writeFileSync(
      path.join(tmpDir, ".pi-setup.json"),
      JSON.stringify({ cli: ["__nonexistent_tool_xyz__"] }),
      "utf-8",
    );

    const result = checkSetup(tmpDir, tmpDir);
    expect(result).toBeDefined();
    expect(result!.ok).toBe(false);
    expect(result!.missingCli).toEqual(["__nonexistent_tool_xyz__"]);
  });

  it("detects present CLI tools", () => {
    // `node` should be available everywhere
    fs.writeFileSync(
      path.join(tmpDir, ".pi-setup.json"),
      JSON.stringify({ cli: ["node"] }),
      "utf-8",
    );

    const result = checkSetup(tmpDir, tmpDir);
    expect(result).toBeDefined();
    expect(result!.ok).toBe(true);
    expect(result!.missingCli).toEqual([]);
  });

  it("checks multiple requirements together", () => {
    delete process.env.__DEFINITELY_NOT_SET_VAR_12345__;

    fs.writeFileSync(
      path.join(tmpDir, ".pi-setup.json"),
      JSON.stringify({
        env: ["__DEFINITELY_NOT_SET_VAR_12345__"],
        files: ["missing.json"],
        cli: ["__nonexistent_tool_xyz__"],
      }),
      "utf-8",
    );

    const result = checkSetup(tmpDir, tmpDir);
    expect(result).toBeDefined();
    expect(result!.ok).toBe(false);
    expect(result!.missingEnv).toEqual(["__DEFINITELY_NOT_SET_VAR_12345__"]);
    expect(result!.missingFiles).toEqual(["missing.json"]);
    expect(result!.missingCli).toEqual(["__nonexistent_tool_xyz__"]);
  });
});

describe("formatSetupStatus", () => {
  it("formats missing env", () => {
    const status = {
      ok: false,
      missingEnv: ["API_KEY"],
      missingFiles: [],
      missingCli: [],
    };
    expect(formatSetupStatus(status)).toBe("Missing env: API_KEY");
  });

  it("formats multiple missing items", () => {
    const status = {
      ok: false,
      missingEnv: ["API_KEY", "SECRET"],
      missingFiles: ["config.json"],
      missingCli: ["docker"],
    };
    expect(formatSetupStatus(status)).toBe(
      "Missing env: API_KEY, SECRET; Missing files: config.json; Missing CLI: docker",
    );
  });

  it("returns empty string when ok", () => {
    const status = {
      ok: true,
      missingEnv: [],
      missingFiles: [],
      missingCli: [],
    };
    expect(formatSetupStatus(status)).toBe("");
  });
});
