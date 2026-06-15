export type Api = "openai-completions" | "azure-openai-responses";

export interface ModelConfig {
  id: string;
  name: string;
  reasoning: boolean;
  input: ("text" | "image")[];
  contextWindow: number;
  maxTokens: number;
  cost: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
  };
}

export interface DeploymentConfig {
  id: string;
  name: string;
  baseUrl: string;
  apiKeyEnv: string;
  api: Api;
  authHeader?: boolean;
  headers?: Record<string, string>;
  models: ModelConfig[];
}

export interface Config {
  $schema?: string;
  deployments: DeploymentConfig[];
}

export interface Issue {
  path: string;
  message: string;
}

export type Result<T> = { ok: true; value: T } | { ok: false; issues: Issue[] };
