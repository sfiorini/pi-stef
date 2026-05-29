import path from "node:path";
import { describe, expect, it } from "vitest";
import { globalDir, globalConfig } from "../src/global.js";
import { projectDir, projectConfig } from "../src/project.js";
import { PI_DIR, SF_NAMESPACE, sfBase } from "../src/constants.js";

const HOME = "/home/testuser";

describe("constants", () => {
  it("PI_DIR is .pi", () => {
    expect(PI_DIR).toBe(".pi");
  });
  it("SF_NAMESPACE is sf", () => {
    expect(SF_NAMESPACE).toBe("sf");
  });
  it("sfBase joins home/.pi/sf", () => {
    expect(sfBase("/home/test")).toBe(path.join("/home/test", ".pi", "sf"));
  });
});

describe("global helpers", () => {
  it("globalDir returns ~/.pi/sf/<pkg>/", () => {
    expect(globalDir("team", HOME)).toBe(path.join(HOME, ".pi", "sf", "team"));
    expect(globalDir("web", HOME)).toBe(path.join(HOME, ".pi", "sf", "web"));
    expect(globalDir("figma", HOME)).toBe(path.join(HOME, ".pi", "sf", "figma"));
    expect(globalDir("atlassian", HOME)).toBe(path.join(HOME, ".pi", "sf", "atlassian"));
    expect(globalDir("agent-workflows", HOME)).toBe(path.join(HOME, ".pi", "sf", "agent-workflows"));
    expect(globalDir("azure-foundry", HOME)).toBe(path.join(HOME, ".pi", "sf", "azure-foundry"));
  });

  it("globalConfig returns ~/.pi/sf/<pkg>/config.json", () => {
    expect(globalConfig("team", HOME)).toBe(path.join(HOME, ".pi", "sf", "team", "config.json"));
    expect(globalConfig("web", HOME)).toBe(path.join(HOME, ".pi", "sf", "web", "config.json"));
  });

  it("globalDir defaults to os.homedir() when home is omitted", () => {
    const result = globalDir("team");
    expect(result).toContain(".pi");
    expect(result).toContain("sf");
    expect(result).toContain("team");
  });
});

describe("project helpers", () => {
  const ROOT = "/projects/myapp";

  it("projectDir returns <root>/.pi/sf/<pkg>/", () => {
    expect(projectDir("team", ROOT)).toBe(path.join(ROOT, ".pi", "sf", "team"));
    expect(projectDir("web", ROOT)).toBe(path.join(ROOT, ".pi", "sf", "web"));
  });

  it("projectConfig returns <root>/.pi/sf/<pkg>/config.json", () => {
    expect(projectConfig("team", ROOT)).toBe(path.join(ROOT, ".pi", "sf", "team", "config.json"));
  });
});
