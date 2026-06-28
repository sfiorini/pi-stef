export type ProviderKind = "brokerage" | "retirement" | "banking" | "crypto";

export interface Credentials { [key: string]: string }
export interface Session { providerId: string; expiresAt?: number; creds?: Credentials }

export interface RawAccount { providerAccountId: string; kind: ProviderKind; name: string; maskLast4?: string; currency: string }
export interface RawHolding {
  symbol: string; quantity: number; avgCost?: number; assetClass: string; subclass?: string;
  lots?: { openDate: number; qty: number; costBasis: number }[];
}
export interface RawTxn { id: string; date: number; symbol?: string; qty?: number; price?: number; type: string; fees?: number }
export interface RawBalance { cash: number; marketValue: number; asOf: number }

export interface ProviderAdapter {
  readonly kind: ProviderKind;
  readonly providerId: string;
  authenticate(creds: Credentials): Promise<Session>;
  listAccounts(s: Session): Promise<RawAccount[]>;
  getHoldings(s: Session, accountId: string): Promise<RawHolding[]>;
  getTransactions(s: Session, accountId: string, since?: number): Promise<RawTxn[]>;
  getBalances(s: Session, accountId: string): Promise<RawBalance>;
}
