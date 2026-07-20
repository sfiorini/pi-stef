import { describe, it, expect } from "vitest";

describe("extension registration", () => {
  it("finance extension default export registers tools", async () => {
    // Mock ExtensionAPI
    const registeredTools: { name: string }[] = [];
    const registeredCommands: { name: string }[] = [];
    const mockPi = {
      registerTool: (tool: { name: string }) => { registeredTools.push(tool); },
      registerCommand: (name: string) => { registeredCommands.push({ name }); },
    };

    // Import the extension
    const { default: financeExtension } = await import("../extensions/finance");
    financeExtension(mockPi as never);

    // Verify tools were registered
    expect(registeredTools.length).toBeGreaterThan(0);
    expect(registeredTools.some((t) => t.name.startsWith("sf_fin_"))).toBe(true);
    // Verify slash commands were registered
    expect(registeredCommands.length).toBeGreaterThan(0);
    expect(registeredCommands.some((c) => c.name.startsWith("sf-fin-"))).toBe(true);
  });
});
