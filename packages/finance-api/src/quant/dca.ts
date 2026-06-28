export interface DcaConfig { amount: number; cadence: "weekly" | "biweekly" | "monthly"; lastBuyAt?: number }
export interface DcaResult { due: boolean; amount: number; nextDueAt: number }

const MS_DAY = 86_400_000;
export function nextDcaBuy(cfg: DcaConfig, now: number): DcaResult {
  const interval = cfg.cadence === "weekly" ? 7 * MS_DAY : cfg.cadence === "biweekly" ? 14 * MS_DAY : 30 * MS_DAY;
  const last = cfg.lastBuyAt ?? now - interval; // if never bought, treat as due
  const nextDueAt = last + interval;
  return { due: now >= nextDueAt, amount: cfg.amount, nextDueAt };
}
