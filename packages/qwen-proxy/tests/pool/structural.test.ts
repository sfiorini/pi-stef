/**
 * Structural typing proof (R-M3-3):
 * GuestUpstreamClient satisfies Pick<UpstreamClient, "chatCompletions" | "listModels" | "deleteChats">.
 *
 * This is primarily a compile-time assertion — if the type relationship breaks,
 * tsc will fail. The runtime assertion just confirms the methods exist.
 */
import { describe, it, expect } from "vitest";
import type { UpstreamClient } from "../../src/upstream/client";
import { GuestUpstreamClient } from "../../src/upstream/guest-client";

type AdapterClient = Pick<UpstreamClient, "chatCompletions" | "listModels" | "deleteChats">;

// Compile-time assertion: GuestUpstreamClient is assignable to the adapter Pick
const _ok: AdapterClient = new GuestUpstreamClient({
  baxia: {} as any,
  chatUrl: "x",
  log: { info() {}, warn() {}, error() {} } as any,
});

describe("GuestUpstreamClient structural typing (R-M3-3)", () => {
  it("GuestUpstreamClient satisfies the adapter Pick<UpstreamClient>", () => {
    expect(typeof _ok.chatCompletions).toBe("function");
    expect(typeof _ok.listModels).toBe("function");
    expect(typeof _ok.deleteChats).toBe("function");
  });
});
