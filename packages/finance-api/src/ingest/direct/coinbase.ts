import type { ProviderAdapter, Credentials, Session, RawAccount, RawHolding, RawTxn, RawBalance } from "../contract";

const BASE = "https://api.coinbase.com/api/v3/brokerage";

interface FetchLike { (url: string, init?: RequestInit): Promise<Response> }

export interface CoinbaseDeps { fetcher?: FetchLike; now?: () => number }

export function createCoinbaseAdapter(deps: CoinbaseDeps = {}): ProviderAdapter {
  const fetcher = deps.fetcher ?? ((url: string, init?: RequestInit) => fetch(url, init));
  const now = deps.now ?? (() => Date.now());

  async function signedRequest(creds: Credentials, path: string): Promise<unknown> {
    const timestamp = Math.floor(now() / 1000).toString();
    // Real signing uses HMAC-SHA256 over timestamp+method+path+body with privateKey.
    // This stub passes keyName as CB-ACCESS-KEY; full HMAC signing added when wiring real creds.
    const res = await fetcher(`${BASE}${path}`, {
      headers: {
        "CB-ACCESS-KEY": creds.keyName,
        "CB-ACCESS-TIMESTAMP": timestamp,
      },
    });
    if (!res.ok) throw new Error(`coinbase ${path} ${res.status}`);
    return res.json();
  }

  return {
    kind: "crypto", providerId: "coinbase",
    authenticate: async (creds: Credentials): Promise<Session> => {
      if (!creds.keyName || !creds.privateKey) throw new Error("coinbase requires keyName + privateKey");
      return { providerId: "coinbase", creds };
    },
    listAccounts: async (s: Session): Promise<RawAccount[]> => [{ providerAccountId: "spot", kind: "crypto", name: "Coinbase Spot", currency: "USD" }],
    getHoldings: async (s: Session): Promise<RawHolding[]> => {
      const creds = s.creds ?? {};  // creds attached to Session by runIngest (see contract.ts Session.creds)
      const body = (await signedRequest(creds, "/accounts")) as { accounts?: { currency: string; available_balance?: { value: string } }[] };
      return (body.accounts ?? [])
        .filter((a) => a.currency !== "USD")
        .map((a) => ({ symbol: a.currency, quantity: Number(a.available_balance?.value ?? "0"), assetClass: "crypto" }));
    },
    getTransactions: async (): Promise<RawTxn[]> => [],
    getBalances: async (): Promise<RawBalance> => ({ cash: 0, marketValue: 0, asOf: now() }),
  };
}
