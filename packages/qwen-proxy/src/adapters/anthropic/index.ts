/**
 * Anthropic-compatible route barrel.
 *
 * Mounts the Anthropic-compatible sub-router under /v1:
 *   - /v1/messages
 *
 * The auth gate is mounted upstream in app.ts (not here).
 */

export { anthropicRoutes, type AnthropicRouteDeps, buildAnthropicMessage } from "./messages";
export { streamAnthropicEvents, type StreamAnthropicEventsOpts } from "./events";
export { anthropicError, anthropicErrorType } from "./errors";
