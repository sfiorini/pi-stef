export interface BandInput { currentPrice: number; allowedSlippagePct: number; lowerBandPct: number }
export interface Band { buyUpTo: number; addAtLower: number }

// Target prices are LIMIT/ACCEPTANCE bands derived from the user's rules — NOT forecasts.
export function acceptanceBand(input: BandInput): Band {
  return {
    buyUpTo: input.currentPrice * (1 + input.allowedSlippagePct / 100),
    addAtLower: input.currentPrice * (1 - input.lowerBandPct / 100),
  };
}
