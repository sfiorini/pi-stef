import { z } from "@hono/zod-openapi";

// ============================================================================
// Shared envelope schemas
// ============================================================================

export const errorResponse = z.object({
  ok: z.literal(false),
  error: z.object({
    code: z.string(),
    message: z.string(),
  }),
});

export function okEnvelope<T extends z.ZodTypeAny>(dataSchema: T) {
  return z.object({
    ok: z.literal(true),
    data: dataSchema,
  });
}

// ============================================================================
// Domain schemas
// ============================================================================

export const holdingSchema = z.object({
  account_id: z.string(),
  symbol: z.string(),
  quantity: z.number(),
  avg_cost: z.number().nullable().optional(),
  asset_class: z.string(),
  subclass: z.string().nullable().optional(),
  price: z.number().nullable().optional(),
  security_type: z.string().nullable().optional(),
  market_value: z.number().optional(),
  gain_loss: z.number().nullable().optional(),
  as_of: z.number(),
});

export const accountSchema = z.object({
  id: z.string(),
  provider_id: z.string(),
  kind: z.string(),
  name: z.string(),
  mask_last4: z.string().nullable().optional(),
  currency: z.string().optional(),
  total_value: z.number().optional(),
  holdings: z.array(holdingSchema),
});

export const goalSchema = z.object({
  id: z.string(),
  name: z.string(),
  targetAllocation: z.record(z.string(), z.number()),
  riskLimits: z.record(z.string(), z.number()),
  horizon_years: z.number().nullable().optional(),
});

export const suggestionSchema = z.object({
  id: z.string(),
  created_at: z.number(),
  market_session: z.string(),
  kind: z.string(),
  payload: z.unknown(),
  status: z.string(),
});

export const priceRowSchema = z.object({
  symbol: z.string(),
  date: z.number(),
  close: z.number(),
  source: z.string(),
});

export const driftRowSchema = z.object({
  class: z.string(),
  currentPct: z.number(),
  targetPct: z.number(),
  deltaPct: z.number(),
  value: z.number(),
});

// ============================================================================
// Per-endpoint response schemas
// ============================================================================

export const healthResponse = okEnvelope(
  z.object({
    status: z.string(),
    uptimeS: z.number(),
  }),
);

export const marketStatusResponse = okEnvelope(
  z.object({
    session: z.string(),
    timestamp: z.number(),
  }),
);

export const holdingsResponse = okEnvelope(
  z.object({
    accounts: z.array(accountSchema),
  }),
);

export const netWorthResponse = okEnvelope(
  z.object({
    netWorth: z.number(),
    accountCount: z.number(),
  }),
);

export const allocationResponse = okEnvelope(
  z.object({
    allocation: z.record(z.string(), z.number()),
    totalValue: z.number(),
  }),
);

export const driftResponse = okEnvelope(
  z.object({
    drift: z.array(driftRowSchema),
  }),
);

export const historyResponse = okEnvelope(
  z.object({
    history: z.array(priceRowSchema),
  }),
);

export const goalsListResponse = okEnvelope(
  z.object({
    goals: z.array(goalSchema),
  }),
);

export const suggestionsListResponse = okEnvelope(
  z.object({
    suggestions: z.array(suggestionSchema),
  }),
);

// POST response schemas

export const importResponse = okEnvelope(
  z.object({
    message: z.string(),
    filePath: z.string(),
    accounts: z.number(),
    holdings: z.number(),
    transactions: z.number(),
    errors: z.number(),
  }),
);

export const syncResponse = okEnvelope(
  z.object({
    message: z.string(),
    session: z.string(),
    accountsIngested: z.number(),
    holdingsIngested: z.number(),
    pricesUpdated: z.number(),
    suggestionsCreated: z.number(),
    resolvedCredentials: z.record(z.string(), z.record(z.string(), z.string())).optional(),
  }),
);

export const upsertGoalResponse = okEnvelope(
  z.object({
    id: z.string(),
  }),
);

export const dismissResponse = okEnvelope(
  z.object({
    dismissed: z.string(),
  }),
);

export const exportJsonResponse = okEnvelope(
  z.object({
    accounts: z.array(z.unknown()),
    holdings: z.array(z.unknown()),
    transactions: z.array(z.unknown()),
    balances: z.array(z.unknown()),
    goals: z.array(z.unknown()),
    suggestions: z.array(z.unknown()),
  }),
);
