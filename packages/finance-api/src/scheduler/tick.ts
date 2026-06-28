import type Database from "better-sqlite3";
import type { AdapterRegistry, IngestCreds } from "../ingest/registry";
import { runIngest } from "../ingest/registry";
import { classifySession, type Session } from "../market/session";
import { fetchClose } from "../market/prices";
import { listHoldings, listAccounts, insertSuggestion, listGoals } from "../store/repo";
import { computeDrift, type HoldingValued } from "../quant/drift";
import { computeRebalance } from "../quant/rebalance";
import { checkRisk } from "../quant/risk";
// DCA not used until config is stored in schema
import { buildSuggestions } from "../quant/suggestions";
import { isCrypto } from "../store/symbols";
import type { Logger } from "../server/logger";

export interface TickDeps {
  db: Database.Database;
  registry: AdapterRegistry;
  creds: IngestCreds;
  fetcher?: typeof fetch;
  log?: Logger;
  now?: number;
  dataFeed?: "stooq" | "yfinance";
}

export interface TickResult {
  session: Session;
  accountsIngested: number;
  holdingsIngested: number;
  pricesUpdated: number;
  suggestionsCreated: number;
  errors: number;
}

export async function runTick(deps: TickDeps): Promise<TickResult> {
  const { db, registry, creds, log } = deps;
  const now = deps.now ?? Date.now();
  const fetcher = deps.fetcher ?? fetch;

  // Classify current market session
  const session = classifySession(new Date(now));
  log?.info("tick start", { session, now });

  // Ingest data from providers
  const ingestResult = await runIngest(db, registry, creds, log);
  log?.info("ingest complete", ingestResult);

  // Refresh prices for held symbols
  let pricesUpdated = 0;
  const accounts = listAccounts(db);
  const symbols = new Set<string>();
  for (const a of accounts) {
    const holdings = listHoldings(db, a.id);
    for (const h of holdings) {
      symbols.add(h.symbol);
    }
  }

  // On closed sessions, only refresh crypto prices
  const symbolsToRefresh = session === "closed"
    ? [...symbols].filter(isCrypto)
    : [...symbols];

  for (const symbol of symbolsToRefresh) {
    try {
      const close = await fetchClose(symbol, { fetcher, feed: deps.dataFeed });
      // Store price
      db.prepare("INSERT OR REPLACE INTO prices (symbol, date, close, source) VALUES (?, ?, ?, ?)")
        .run(symbol, Math.floor(now / 86400000), close, "tick");
      pricesUpdated++;
    } catch (err) {
      log?.warn("price fetch failed", { symbol, error: err instanceof Error ? err.message : String(err) });
    }
  }

  // Run quant engine
  const holdingsValued: HoldingValued[] = [];
  for (const a of accounts) {
    const holdings = listHoldings(db, a.id);
    for (const h of holdings) {
      const priceRow = db.prepare("SELECT close FROM prices WHERE symbol=? ORDER BY date DESC LIMIT 1").get(h.symbol) as { close: number } | undefined;
      const price = priceRow?.close ?? h.avg_cost ?? 0;
      holdingsValued.push({
        symbol: h.symbol,
        assetClass: h.asset_class,
        quantity: h.quantity,
        price,
      });
    }
  }

  // Get goals for target allocation
  const goals = listGoals(db);
  const targetAllocation = goals.length > 0 ? JSON.parse(goals[0].target_allocation) : {};
  const riskLimits = goals.length > 0 ? JSON.parse(goals[0].risk_limits) : {};

  // Compute drift
  const drift = computeDrift(holdingsValued, { targetAllocation });

  // Compute rebalance
  const rebalance = computeRebalance(holdingsValued, { targetAllocation }, {
    cashAvailable: 0, // TODO: get from balances
    minTradeDollars: 10,
  });

  // Check risk
  const risk = checkRisk(holdingsValued, { riskLimits, cashAvailable: 0 });

  // Check DCA - only if goals have DCA config (skip hardcoded defaults)
  // For now, skip DCA suggestions until DCA config is stored in the schema
  const dcaResults: { due: boolean; amount: number; nextDueAt: number }[] = [];

  // Build suggestions
  const suggestions = buildSuggestions({
    drift,
    rebalance,
    risk,
    dca: dcaResults,
    session,
    now,
  });

  // Persist suggestions
  let suggestionsCreated = 0;
  for (const s of suggestions) {
    insertSuggestion(db, {
      id: s.id,
      created_at: s.createdAt,
      market_session: s.marketSession,
      kind: s.kind,
      payload: JSON.stringify(s.payload),
      status: "pending",
    });
    suggestionsCreated++;
  }

  // Persist market session snapshot
  const sessionDate = new Date(now).toISOString().split("T")[0];
  db.prepare("INSERT OR REPLACE INTO market_sessions (date, session, snapshot) VALUES (?, ?, ?)")
    .run(sessionDate, session, JSON.stringify({
      timestamp: now,
      accountsIngested: ingestResult.accounts,
      holdingsIngested: ingestResult.holdings,
      pricesUpdated,
      suggestionsCreated,
      errors: ingestResult.errors,
    }));

  log?.info("tick complete", {
    session,
    accountsIngested: ingestResult.accounts,
    holdingsIngested: ingestResult.holdings,
    pricesUpdated,
    suggestionsCreated,
    errors: ingestResult.errors,
  });

  return {
    session,
    accountsIngested: ingestResult.accounts,
    holdingsIngested: ingestResult.holdings,
    pricesUpdated,
    suggestionsCreated,
    errors: ingestResult.errors,
  };
}
