/**
 * Lazy-load seam for `@cursor/sdk`.
 *
 * Every other module in this package imports the SDK via `loadCursorSdk()`
 * so that tests can inject fakes (except sdk-runtime.test.ts, which uses
 * the real SDK).
 */

export type CursorSdkModule = typeof import("@cursor/sdk");

export async function loadCursorSdk(): Promise<CursorSdkModule> {
  return import("@cursor/sdk");
}
