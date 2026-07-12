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

  it("reads CSV content directly from creds.content (no server filesystem access)", async () => {
    const adapter = createFileAdapter("fidelity", "brokerage");
    const csv = [
      "Account,Symbol,Description,Quantity,Last Price",
      "Brokerage,AAPL,Apple Inc.,10,190.50",
    ].join("\n");
    const session = await adapter.authenticate({ content: csv, filename: "positions.csv" });
    const accts = await adapter.listAccounts(session);
    const holdings = await adapter.getHoldings(session, accts[0].providerAccountId);
    expect(holdings).toHaveLength(1);
    expect(holdings[0].symbol).toBe("AAPL");
  });

  it("detects OFX format from content even without filename", async () => {
    const adapter = createFileAdapter("bank", "banking");
    const ofx = "OFXHEADER:100\nDATA:OFXSGML\n...";
    const session = await adapter.authenticate({ content: ofx });
    const accts = await adapter.listAccounts(session);
    const holdings = await adapter.getHoldings(session, accts[0].providerAccountId);
    expect(holdings).toEqual([]); // OFX returns no holdings (txns only)
  });
});
