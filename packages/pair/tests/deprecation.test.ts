import { describe, it, expect } from "vitest";
import {
  pairDeprecatedNotice,
  pairDeprecatedDescriptionPrefix,
  withPairDeprecationNotice,
} from "../src/deprecation";

describe("pair deprecation", () => {
  it("notice names the flow replacement per tool", () => {
    expect(pairDeprecatedNotice("sf_pair_plan")).toContain("sf_flow_plan (/sf-flow-plan)");
    expect(pairDeprecatedNotice("sf_pair_implement")).toContain("sf_flow_implement (/sf-flow-implement)");
    expect(pairDeprecatedNotice("sf_pair_task")).toContain("sf_flow_auto (/sf-flow-auto)");
    expect(pairDeprecatedNotice("sf_pair_finalize")).toContain("sf_flow_finalize (/sf-flow-finalize)");
    expect(pairDeprecatedNotice("sf_pair_plan")).toContain("migrating-from-team-and-pair");
  });

  it("description prefix is [DEPRECATED — use /sf-flow-*]", () => {
    expect(pairDeprecatedDescriptionPrefix("sf_pair_plan")).toBe("[DEPRECATED — use /sf-flow-plan] ");
    expect(pairDeprecatedDescriptionPrefix("sf_pair_finalize")).toBe("[DEPRECATED — use /sf-flow-finalize] ");
  });

  it("wrapper prepends the banner to the first text result", async () => {
    const fakeExec = async () => ({ content: [{ type: "text", text: "ok" }], details: {} });
    const wrapped = withPairDeprecationNotice("sf_pair_plan")(fakeExec as any) as any;
    const res = await wrapped();
    expect(res.content[0].text).toBe(pairDeprecatedNotice("sf_pair_plan") + "ok");
    expect(res.details).toEqual({});
  });

  it("wrapper leaves non-text first content untouched", async () => {
    const fakeExec = async () => ({ content: [{ type: "image", text: "x" }], details: {} });
    const wrapped = withPairDeprecationNotice("sf_pair_plan")(fakeExec as any) as any;
    const res = await wrapped();
    expect(res.content[0].text).toBe("x");
  });
});
