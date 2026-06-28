import { describe, it, expect } from "vitest";

describe("extension registration", () => {
  it("finance extension default export registers tools", async () => {
    // Mock ExtensionAPI
    const registeredTools: { name: string }[] = [];
    const mockPi = {
      registerTool: (tool: { name: string }) => { registeredTools.push(tool); },
    };

    // Import the extension
    const { default: financeExtension } = await import("../extensions/finance");
    financeExtension(mockPi as never);

    // Verify tools were registered
    expect(registeredTools.length).toBeGreaterThan(0);
    expect(registeredTools.some((t) => t.name.startsWith("sf_fin_"))).toBe(true);
  });
});
