export interface OfxResult { accountId: string; balance: number; transactions: { amount: number; date: string; name: string }[] }

function tag(s: string, name: string): string | undefined {
  const m = s.match(new RegExp(`<${name}>([^<]*)</${name}>`));
  return m ? m[1] : undefined;
}

export function parseOfx(ofx: string): OfxResult {
  const accountId = tag(ofx, "ACCTID") ?? "unknown";
  const balance = Number(tag(ofx, "BALAMT") ?? "0");
  const transactions = [...ofx.matchAll(/<STMTTRN>([\s\S]*?)<\/STMTTRN>/g)].map((m) => ({
    amount: Number(tag(m[1], "TRNAMT") ?? "0"),
    date: tag(m[1], "DTPOSTED") ?? "",
    name: tag(m[1], "NAME") ?? "",
  }));
  return { accountId, balance, transactions };
}
