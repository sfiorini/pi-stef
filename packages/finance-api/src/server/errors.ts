export function ok<T>(data: T) {
  return { ok: true as const, data };
}

export function fail(code: string, message: string) {
  return { ok: false as const, error: { code, message } };
}

export interface StalenessInfo {
  staleAt?: number | null;
  staleReason?: string | null;
}

export function withStaleness<T extends Record<string, unknown>>(data: T, stale?: StalenessInfo): T & { staleAt?: number | null; staleReason?: string | null } {
  return {
    ...data,
    staleAt: stale?.staleAt ?? null,
    staleReason: stale?.staleReason ?? null,
  };
}
