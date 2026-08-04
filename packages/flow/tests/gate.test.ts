import { describe, it, expect } from "vitest";
import { gateApproved } from "../src/yaml/gate.js";

describe("gateApproved (fail-closed, D4)", () => {
  const failOn = ["P0", "P1", "P2"];

  it("null/undefined/{} -> blocked (malformed)", () => {
    expect(gateApproved(null, failOn).ok).toBe(false);
    expect(gateApproved(undefined, failOn).ok).toBe(false);
    expect(gateApproved({}, failOn).ok).toBe(false);
  });

  it("missing/non-string verdict -> blocked (malformed)", () => {
    expect(gateApproved({ findings: [] }, failOn).ok).toBe(false);
    expect(gateApproved({ verdict: 42 }, failOn).ok).toBe(false);
  });

  it("REVISE without findings -> blocked (malformed/non-approved)", () => {
    expect(gateApproved({ verdict: "REVISE" }, failOn).ok).toBe(false);
  });

  it("REVISE with only non-blocking findings -> blocked (non-approved)", () => {
    expect(gateApproved({ verdict: "REVISE", findings: [{ severity: "P3" }] }, failOn).ok).toBe(false);
  });

  it("APPROVED with a blocking finding -> blocked", () => {
    expect(gateApproved({ verdict: "APPROVED", findings: [{ severity: "P1" }] }, failOn).ok).toBe(false);
  });

  it("APPROVED with only P3 findings -> ok (P3 non-blocking)", () => {
    expect(gateApproved({ verdict: "APPROVED", findings: [{ severity: "P3" }] }, failOn).ok).toBe(true);
  });

  it("APPROVED no findings -> ok", () => {
    expect(gateApproved({ verdict: "APPROVED", findings: [] }, failOn).ok).toBe(true);
  });

  it("reports a reason on every branch", () => {
    expect(gateApproved(null, failOn).reason).toBe("malformed-gate");
    expect(gateApproved({ verdict: "APPROVED", findings: [{ severity: "P0" }] }, failOn).reason).toBe("approved-with-blocking");
    expect(gateApproved({ verdict: "APPROVED", findings: [] }, failOn).reason).toBe("approved");
    expect(gateApproved({ verdict: "REVISE" }, failOn).reason).toBe("non-approved");
  });
});
