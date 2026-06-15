# @pi-stef/azure-foundry

Azure Foundry and Azure OpenAI deployments as native Pi providers — config-driven, JSONC support, validation.

## Overview

This package registers Azure Foundry and Azure OpenAI deployments as native Pi providers from a JSONC configuration file. Each deployment becomes a provider whose model IDs are selected as `<deployment-id>/<model-id>`.

Key features:
- Config-driven setup with JSONC support
- Two API modes: `openai-completions` and `azure-openai-responses`
- Custom headers support
- Multiple deployments per configuration
- Built-in validation and verification

## Install

```sh
pi install npm:@pi-stef/azure-foundry
```

Start Pi once after installing. On first load, the extension creates:

```text
~/.pi/azure-foundry/config.json
~/.pi/azure-foundry/config.schema.json
```

## Configuration

Edit `config.json`, uncomment or add a deployment, and export the bearer-token env var named by `apiKeyEnv`.

```bash
export AZURE_API_KEY=...
```

### Azure Foundry (openai-completions)

For Azure Foundry, use the modern OpenAI-compatible v1 endpoint:

```jsonc
{
  "id": "azure-foundry",
  "name": "Azure Foundry East US",
  "baseUrl": "https://<resource>.services.ai.azure.com/openai/v1/",
  "apiKeyEnv": "AZURE_API_KEY",
  "api": "openai-completions",
  "models": [
    {
      "id": "Kimi-K2.6",
      "name": "Kimi K2.6",
      "reasoning": false,
      "input": ["text"],
      "contextWindow": 128000,
      "maxTokens": 2048,
      "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 }
    }
  ]
}
```

### Azure OpenAI (azure-openai-responses)

Classic Azure OpenAI via `azure-openai-responses`:

```jsonc
{
  "id": "aoai-eastus",
  "name": "Azure OpenAI East US",
  "baseUrl": "https://my-aoai.openai.azure.com",
  "apiKeyEnv": "AZURE_OPENAI_API_KEY",
  "api": "azure-openai-responses",
  "models": [
    {
      "id": "o4-mini",
      "name": "o4-mini",
      "reasoning": true,
      "input": ["text"],
      "contextWindow": 200000,
      "maxTokens": 16000,
      "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 }
    }
  ]
}
```

For `azure-openai-responses`, Pi normalizes the URL to `<host>/openai/v1` and reads the API version from `AZURE_OPENAI_API_VERSION`, defaulting to `v1`. The host must end with `.openai.azure.com` or `.cognitiveservices.azure.com`.

## Config Reference

Top-level shape:

```jsonc
{
  "$schema": "./config.schema.json",
  "deployments": []
}
```

Deployment fields:

| Field | Required | Notes |
| --- | --- | --- |
| `id` | Yes | Provider id. Lowercase letters, numbers, and hyphens. |
| `name` | Yes | Display name. |
| `baseUrl` | Yes | `https://` endpoint. Rules depend on `api`. |
| `apiKeyEnv` | Yes | Env-var name containing the bearer token. The secret is not stored in config. |
| `api` | Yes | `openai-completions` or `azure-openai-responses`. |
| `authHeader` | No | Defaults to `true`. Set `false` only if custom headers carry auth. |
| `headers` | No | Map of header name to env-var name. Values must look like env-var names. |
| `models` | Yes | One or more model entries. |

## Multiple Deployments

```jsonc
{
  "deployments": [
    { "id": "foundry-east", "name": "Foundry East", "baseUrl": "https://east.services.ai.azure.com/openai/v1/", "apiKeyEnv": "AZURE_EAST_KEY", "api": "openai-completions", "models": [] },
    { "id": "foundry-west", "name": "Foundry West", "baseUrl": "https://west.services.ai.azure.com/openai/v1/", "apiKeyEnv": "AZURE_WEST_KEY", "api": "openai-completions", "models": [] },
    { "id": "aoai-eastus", "name": "AOAI East US", "baseUrl": "https://my-aoai.openai.azure.com", "apiKeyEnv": "AZURE_OPENAI_API_KEY", "api": "azure-openai-responses", "models": [] }
  ]
}
```

## Custom Headers

```jsonc
"headers": {
  "api-key": "AZURE_HEADER_KEY",
  "x-ms-useragent": "AZURE_USER_AGENT"
}
```

Header values are env-var names. Pi resolves them at request time. If an env var is missing, Pi sends the literal configured string as a fallback, so keep config values as env-var names rather than secrets.

## Verification

Run the package verifier after exporting the configured API key:

```bash
pnpm -F @pi-stef/azure-foundry verify
```

Use `PI_AZURE_FOUNDRY_CONFIG=/path/to/config.json` to verify a test config without touching the default file.

Common outputs:

| Output | Fix |
| --- | --- |
| `200` | The deployment is reachable. |
| `401` | Check the env var named by `apiKeyEnv`. |
| `404` | Check the model deployment id and base URL. |
| `timeout after 10s` | Check network access, proxy, and endpoint host. |

## Environment Variables

| Variable | Purpose |
| --- | --- |
| `AZURE_API_KEY` | Example bearer token env var for Azure Foundry deployments when `apiKeyEnv` is set to `AZURE_API_KEY`. |
| `PI_AZURE_FOUNDRY_CONFIG` | Override config path for tests or alternate profiles. |
| `PI_AZURE_FOUNDRY_DEBUG` | Set to `1` for debug logging. |
| `AZURE_OPENAI_API_VERSION` | Optional Pi-side version for `azure-openai-responses`; defaults to `v1`. |

## Troubleshooting

### Authentication Fails

Check the env var named by `apiKeyEnv` is exported and contains the correct bearer token.

### Model Not Found

Check the model deployment id and base URL. For `azure-openai-responses`, ensure the host ends with `.openai.azure.com` or `.cognitiveservices.azure.com`.

### Timeout

Check network access, proxy, and endpoint host. Use `PI_AZURE_FOUNDRY_DEBUG=1` for detailed logging.

## Remove

```sh
pi remove @pi-stef/azure-foundry
```

## Update

```sh
pi update @pi-stef/azure-foundry
```
