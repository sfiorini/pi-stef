import type { DeploymentConfig } from "./types";

/**
 * Maps a validated DeploymentConfig to the shape Pi's registerProvider expects.
 *
 * baseUrl is passed verbatim. Pi's providers determine the final request URL:
 * - openai-completions passes baseUrl to the OpenAI SDK as baseURL; the SDK
 *   appends /chat/completions. Recommended Azure Foundry shape:
 *   https://<resource>.services.ai.azure.com/openai/v1/
 * - azure-openai-responses normalizes to <host>/openai/v1 for whitelisted
 *   Azure hosts.
 *
 * The validator enforces api-appropriate baseUrl shapes before this mapping.
 */
export function toProviderConfig(deployment: DeploymentConfig) {
  return {
    name: deployment.name,
    baseUrl: deployment.baseUrl,
    apiKey: deployment.apiKeyEnv,
    api: deployment.api,
    authHeader: deployment.authHeader ?? true,
    ...(deployment.headers ? { headers: deployment.headers } : {}),
    models: deployment.models.map((model) => ({ ...model })),
  };
}
