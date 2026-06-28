export type DataFeed = "stooq" | "yfinance";

export interface FinanceApiConfig {
  host: string;        // always 127.0.0.1
  port: number;        // default 7780
  dbPath: string;      // ~/.pi/sf/finance/finance.db
  secretsPath: string; // ~/.pi/sf/finance/secrets.json
  tokenPath: string;   // ~/.pi/sf/finance/token  (generated bearer token)
  dataFeed: DataFeed;
  timezone: string;    // default "America/New_York" (US market)
}
