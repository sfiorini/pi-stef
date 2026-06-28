import { describe, it, expect } from "vitest";
import { parseOfx } from "../src/ingest/file/ofx";

const sample = `OFXHEADER:100
DATA:OFXSGML
<BANKMSGSRSV1><STMTTRNRS><STMTRS><BANKACCTFROM><ACCTID>1234</ACCTID><ACCTTYPE>CHECKING</ACCTTYPE></BANKACCTFROM>
<LEDGERBAL><BALAMT>1500.25</BALAMT></LEDGERBAL>
<BANKTRANLIST><STMTTRN><TRNAMT>-42.10</TRNAMT><DTPOSTED>20260101</DTPOSTED><NAME>COFFEE</NAME></STMTTRN></BANKTRANLIST>
</STMTRS></STMTTRNRS></BANKMSGSRSV1>`;

describe("parseOfx", () => {
  it("extracts account id, balance, and transactions", () => {
    const r = parseOfx(sample);
    expect(r.accountId).toBe("1234");
    expect(r.balance).toBe(1500.25);
    expect(r.transactions).toHaveLength(1);
    expect(r.transactions[0]).toMatchObject({ amount: -42.1, name: "COFFEE" });
  });
});
