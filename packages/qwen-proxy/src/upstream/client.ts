/**
 * Upstream client types (guest mode).
 * The concrete client is GuestUpstreamClient (src/upstream/guest-client.ts).
 * Retained as the canonical import surface for the OpenAI/Anthropic adapters,
 * which depend on Pick<UpstreamClient, ...>.
 */
import type { OpenAiChatChunk, OpenAiChatCompletion, Model, ChatCompletionsBody } from "./types";
export type { OpenAiChatChunk, OpenAiChatCompletion, Model, ChatCompletionsBody } from "./types";

export interface UpstreamClient {
  listModels(bearer: string): Promise<Model[]>;
  chatCompletions(bearer: string, body: ChatCompletionsBody, proxy?: string): Promise<OpenAiChatCompletion> | AsyncIterable<OpenAiChatChunk>;
  deleteChats(bearer: string): Promise<void>;
}
