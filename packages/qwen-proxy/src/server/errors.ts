export function ok<T>(data: T) {
  return { ok: true as const, data };
}

export function fail(code: string, message: string) {
  return { ok: false as const, error: { code, message } };
}
