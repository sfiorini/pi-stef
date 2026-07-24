import { describe, expect, it } from "vitest";

import { loadCursorSdk } from "../src/sdk-runtime";

describe("loadCursorSdk", () => {
  it("returns the real @cursor/sdk namespace with expected shape", async () => {
    const sdk = await loadCursorSdk();

    // Agent class with factory method
    expect(sdk.Agent).toBeDefined();
    expect(typeof sdk.Agent.create).toBe("function");

    // Cursor static class with models.list and configure
    expect(sdk.Cursor).toBeDefined();
    expect(typeof sdk.Cursor.models.list).toBe("function");
    expect(typeof sdk.Cursor.configure).toBe("function");
  });
});
