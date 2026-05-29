import { describe, expect, it } from "vitest";

import { redactText, redactUrl } from "../src/redact";

describe("web redaction", () => {
  it("removes URL userinfo and sensitive query values", () => {
    const redacted = redactUrl(
      "https://user:secret@example.com/path?token=abc&x=1&API_KEY=def&password=hunter2",
      ["x"],
    );

    expect(redacted).toBe("https://example.com/path?token=REDACTED&x=REDACTED&API_KEY=REDACTED&password=REDACTED");
    expect(redacted).not.toContain("secret");
    expect(redacted).not.toContain("hunter2");
  });

  it("redacts URLs inside free text without changing non-URL text", () => {
    const redacted = redactText(
      "fetch https://a:b@example.com/?code=123, then https://example.org/path?ok=true&jwt=secret",
    );

    expect(redacted).toContain("fetch ");
    expect(redacted).toContain("https://example.com/?code=REDACTED");
    expect(redacted).toContain("https://example.org/path?ok=true&jwt=REDACTED");
    expect(redacted).not.toContain("secret");
  });

  it("escapes custom sensitive keys before building text redaction patterns", () => {
    const redacted = redactText("failure ?my.key=secret&myXkey=public", ["my.key"]);

    expect(redacted).toContain("?my.key=REDACTED");
    expect(redacted).toContain("&myXkey=public");
    expect(redacted).not.toContain("secret");
  });
});
