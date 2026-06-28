export const CRYPTO_PREFIX = "CRYPTO:";

export function canonicalSymbol(rawSymbol: string, assetClass: string): string {
  const s = rawSymbol.trim().toUpperCase();
  if (assetClass === "crypto") return `${CRYPTO_PREFIX}${s}`;
  return s; // equities/etfs/mutual funds: plain uppercased ticker; CUSIP→ticker mapping added in M4
}

export function isCrypto(symbol: string): boolean {
  return symbol.startsWith(CRYPTO_PREFIX);
}
