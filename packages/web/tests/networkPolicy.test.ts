import { describe, expect, it } from "vitest";

import { createPinnedLookup, isBlockedIp, parseGuardedUrl, resolveGuardedHostname } from "../src/networkPolicy";

describe("web network policy", () => {
  it("accepts only http and https URLs", () => {
    expect(parseGuardedUrl("https://example.com/path").href).toBe("https://example.com/path");
    expect(() => parseGuardedUrl("file:///etc/passwd")).toThrow(/only http and https/i);
    expect(() => parseGuardedUrl("ftp://example.com")).toThrow(/only http and https/i);
  });

  it.each([
    "0.0.0.0",
    "10.0.0.1",
    "127.0.0.1",
    "169.254.1.1",
    "172.16.0.1",
    "192.168.1.1",
    "224.0.0.1",
    "::1",
    "fc00::1",
    "fe80::1",
    "ff00::1",
    "::ffff:192.168.1.1",
  ])("blocks unsafe address %s", (address) => {
    expect(isBlockedIp(address)).toBe(true);
  });

  it.each(["93.184.216.34", "8.8.8.8", "2606:2800:220:1:248:1893:25c8:1946"])(
    "allows public address %s",
    (address) => {
      expect(isBlockedIp(address)).toBe(false);
    },
  );

  it("rejects DNS results that resolve to blocked addresses", async () => {
    await expect(
      resolveGuardedHostname(new URL("https://internal.example.com"), {
        lookup: async () => [{ address: "127.0.0.1", family: 4 }],
      }),
    ).rejects.toThrow(/blocked/i);
  });

  it("returns public DNS results and pins lookup to the selected address", async () => {
    const [resolved] = await resolveGuardedHostname(new URL("https://example.com"), {
      lookup: async () => [{ address: "93.184.216.34", family: 4 }],
    });
    const lookup = createPinnedLookup(resolved);

    const result = await new Promise<{ address: string; family: number }>((resolve, reject) => {
      lookup("ignored.example.com", {}, (error, address, family) => {
        if (error) reject(error);
        else resolve({ address: String(address), family: Number(family) });
      });
    });

    expect(result).toEqual({ address: "93.184.216.34", family: 4 });
  });

  it("supports Node lookup callbacks that request all addresses", async () => {
    const lookup = createPinnedLookup({ address: "93.184.216.34", family: 4 });

    const result = await new Promise<Array<{ address: string; family: number }>>((resolve, reject) => {
      lookup("ignored.example.com", { all: true }, (error, address) => {
        if (error) reject(error);
        else resolve(address as never);
      });
    });

    expect(result).toEqual([{ address: "93.184.216.34", family: 4 }]);
  });
});
