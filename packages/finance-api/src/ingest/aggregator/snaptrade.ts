import { Snaptrade } from "snaptrade-typescript-sdk";
import type { ProviderAdapter, Credentials, Session, RawAccount, RawHolding, RawTxn, RawBalance } from "../contract";

// SnapTrade aggregates brokerage accounts via per-user connections.
// The user self-provisions at snaptrade.com and supplies
// clientId + consumerKey (developer) and userId + userSecret (per-user) in secrets.json.
// The official SDK handles HMAC-SHA256 request signing; this module is a pure mapping layer.

export interface SnaptradeAdapterDeps {
  /** Injectable factory so tests can pass a fake SDK instance (no network). */
  createClient?: (creds: Credentials) => Snaptrade;
  /** Page size for the activities endpoint (default 1000, the SnapTrade max). Inject a smaller value in tests. */
  activitiesPageSize?: number;
}

export function createSnaptradeAdapter(deps: SnaptradeAdapterDeps = {}): ProviderAdapter {
  const createClient =
    deps.createClient ??
    ((creds: Credentials) => new Snaptrade({ consumerKey: creds.consumerKey, clientId: creds.clientId }));
  const activitiesPageSize = deps.activitiesPageSize ?? 1000;

  const userId = (s: Session) => s.creds!.userId;
  const userSecret = (s: Session) => s.creds!.userSecret;
  const clientOf = (s: Session) => createClient(s.creds!);

  return {
    kind: "brokerage",
    providerId: "snaptrade",

    authenticate: async (creds: Credentials): Promise<Session> => {
      for (const k of ["clientId", "consumerKey", "userId", "userSecret"] as const) {
        if (!creds[k]) throw new Error(`snaptrade requires ${k}`);
      }
      return { providerId: "snaptrade", creds };
    },

    listAccounts: async (s: Session): Promise<RawAccount[]> => {
      const res: any = await clientOf(s).accountInformation.listUserAccounts({ userId: userId(s), userSecret: userSecret(s) });
      const accounts = Array.isArray(res?.data) ? res.data : [];
      return accounts.map((acct: any) => ({
        providerAccountId: String(acct.id),
        kind: "brokerage" as const,
        name: acct.name ?? acct.institution_name ?? "snaptrade account",
        maskLast4: acct.number ? String(acct.number).slice(-4) : undefined,
        currency: "USD",
      }));
    },

    getHoldings: async (s: Session, accountId: string): Promise<RawHolding[]> => {
      const res: any = await clientOf(s).accountInformation.getUserAccountPositions({
        userId: userId(s), userSecret: userSecret(s), accountId,
      });
      const positions = Array.isArray(res?.data) ? res.data : [];
      const out: RawHolding[] = [];
      for (const p of positions) {
        const units = Number(p?.units ?? 0);
        // Skip zero / short positions: the data model cannot represent quantity <= 0.
        if (!(units > 0)) continue;
        const ticker = p?.symbol?.symbol?.symbol ?? p?.symbol?.symbol?.raw_symbol ?? p?.symbol?.id ?? "";
        if (!ticker) continue;
        out.push({
          symbol: String(ticker),
          quantity: units,
          avgCost: typeof p.average_purchase_price === "number" ? p.average_purchase_price : undefined,
          assetClass: "equity",
          subclass: "us",
        });
      }
      return out;
    },

    getTransactions: async (s: Session, accountId: string, since?: number): Promise<RawTxn[]> => {
      const startDate = since ? new Date(since).toISOString().slice(0, 10) : undefined;
      const limit = activitiesPageSize;
      let offset = 0;
      const out: RawTxn[] = [];
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const res: any = await clientOf(s).accountInformation.getAccountActivities({
          userId: userId(s), userSecret: userSecret(s), accountId, startDate, limit, offset,
        });
        const page: any[] = Array.isArray(res?.data?.data) ? res.data.data : [];
        page.forEach((a, i) => out.push(mapActivity(accountId, a, i)));
        if (page.length < limit) break;
        offset += limit;
      }
      return out;
    },

    getBalances: async (s: Session, accountId: string): Promise<RawBalance> => {
      const balRes: any = await clientOf(s).accountInformation.getUserAccountBalance({
        userId: userId(s), userSecret: userSecret(s), accountId,
      });
      const entries = Array.isArray(balRes?.data) ? balRes.data : [];
      const picked = entries.find((b: any) => b?.currency?.code === "USD") ?? entries[0];
      const detRes: any = await clientOf(s).accountInformation.getUserAccountDetails({
        userId: userId(s), userSecret: userSecret(s), accountId,
      });
      const total = detRes?.data?.balance?.total?.amount ?? 0;
      return { cash: Number(picked?.cash ?? 0), marketValue: Number(total), asOf: Date.now() };
    },
  };
}

function mapActivity(accountId: string, a: any, index: number): RawTxn {
  const ms = a?.trade_date ? Date.parse(String(a.trade_date)) : NaN;
  const symbol = a?.symbol?.symbol ?? a?.symbol?.raw_symbol ?? undefined;
  return {
    id: String(a?.id ?? `${accountId}:${a?.trade_date ?? "x"}:${a?.type ?? "t"}:${index}`),
    date: Number.isFinite(ms) ? ms : 0,
    symbol,
    qty: typeof a?.units === "number" ? a.units : undefined,
    price: typeof a?.price === "number" ? a.price : undefined,
    type: String(a?.type ?? "unknown").toLowerCase(),
    fees: typeof a?.fee === "number" ? a.fee : 0,
  };
}
