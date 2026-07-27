import { describe, it, expect, vi } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { decodeJwt, decodeProtectedHeader } from "jose";
import { createCoinbaseAdapter } from "../src/ingest/direct/coinbase";
import type { FetchLike } from "../src/ingest/direct/coinbase";
import type { Credentials } from "../src/ingest/contract";

// Hermetic P-256 key for offline ES256 JWT signing. Generated per test-run.
const TEST_PRIVATE_KEY = generateKeyPairSync("ec", { namedCurve: "P-256" })
  .privateKey.export({ type: "pkcs8", format: "pem" }) as string;
const KEY_NAME = "organizations/test-org/apiKeys/test-key";
const CREDS: Credentials = { keyName: KEY_NAME, privateKey: TEST_PRIVATE_KEY };

function mockFetcher(response: unknown) {
  return vi.fn(async () => new Response(JSON.stringify(response), {
    status: 200, headers: { "content-type": "application/json" } })) as unknown as FetchLike;
}

describe("coinbase adapter — identity & auth", () => {
  it("reports kind=crypto and providerId=coinbase", () => {
    const adapter = createCoinbaseAdapter();
    expect(adapter.kind).toBe("crypto");
    expect(adapter.providerId).toBe("coinbase");
  });

  it("throws when keyName or privateKey is missing", async () => {
    const adapter = createCoinbaseAdapter();
    await expect(adapter.authenticate({})).rejects.toThrow("coinbase requires keyName + privateKey");
    await expect(adapter.authenticate({ keyName: "k" })).rejects.toThrow("coinbase requires keyName + privateKey");
    await expect(adapter.authenticate({ privateKey: "p" })).rejects.toThrow("coinbase requires keyName + privateKey");
  });

  it("authenticate returns session with creds attached", async () => {
    const adapter = createCoinbaseAdapter();
    const session = await adapter.authenticate(CREDS);
    expect(session.providerId).toBe("coinbase");
    expect(session.creds).toEqual(CREDS);
  });
});

describe("coinbase adapter — listAccounts (JWT + pagination)", () => {
  it("sends Bearer ES256 JWT with correct header and payload claims", async () => {
    const fetcher = mockFetcher({ accounts: [{ uuid: "a1", currency: "BTC" }], has_next: false, cursor: "" });
    const adapter = createCoinbaseAdapter({ fetcher });
    const session = await adapter.authenticate(CREDS);
    await adapter.listAccounts(session);

    const callArgs = (fetcher as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    const authHeader = (callArgs[1].headers as Record<string, string>).Authorization;
    expect(authHeader).toMatch(/^Bearer /);
    const token = authHeader.replace("Bearer ", "");

    // No CB-ACCESS-* headers
    const headers = callArgs[1].headers as Record<string, string>;
    expect(Object.keys(headers).filter((k) => k.startsWith("CB-ACCESS"))).toHaveLength(0);

    // Decode and assert header claims
    const header = decodeProtectedHeader(token);
    expect(header.alg).toBe("ES256");
    expect(header.kid).toBe(KEY_NAME);
    expect(header.typ).toBe("JWT");
    expect(header.nonce).toBeDefined();

    // Decode and assert payload claims
    const payload = decodeJwt(token);
    expect(payload.iss).toBe("cdp");
    expect(payload.sub).toBe(KEY_NAME);
    expect(payload.uris).toEqual(["GET api.coinbase.com/api/v3/brokerage/accounts"]);
  });

  it("paginates with cursor and concatenates results (2 fetch calls)", async () => {
    const page1 = { accounts: [{ uuid: "a1", name: "BTC Wallet", currency: "BTC" }], has_next: true, cursor: "page2cursor" };
    const page2 = { accounts: [{ uuid: "a2", name: "ETH Wallet", currency: "ETH" }], has_next: false, cursor: "" };
    let callCount = 0;
    const fetcher = vi.fn(async (_url: string) => {
      callCount++;
      const body = callCount === 1 ? page1 : page2;
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as FetchLike;

    const adapter = createCoinbaseAdapter({ fetcher });
    const session = await adapter.authenticate(CREDS);
    const accounts = await adapter.listAccounts(session);

    expect(accounts).toHaveLength(2);
    expect(accounts[0]).toMatchObject({ providerAccountId: "a1", kind: "crypto", name: "BTC Wallet", currency: "BTC" });
    expect(accounts[1]).toMatchObject({ providerAccountId: "a2", kind: "crypto", name: "ETH Wallet", currency: "ETH" });
    expect((fetcher as unknown as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(2);
  });

  it("throws on non-2xx response", async () => {
    const fetcher = vi.fn(async () => new Response("{}", { status: 500 })) as unknown as FetchLike;
    const adapter = createCoinbaseAdapter({ fetcher });
    const session = await adapter.authenticate(CREDS);
    await expect(adapter.listAccounts(session)).rejects.toThrow("/accounts 500");
  });
});
