import type { ProviderAdapter, Credentials, Session, RawAccount, RawHolding, RawTxn, RawBalance } from "../contract";

// SnapTrade aggregates brokerage accounts (incl. Fidelity) via OAuth-style user connections.
// Live calls require SnapTrade clientId + consumerKey (developer-tier provisioning — open item).
// Endpoints: https://api.snaptrade.com/api/v1/{accounts,positions,balances}
export function createSnaptradeAdapter(): ProviderAdapter {
  return {
    kind: "brokerage", providerId: "fidelity-snaptrade",
    authenticate: async (creds: Credentials): Promise<Session> => {
      if (!creds.clientId || !creds.consumerKey) throw new Error("snaptrade requires clientId + consumerKey");
      if (!creds.userSecret) throw new Error("snaptrade requires a registered userSecret (connection not established)");
      return { providerId: "fidelity-snaptrade", creds };
    },
    listAccounts: async (): Promise<RawAccount[]> => [],         // GET /accounts — populated when live creds provided
    getHoldings: async (): Promise<RawHolding[]> => [],          // GET /positions
    getTransactions: async (): Promise<RawTxn[]> => [],
    getBalances: async (): Promise<RawBalance> => ({ cash: 0, marketValue: 0, asOf: Date.now() }),
  };
}
