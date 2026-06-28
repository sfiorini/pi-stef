import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import type { ProviderAdapter, ProviderKind, Credentials, Session, RawAccount, RawHolding, RawTxn, RawBalance } from "../contract";
import { parsePositionsCsv } from "./csv";
import { parseOfx } from "./ofx";

export function createFileAdapter(providerId: string, kind: ProviderKind): ProviderAdapter {
  return {
    kind, providerId,
    authenticate: async (creds: Credentials): Promise<Session> => ({ providerId, expiresAt: undefined, creds }),
    listAccounts: async (): Promise<RawAccount[]> => [{ providerAccountId: "file", kind, name: `${providerId} file import`, currency: "USD" }],
    getHoldings: async (_s: Session, _id: string): Promise<RawHolding[]> => {
      // filePath is passed via creds at authenticate time; stored on session.creds by runIngest
      const creds = _s.creds ?? {};
      const filePath = creds.filePath ?? "";
      if (!filePath) return [];
      const buf = await readFile(filePath, "utf8");
      if (extname(filePath).toLowerCase() === ".ofx" || buf.includes("OFXHEADER")) {
        // OFX is banking txns, not holdings; cash handled via getBalances
        return [];
      }
      return parsePositionsCsv(buf);
    },
    getTransactions: async (_s: Session, _id: string): Promise<RawTxn[]> => {
      const creds = _s.creds ?? {};
      const filePath = creds.filePath ?? "";
      if (!filePath) return [];
      const buf = await readFile(filePath, "utf8");
      if (buf.includes("OFXHEADER")) {
        const ofx = parseOfx(buf);
        return ofx.transactions.map((t, i) => ({ id: `${i}`, date: Number(t.date), type: t.amount >= 0 ? "credit" : "debit", fees: 0 }));
      }
      return [];
    },
    getBalances: async (_s: Session, _id: string): Promise<RawBalance> => {
      const creds = _s.creds ?? {};
      const filePath = creds.filePath ?? "";
      if (!filePath) return { cash: 0, marketValue: 0, asOf: Date.now() };
      const buf = await readFile(filePath, "utf8");
      if (buf.includes("OFXHEADER")) {
        const ofx = parseOfx(buf);
        return { cash: ofx.balance, marketValue: 0, asOf: Date.now() };
      }
      return { cash: 0, marketValue: 0, asOf: Date.now() };
    },
  };
}
