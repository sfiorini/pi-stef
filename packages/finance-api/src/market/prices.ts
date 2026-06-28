import { CRYPTO_PREFIX } from "../store/symbols";

export interface PriceDeps { fetcher?: typeof fetch; feed?: "stooq" | "yfinance" }

export async function fetchClose(symbol: string, deps: PriceDeps = {}): Promise<number> {
  const fetcher = deps.fetcher ?? ((u: string, i?: RequestInit) => fetch(u, i));

  if (symbol.startsWith(CRYPTO_PREFIX)) {
    const coin = symbol.slice(CRYPTO_PREFIX.length);
    const res = await fetcher(`https://api.coinbase.com/api/v3/brokerage/market/products/${coin}-USD/spot`, {});
    if (!res.ok) throw new Error(`coinbase price ${symbol} ${res.status}`);
    const body = (await res.json()) as { price: string };
    return Number(body.price);
  }

  const feed = deps.feed ?? "stooq";
  if (feed === "stooq") {
    const res = await fetcher(`https://stooq.com/q/l/?s=${symbol.toLowerCase()}&f=sd2t2ohlcv&h&e=csv`, {});
    if (!res.ok) throw new Error(`stooq ${symbol} ${res.status}`);
    const text = await res.text();
    const row = text.trim().split(/\r?\n/)[1]?.split(",") ?? [];
    const close = Number(row[4]);
    if (!Number.isFinite(close)) throw new Error(`stooq ${symbol}: no close`);
    return close;
  }
  throw new Error(`yfinance feed not implemented in v1 (symbol ${symbol})`);
}
