/**
 * HTTP/1.1 configuration for Cursor SDK.
 *
 * `PI_CURSOR_HTTP_1_1` escape hatch — when set to a truthy value, configures
 * the Cursor SDK to use HTTP/1.1 for agent requests (useful behind proxies
 * that don't support HTTP/2).
 */

import { loadCursorSdk, type CursorSdkModule } from "./sdk-runtime.js";

let configured = false;

/**
 * Read `PI_CURSOR_HTTP_1_1` from the environment.
 * Returns `true` for any truthy value that is NOT "0", "false", or "off".
 */
export function shouldUseHttp1(): boolean {
  const raw = process.env.PI_CURSOR_HTTP_1_1?.trim().toLowerCase();
  if (!raw || raw === "0" || raw === "false" || raw === "off") return false;
  return true;
}

/**
 * Idempotent configuration of `Cursor.configure({ local: { useHttp1ForAgent } })`.
 *
 * Calls the SDK exactly once (guarded by a module-level flag). Pass a custom
 * `loadSdk` for testing; defaults to the real `loadCursorSdk()`.
 */
export async function applyHttp1Config(
  loadSdk?: () => Promise<CursorSdkModule>,
): Promise<void> {
  if (configured) return;
  const sdk = await (loadSdk ?? loadCursorSdk)();
  sdk.Cursor.configure({ local: { useHttp1ForAgent: shouldUseHttp1() } });
  configured = true;
}

/**
 * Reset the idempotency flag — for use in tests only.
 */
export function __resetHttp1ConfigForTests(): void {
  configured = false;
}
