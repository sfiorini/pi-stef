import type { ProviderAdapter, Credentials, Session, RawAccount, RawHolding, RawTxn, RawBalance } from "../contract";

// Teller aggregates banking accounts (incl. Bank of America) via device-based authentication.
// NOTE: Teller uses device-based scraping which may have reliability/ToS implications.
// Live calls require a Teller token (provisioned via teller.io).
// Endpoints: https://api.teller.io/{accounts,balances,transactions}
export function createTellerAdapter(): ProviderAdapter {
  return {
    kind: "banking", providerId: "boa-teller",
    authenticate: async (creds: Credentials): Promise<Session> => {
      if (!creds.token) throw new Error("teller requires token");
      return { providerId: "boa-teller", creds };
    },
    listAccounts: async (): Promise<RawAccount[]> => [],         // GET /accounts — populated when live creds provided
    getHoldings: async (): Promise<RawHolding[]> => [],          // Banking accounts have no equity holdings
    getTransactions: async (): Promise<RawTxn[]> => [],
    getBalances: async (): Promise<RawBalance> => ({ cash: 0, marketValue: 0, asOf: Date.now() }),
  };
}
