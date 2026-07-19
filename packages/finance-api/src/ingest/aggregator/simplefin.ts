import type { ProviderAdapter, Credentials, Session, RawAccount, RawHolding, RawTxn, RawBalance } from "../contract";

// SimpleFIN aggregates banking accounts via the SimpleFIN Bridge.
// Protocol: https://www.simplefin.org/protocol.html
// Auth flow: setup token (one-time) → POST claim URL → access URL (persistent, Basic Auth)
// Endpoints: GET /accounts?version=2 — returns accounts with balances + transactions

export interface SimplefinAdapterDeps {
  /** Injectable fetcher so tests can mock HTTP without network. */
  fetcher?: typeof fetch;
}

/** AccountSet from GET /accounts response. */
interface AccountSet {
  errlist?: { code: string; msg: string; conn_id?: string; account_id?: string }[];
  connections?: unknown[];
  accounts?: SimplefinAccount[];
}

interface SimplefinAccount {
  id: string;
  name: string;
  conn_id?: string;
  currency: string;
  balance: string;
  "available-balance"?: string;
  "balance-date": number;
  transactions?: SimplefinTxn[];
}

interface SimplefinTxn {
  id: string;
  posted: number;
  amount: string;
  description: string;
  pending?: boolean;
}

/** Base64-decode the setup token to get the claim URL, POST to it, receive access URL. */
async function exchangeSetupToken(setupToken: string, fetcher: typeof fetch): Promise<string> {
  const claimUrl = Buffer.from(setupToken, "base64").toString("utf8");
  const res = await fetcher(claimUrl, { method: "POST", headers: { "Content-Length": "0" } });
  if (!res.ok) {
    throw new Error(`simplefin setup token exchange failed: ${res.status} (token may have already been claimed)`);
  }
  const accessUrl = (await res.text()).trim();
  if (!accessUrl.startsWith("https://")) {
    throw new Error(`simplefin: unexpected response from claim endpoint: ${accessUrl.slice(0, 100)}`);
  }
  return accessUrl;
}

/** Extract base URL and Basic Auth header from an access URL. */
function parseAccessUrl(accessUrl: string): { baseUrl: string; auth: string } {
  const url = new URL(accessUrl);
  const baseUrl = `${url.origin}${url.pathname.replace(/\/$/, "")}`;
  const auth = Buffer.from(`${url.username}:${url.password}`).toString("base64");
  return { baseUrl, auth };
}

/** Resolve the access URL from session — prefer resolvedCreds (from exchange), fall back to creds.accessUrl. */
function resolveAccessUrl(s: Session): string {
  return s.resolvedCreds?.accessUrl ?? s.creds?.accessUrl ?? "";
}

/** Check errlist for fatal errors. Throws on any `gen.*` code (auth failures, API misuse). */
function checkErrlist(data: AccountSet): void {
  const errs = data.errlist ?? [];
  for (const e of errs) {
    if (e.code?.startsWith("gen.")) {
      throw new Error(`simplefin: ${e.msg} (code: ${e.code})`);
    }
  }
}

export function createSimplefinAdapter(deps: SimplefinAdapterDeps = {}): ProviderAdapter {
  const fetcher = deps.fetcher ?? fetch;
  // Cache: session → AccountSet (balances-only response from listAccounts)
  const balanceCache = new WeakMap<object, AccountSet>();
  // Cache: session → AccountSet (full response with transactions from first getTransactions)
  const txnCache = new WeakMap<object, AccountSet>();

  return {
    kind: "banking",
    providerId: "simplefin",

    authenticate: async (creds: Credentials): Promise<Session> => {
      if (creds.accessUrl) {
        return { providerId: "simplefin", creds };
      }
      if (creds.setupToken) {
        const accessUrl = await exchangeSetupToken(creds.setupToken, fetcher);
        return { providerId: "simplefin", creds, resolvedCreds: { accessUrl } };
      }
      throw new Error("simplefin requires setupToken or accessUrl");
    },

    listAccounts: async (s: Session): Promise<RawAccount[]> => {
      const { baseUrl, auth } = parseAccessUrl(resolveAccessUrl(s));
      const res = await fetcher(`${baseUrl}/accounts?balances-only=1&version=2`, {
        headers: { Authorization: `Basic ${auth}` },
      });
      if (!res.ok) throw new Error(`simplefin: /accounts returned ${res.status}`);
      const data: AccountSet = await res.json();
      checkErrlist(data);
      balanceCache.set(s, data);
      return (data.accounts ?? []).map((acct: SimplefinAccount) => ({
        providerAccountId: String(acct.id),
        kind: "banking" as const,
        name: acct.name ?? "simplefin account",
        currency: acct.currency ?? "USD",
      }));
    },

    getHoldings: async (): Promise<RawHolding[]> => [],

    getBalances: async (s: Session, accountId: string): Promise<RawBalance> => {
      const cached = balanceCache.get(s);
      if (!cached) return { cash: 0, marketValue: 0, asOf: Date.now() };
      const acct = (cached.accounts ?? []).find((a: SimplefinAccount) => String(a.id) === accountId);
      if (!acct) return { cash: 0, marketValue: 0, asOf: Date.now() };
      return {
        cash: Number(acct.balance ?? 0),
        marketValue: 0,
        asOf: acct["balance-date"] ? acct["balance-date"] * 1000 : Date.now(),
      };
    },

    getTransactions: async (s: Session, accountId: string, since?: number): Promise<RawTxn[]> => {
      let cached = txnCache.get(s);
      if (!cached) {
        const { baseUrl, auth } = parseAccessUrl(resolveAccessUrl(s));
        const params = new URLSearchParams({ version: "2" });
        if (since) params.set("start-date", String(Math.floor(since / 1000)));
        const res = await fetcher(`${baseUrl}/accounts?${params}`, {
          headers: { Authorization: `Basic ${auth}` },
        });
        if (!res.ok) throw new Error(`simplefin: /accounts returned ${res.status}`);
        const fresh: AccountSet = await res.json();
        checkErrlist(fresh);
        txnCache.set(s, fresh);
        cached = fresh;
      }
      const acct = (cached.accounts ?? []).find((a: SimplefinAccount) => String(a.id) === accountId);
      if (!acct?.transactions) return [];
      return acct.transactions
        .filter((t: SimplefinTxn) => !t.pending)
        .map((t: SimplefinTxn) => ({
          id: String(t.id),
          date: t.posted ? t.posted * 1000 : 0,
          type: Number(t.amount) >= 0 ? "credit" : "debit",
          fees: 0,
        }));
    },
  };
}
