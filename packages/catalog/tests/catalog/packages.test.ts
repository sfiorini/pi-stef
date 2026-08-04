import { describe, expect, it } from "vitest";

import {
  PI_STEF_PACKAGES,
  CATALOG_PACKAGE_NAME,
  isPiStefPackage,
  isPiStefSource,
} from "../../src/catalog/packages.js";

describe("packages", () => {
  describe("PI_STEF_PACKAGES", () => {
    it("does not include @pi-stef/catalog", () => {
      expect(PI_STEF_PACKAGES).not.toContain(CATALOG_PACKAGE_NAME);
    });

    it("contains expected packages", () => {
      expect(PI_STEF_PACKAGES).toContain("@pi-stef/agent-workflows");
      expect(PI_STEF_PACKAGES).toContain("@pi-stef/atlassian");
      expect(PI_STEF_PACKAGES).toContain("@pi-stef/figma");
      expect(PI_STEF_PACKAGES).toContain("@pi-stef/paths");
      expect(PI_STEF_PACKAGES).toContain("@pi-stef/web");
    });
  });

  describe("isPiStefPackage", () => {
    it("returns true for @pi-stef packages", () => {
      expect(isPiStefPackage("@pi-stef/figma")).toBe(true);
      expect(isPiStefPackage("@pi-stef/web")).toBe(true);
    });

    it("returns false for @pi-stef/catalog", () => {
      expect(isPiStefPackage("@pi-stef/catalog")).toBe(false);
    });

    it("returns false for non-pi-stef packages", () => {
      expect(isPiStefPackage("lodash")).toBe(false);
      expect(isPiStefPackage("@other/pkg")).toBe(false);
    });
  });

  describe("isPiStefSource", () => {
    it("returns true for npm: prefixed pi-stef sources", () => {
      expect(isPiStefSource("npm:@pi-stef/figma")).toBe(true);
      expect(isPiStefSource("npm:@pi-stef/web@1.0.0")).toBe(true);
    });

    it("returns false for npm:pi-stef/catalog", () => {
      expect(isPiStefSource("npm:@pi-stef/catalog")).toBe(false);
      expect(isPiStefSource("npm:@pi-stef/catalog@1.0.0")).toBe(false);
    });

    it("returns false for non-pi-stef npm sources", () => {
      expect(isPiStefSource("npm:lodash")).toBe(false);
      expect(isPiStefSource("npm:@other/pkg")).toBe(false);
    });

    it("returns true for bare pi-stef package names", () => {
      expect(isPiStefSource("@pi-stef/figma")).toBe(true);
    });

    it("returns false for git sources", () => {
      expect(isPiStefSource("git:github.com/user/repo")).toBe(false);
    });
  });
});
