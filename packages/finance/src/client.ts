// HTTP client for finance-api service
// Maps operations to GET/POST methods per the M7 contract table

export const OP_METHOD: Record<string, "GET" | "POST"> = {
  market_status: "GET",
  get_holdings: "GET",
  get_net_worth: "GET",
  get_drift: "GET",
  get_allocation: "GET",
  list_goals: "GET",
  set_target: "POST",
  get_suggestions: "GET",
  dismiss_suggestion: "POST",
  sync_now: "POST",
  import_file: "POST",
  history: "GET",
  health: "GET",
  export: "POST",
};

export interface FinanceClientConfig {
  apiUrl: string;
  token: string;
}

export interface CallResult<T = unknown> {
  ok: boolean;
  data?: T;
  error?: { code: string; message: string };
  staleAt?: number | null;
  staleReason?: string | null;
}

export function createFinanceClient(config: FinanceClientConfig) {
  const { apiUrl, token } = config;

  async function callOp<T = unknown>(op: string, params?: Record<string, unknown>): Promise<T> {
    const method = OP_METHOD[op];
    if (!method) throw new Error(`Unknown operation: ${op}`);

    const url = new URL(`${apiUrl}/v1/${op.replace(/_/g, "-")}`);
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    };

    let body: string | undefined;
    if (method === "GET" && params) {
      for (const [key, value] of Object.entries(params)) {
        if (value !== undefined && value !== null) {
          url.searchParams.set(key, String(value));
        }
      }
    } else if (method === "POST" && params) {
      body = JSON.stringify(params);
    }

    let res: Response;
    try {
      res = await fetch(url.toString(), { method, headers, body });
    } catch (err) {
      throw new Error(`service_unavailable: ${err instanceof Error ? err.message : String(err)}`);
    }

    const json = await res.json() as CallResult<T>;
    if (!json.ok) {
      throw new Error(`${json.error?.code ?? "unknown"}: ${json.error?.message ?? "Unknown error"}`);
    }

    return json.data as T;
  }

  return { callOp };
}

export type FinanceClient = ReturnType<typeof createFinanceClient>;
