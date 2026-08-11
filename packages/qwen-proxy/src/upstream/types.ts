/** Shared upstream types — extracted from client.ts for cross-module reuse. */

export interface Model {
  id: string;
  object: "model";
  owned_by?: string;
}

/** Raw streaming chunk from the upstream OpenAI-compatible API. */
export interface OpenAiChatChunk {
  choices: {
    index?: number;
    delta?: {
      role?: string;
      content?: string;
      reasoning_content?: string;
      tool_calls?: unknown[];
    };
    finish_reason?: string | null;
  }[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  } | null;
}

/** Raw non-stream completion from the upstream OpenAI-compatible API. */
export interface OpenAiChatCompletion {
  id: string;
  object: "chat.completion";
  created: number;
  model: string;
  system_fingerprint?: string;
  choices: {
    index: number;
    message: {
      role: string;
      content: string;
      reasoning_content?: string;
      tool_calls?: unknown[];
    };
    finish_reason?: string;
  }[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  } | null;
}

/** Shared request body shape for chat completions. */
export interface ChatCompletionsBody {
  model: string;
  messages: { role: string; content: string }[];
  stream: boolean;
  enable_thinking?: boolean;
  thinking_budget?: number;
  tools?: unknown[];
  tool_choice?: unknown;
}
