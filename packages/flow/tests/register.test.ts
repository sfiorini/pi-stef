import { describe, it, expect } from "vitest";
import { FLOW_TOOL_NAMES } from "../src/register.js";

describe("flow register", () => {
  it("exports the expected tool names", () => {
    expect(FLOW_TOOL_NAMES).toEqual([
      "sf_flow_plan",
      "sf_flow_implement",
      "sf_flow_audit",
      "sf_flow_auto",
      "sf_flow_create_workflow",
      "sf_flow_finalize",
    ]);
  });
});
