import { describe, expect, it } from "vitest";
import {
  formatUserError,
  isCorruptYamlError,
  isMissingGistError,
  isNetworkError,
  isPermissionError,
} from "../../src/util/errors.js";

// ---------------------------------------------------------------------------
// formatUserError
// ---------------------------------------------------------------------------

describe("formatUserError", () => {
  it("returns a user-friendly message for YAMLException", () => {
    const err = new Error("YAMLException: unexpected character at line 3");
    const result = formatUserError(err);
    expect(result).toContain("corrupt");
    expect(result).toContain("ct init --force");
  });

  it("returns a user-friendly message for ZodError-like parse failure", () => {
    const err = new Error("ZodError: expected string, got number");
    const result = formatUserError(err);
    expect(result).toContain("invalid format");
    expect(result).toContain("ct init --force");
  });

  it("returns a user-friendly message for network errors (ECONNREFUSED)", () => {
    const err = new Error("fetch failed: ECONNREFUSED");
    const result = formatUserError(err);
    expect(result).toContain("network");
    expect(result).toContain("--offline");
  });

  it("returns a user-friendly message for network timeout", () => {
    const err = new Error("request timed out after 30000ms");
    const result = formatUserError(err);
    expect(result).toContain("timed out");
    expect(result).toContain("retry");
  });

  it("returns a user-friendly message for missing gist ID", () => {
    const err = new Error("No gist found for profile");
    const result = formatUserError(err);
    expect(result).toContain("ct login");
  });

  it("returns a user-friendly message for permission errors (EACCES)", () => {
    const err = new Error("EACCES: permission denied");
    const result = formatUserError(err);
    expect(result).toContain("permission");
    expect(result).toContain("~/.pi/sf/catalog");
  });

  it("returns a user-friendly message for ENOENT when catalog missing", () => {
    const err = new Error("ENOENT: no such file 'cat.yaml'");
    const result = formatUserError(err);
    expect(result).toContain("not found");
    expect(result).toContain("ct init");
  });

  it("returns a user-friendly message for 401 Unauthorized", () => {
    const err = new Error("HTTP 401: Unauthorized");
    const result = formatUserError(err);
    expect(result).toContain("ct login");
  });

  it("returns a user-friendly message for 403 Forbidden", () => {
    const err = new Error("HTTP 403: Forbidden");
    const result = formatUserError(err);
    expect(result).toContain("ct login");
  });

  it("passes through generic errors with context", () => {
    const err = new Error("something unexpected");
    const result = formatUserError(err);
    expect(result).toContain("something unexpected");
  });

  it("handles non-Error values", () => {
    const result = formatUserError("string error");
    expect(result).toContain("string error");
  });

  it("handles null/undefined gracefully", () => {
    const result = formatUserError(null);
    expect(result).toContain("unknown error");
  });
});

// ---------------------------------------------------------------------------
// Predicate helpers
// ---------------------------------------------------------------------------

describe("isCorruptYamlError", () => {
  it("detects YAMLException", () => {
    expect(isCorruptYamlError(new Error("YAMLException: bad indent"))).toBe(true);
  });

  it("detects Zod validation errors", () => {
    expect(isCorruptYamlError(new Error("ZodError: validation failed"))).toBe(true);
  });

  it("returns false for generic errors", () => {
    expect(isCorruptYamlError(new Error("file not found"))).toBe(false);
  });
});

describe("isMissingGistError", () => {
  it("detects missing gist messages", () => {
    expect(isMissingGistError(new Error("No gist found for profile"))).toBe(true);
  });

  it("detects gist not found", () => {
    expect(isMissingGistError(new Error("gist not found: 404"))).toBe(true);
  });

  it("returns false for other errors", () => {
    expect(isMissingGistError(new Error("network error"))).toBe(false);
  });
});

describe("isNetworkError", () => {
  it("detects ECONNREFUSED", () => {
    expect(isNetworkError(new Error("ECONNREFUSED"))).toBe(true);
  });

  it("detects timeout errors", () => {
    expect(isNetworkError(new Error("request timed out"))).toBe(true);
  });

  it("detects ETIMEDOUT", () => {
    expect(isNetworkError(new Error("ETIMEDOUT"))).toBe(true);
  });

  it("detects ENOTFOUND", () => {
    expect(isNetworkError(new Error("ENOTFOUND"))).toBe(true);
  });

  it("returns false for non-network errors", () => {
    expect(isNetworkError(new Error("invalid yaml"))).toBe(false);
  });
});

describe("isPermissionError", () => {
  it("detects EACCES", () => {
    expect(isPermissionError(new Error("EACCES: permission denied"))).toBe(true);
  });

  it("detects EPERM", () => {
    expect(isPermissionError(new Error("EPERM: operation not permitted"))).toBe(true);
  });

  it("returns false for non-permission errors", () => {
    expect(isPermissionError(new Error("file not found"))).toBe(false);
  });
});
