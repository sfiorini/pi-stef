import { describe, it, expect } from "vitest";
import { createFileAdapter } from "../src/ingest/file";

describe("file adapter", () => {
  it("reads a CSV path from creds.filePath and returns holdings", async () => {
    const adapter = createFileAdapter("fidelity", "brokerage");
    const session = await adapter.authenticate({ filePath: "packages/finance-api/tests/fixtures/fidelity-positions.csv" });
    const accts = await adapter.listAccounts(session);
    const holdings = await adapter.getHoldings(session, accts[0].providerAccountId);
    expect(holdings.length).toBeGreaterThan(0);
    expect(holdings[0].symbol).toBe("AAPL");
  });
});
