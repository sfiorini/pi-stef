import { SignJWT } from "jose";
import { createPrivateKey, randomBytes } from "node:crypto";
import type { ProviderAdapter, Credentials, Session, RawAccount, RawHolding, RawTxn, RawBalance } from "../contract";

const API_PATH = "/api/v3/brokerage";
const BASE = "https://api.coinbase.com" + API_PATH;
const HOST = "api.coinbase.com";
const STABLE = new Set(["USD", "USDC", "USDT", "DAI", "EUR", "GBP"]);
export const MAX_FILL_PAGES = 50;

interface CoinbaseAccount {
  uuid?: string; name?: string; currency?: string; type?: string;
  available_balance?: { value?: string; currency?: string };
}
export interface Fill {
  entry_id?: string; trade_id?: string; trade_time?: string; side?: string;
  size?: string; price?: string; commission?: string; product_id?: string;
}
export interface FetchLike { (url: string, init?: RequestInit): Promise<Response> }
export interface CoinbaseDeps { fetcher?: FetchLike; now?: () => number }

function isStable(c?: string): boolean { return STABLE.has((c ?? "").toUpperCase()); }
export function isFiat(a?: CoinbaseAccount): boolean { return a?.type === "ACCOUNT_TYPE_FIAT" || isStable(a?.currency); }
export function baseOfProductId(p?: string): string { return String(p ?? "").split("-")[0]; }

export function createCoinbaseAdapter(deps: CoinbaseDeps = {}): ProviderAdapter {
  const fetcher = deps.fetcher ?? ((url: string, init?: RequestInit) => fetch(url, init));
  const now = deps.now ?? (() => Date.now());
  const accountCache = new WeakMap<object, CoinbaseAccount[]>();

  async function mintJwt(creds: Credentials, method: string, path: string): Promise<string> {
    const sec = Math.floor(now() / 1000);
    const key = createPrivateKey({ key: creds.privateKey, format: "pem" });
    const nonce = randomBytes(16).toString("hex");
    return new SignJWT({ iss: "cdp", sub: creds.keyName, uris: [`${method} ${HOST}${API_PATH}${path}`] })
      .setProtectedHeader({ alg: "ES256", kid: creds.keyName, typ: "JWT", nonce })
      .setIssuedAt(sec)
      .setNotBefore(sec)
      .setExpirationTime(sec + 120)
      .sign(key);
  }

  async function request(creds: Credentials, method: string, path: string, query?: Record<string, string>): Promise<unknown> {
    const jwt = await mintJwt(creds, method, path);
    const qs = query && Object.keys(query).length ? "?" + new URLSearchParams(query) : "";
    const res = await fetcher(BASE + path + qs, {
      method,
      headers: { Authorization: `Bearer ${jwt}`, Accept: "application/json" },
    });
    if (!res.ok) throw new Error(`coinbase ${path} ${res.status}`);
    return res.json();
  }

  async function resolveAccount(s: Session, accountId: string): Promise<CoinbaseAccount | undefined> {
    const cached = accountCache.get(s)?.find((a) => a.uuid === accountId);
    if (cached) return cached;
    const creds = s.creds ?? {};
    const body = (await request(creds, "GET", `/accounts/${accountId}`)) as { account?: CoinbaseAccount };
    return body.account;
  }

  return {
    kind: "crypto", providerId: "coinbase",
    authenticate: async (creds: Credentials): Promise<Session> => {
      if (!creds.keyName || !creds.privateKey) throw new Error("coinbase requires keyName + privateKey");
      return { providerId: "coinbase", creds };
    },
    listAccounts: async (s: Session): Promise<RawAccount[]> => {
      const creds = s.creds ?? {};
      const out: CoinbaseAccount[] = [];
      let cursor: string | undefined;
      for (;;) {
        const query: Record<string, string> = { limit: "250" };
        if (cursor) query.cursor = cursor;
        const body = (await request(creds, "GET", "/accounts", query)) as
          { accounts?: CoinbaseAccount[]; has_next?: boolean; cursor?: string };
        out.push(...(body.accounts ?? []));
        if (!body.has_next || !body.cursor) break;
        cursor = body.cursor;
      }
      accountCache.set(s, out);
      return out.map((a) => ({
        providerAccountId: String(a.uuid ?? ""),
        kind: "crypto" as const,
        name: a.name ?? "Coinbase " + (a.currency ?? "Wallet"),
        currency: a.currency ?? "",
      }));
    },
    getHoldings: async (s: Session, accountId: string): Promise<RawHolding[]> => {
      const acct = await resolveAccount(s, accountId);
      if (!acct) return [];
      const symbol = acct.currency ?? "";
      const qty = Math.abs(Number(acct.available_balance?.value ?? "0"));
      const holding: RawHolding = { symbol, quantity: qty, assetClass: "crypto", cashEquivalent: isStable(symbol) };
      if (!isStable(symbol)) {
        try {
          const creds = s.creds ?? {};
          const body = (await request(creds, "GET", `/market/products/${symbol}-USD`)) as { price?: string };
          const p = Number(body.price);
          if (Number.isFinite(p)) holding.price = p;
        } catch { /* non-fatal: value.ts:27 cascade falls back to avg_cost/0 */ }
      }
      return [holding];
    },
    // LIMITATION: CDP v3 keys expose ONLY trade fills via /orders/historical/fills.
    // Deposits, withdrawals, staking rewards, conversions, and receive/send are NOT
    // available through CDP API keys (they require the v2 OAuth2 path, which CDP keys
    // cannot satisfy). getTransactions therefore returns trade history only.
    // proof_token_required === true (EU SCA): v1 does NOT implement proof tokens; we
    // return whatever fills were returned (likely []). See docs (finance-api-coinbase).
    getTransactions: async (s: Session, accountId: string, since?: number): Promise<RawTxn[]> => {
      const acct = await resolveAccount(s, accountId);
      if (!acct || isFiat(acct)) return [];
      const creds = s.creds ?? {};
      const currency = acct.currency ?? "";
      const out: RawTxn[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < MAX_FILL_PAGES; page++) {
        const query: Record<string, string> = { limit: "100" };
        if (typeof since === "number") query.start_sequence_timestamp = new Date(since).toISOString();
        if (cursor) query.cursor = cursor;
        const body = (await request(creds, "GET", "/orders/historical/fills", query)) as
          { fills?: Fill[]; cursor?: string; proof_token_required?: boolean };
        const fills = body.fills ?? [];
        for (const f of fills.filter((x) => baseOfProductId(x.product_id) === currency)) {
          const d = Date.parse(f.trade_time ?? "");
          if (!Number.isFinite(d)) continue;
          if (typeof since === "number" && d < since) continue;   // client-side since-filter: correctness regardless of server param
          const size = Number(f.size ?? "");
          const price = Number(f.price ?? "");
          if (!Number.isFinite(size) || !Number.isFinite(price)) continue;
          out.push({
            id: String(f.entry_id ?? f.trade_id ?? ""),
            date: d,
            symbol: baseOfProductId(f.product_id),
            qty: Math.abs(size),
            price,
            fees: Number(f.commission ?? "0"),
            type: f.side === "BUY" ? "credit" : "debit",
          });
        }
        if (!body.cursor || !fills.length) break;   // no has_next on fills; guard + cap
        cursor = body.cursor;
      }
      return out;
    },
    getBalances: async (s: Session, accountId: string): Promise<RawBalance> => {
      const acct = await resolveAccount(s, accountId);
      const cash = acct && isFiat(acct) ? Number(acct.available_balance?.value ?? 0) : 0;
      return { cash, marketValue: 0, asOf: now() };
    },
  };
}
