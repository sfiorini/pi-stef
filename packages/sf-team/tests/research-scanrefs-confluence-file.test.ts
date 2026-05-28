import { describe, expect, it } from "vitest";

import { scanRefs } from "../src/research/external-fetch";

describe("scanRefs: confluence refs (P2 fix) + file refs no longer scanned (Plan B)", () => {
  it("classifies an Atlassian wiki URL as kind='confluence' (NOT plain url)", () => {
    const refs = scanRefs("see https://acme.atlassian.net/wiki/spaces/ENG/pages/12345/Title for details");
    expect(refs).toHaveLength(1);
    expect(refs[0].kind).toBe("confluence");
    expect(refs[0].id).toBe("https://acme.atlassian.net/wiki/spaces/ENG/pages/12345/Title");
  });

  it("does NOT scan local file paths anymore (Plan B: researcher has --tools read,grep,find,ls and can read files itself)", () => {
    const refs = scanRefs("look at packages/sf-team/src/research/run.ts and ./README.md and review/page.tsx");
    // No `kind="file"` ref produced. Whole result is empty for this input
    // because the string contains no URL / Jira / Confluence either.
    expect(refs.filter((r) => r.kind === "file")).toEqual([]);
    expect(refs).toEqual([]);
  });

  it("does not double-classify a confluence URL (no separate `url` ref for it)", () => {
    const refs = scanRefs("https://acme.atlassian.net/wiki/x/ABC and https://example.com/regular");
    const kinds = refs.map((r) => r.kind).sort();
    expect(kinds).toEqual(["confluence", "url"]);
    expect(refs.find((r) => r.id === "https://acme.atlassian.net/wiki/x/ABC")?.kind).toBe("confluence");
    expect(refs.find((r) => r.id === "https://example.com/regular")?.kind).toBe("url");
  });

  it("conservative: bare words like 'package.json' alone do not match (and file scanning is gone regardless)", () => {
    const refs = scanRefs("just a tsconfig and some text");
    expect(refs.filter((r) => r.kind === "file")).toEqual([]);
  });
});
