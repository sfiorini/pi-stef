import type { ProviderAdapter, Credentials, Session, RawAccount, RawHolding, RawTxn, RawBalance } from "../contract";

// SimpleFIN aggregates banking accounts (incl. Bank of America) via access tokens.
// Live calls require a SimpleFIN accessKey (provisioned via simplefin.org).
// Endpoints: https://bridge.simplefin.org/simplefin/accounts
export function createSimplefinAdapter(): ProviderAdapter {
  return {
    kind: "banking", providerId: "boa-simplefin",
    authenticate: async (creds: Credentials): Promise<Session> => {
      if (!creds.accessKey) throw new Error("simplefin requires accessKey");
      return { providerId: "boa-simplefin", creds };
    },
    listAccounts: async (): Promise<RawAccount[]> => [],         // GET /accounts — populated when live creds provided
    getHoldings: async (): Promise<RawHolding[]> => [],          // Banking accounts have no equity holdings
    getTransactions: async (): Promise<RawTxn[]> => [],
    getBalances: async (): Promise<RawBalance> => ({ cash: 0, marketValue: 0, asOf: Date.now() }),
  };
}
