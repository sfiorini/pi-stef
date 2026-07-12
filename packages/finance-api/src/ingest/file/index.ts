import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import type { ProviderAdapter, ProviderKind, Credentials, Session, RawAccount, RawHolding, RawTxn, RawBalance } from "../contract";
import { parsePositionsCsv } from "./csv";
import { parseOfx } from "./ofx";

/**
 * Parse OFX date format (YYYYMMDD or YYYYMMDDHHMMSS) into unix ms.
 * OFX dates are in the format: 20260101 or 20260101120000
 */
function parseOfxDate(dateStr: string): number {
  if (!dateStr || dateStr.length < 8) return 0;
  const year = parseInt(dateStr.slice(0, 4), 10);
  const month = parseInt(dateStr.slice(4, 6), 10) - 1; // 0-indexed
  const day = parseInt(dateStr.slice(6, 8), 10);
  return new Date(year, month, day).getTime();
}

/** Detect OFX format from filename extension or content. */
function isOfx(filename: string | undefined, buf: string): boolean {
  if (filename && extname(filename).toLowerCase() === ".ofx") return true;
  return buf.includes("OFXHEADER");
}

/** Resolve file content from creds: prefer inline content, fall back to server-side file path. */
async function resolveContent(creds: Credentials): Promise<{ buf: string; filename: string | undefined } | null> {
  if (creds.content) {
    return { buf: String(creds.content), filename: creds.filename ?? undefined };
  }
  const filePath = creds.filePath ?? "";
  if (!filePath) return null;
  const buf = await readFile(filePath, "utf8");
  return { buf, filename: filePath };
}

export function createFileAdapter(providerId: string, kind: ProviderKind): ProviderAdapter {
  return {
    kind, providerId,
    authenticate: async (creds: Credentials): Promise<Session> => ({ providerId, expiresAt: undefined, creds }),
    listAccounts: async (): Promise<RawAccount[]> => [{ providerAccountId: "file", kind, name: `${providerId} file import`, currency: "USD" }],
    getHoldings: async (s: Session): Promise<RawHolding[]> => {
      const resolved = await resolveContent(s.creds ?? {});
      if (!resolved) return [];
      if (isOfx(resolved.filename, resolved.buf)) return []; // OFX = txns, not holdings
      return parsePositionsCsv(resolved.buf);
    },
    getTransactions: async (s: Session): Promise<RawTxn[]> => {
      const resolved = await resolveContent(s.creds ?? {});
      if (!resolved) return [];
      if (!isOfx(resolved.filename, resolved.buf)) return [];
      const ofx = parseOfx(resolved.buf);
      return ofx.transactions.map((t, i) => ({
        id: `${i}`,
        date: parseOfxDate(t.date),
        type: t.amount >= 0 ? "credit" : "debit",
        fees: 0,
      }));
    },
    getBalances: async (s: Session): Promise<RawBalance> => {
      const resolved = await resolveContent(s.creds ?? {});
      if (!resolved) return { cash: 0, marketValue: 0, asOf: Date.now() };
      if (!isOfx(resolved.filename, resolved.buf)) return { cash: 0, marketValue: 0, asOf: Date.now() };
      const ofx = parseOfx(resolved.buf);
      return { cash: ofx.balance, marketValue: 0, asOf: Date.now() };
    },
  };
}
