/**
 * Store repository (guest mode).
 * The guest-only schema (store/schema.ts) has only api_keys + schema_versions.
 * Account/token/rate-limit/login-failure helpers were removed with the
 * multi-account apparatus (M5). api_keys helpers live in store/api-keys.ts.
 * This module is retained as an extension point.
 */
export {};
