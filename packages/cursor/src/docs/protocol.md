# Cursor protocol notes

This provider talks to Cursor's upstream HTTP/2 Connect/protobuf agent APIs. The generated schema in `proto/agent_pb.ts` is produced by `protoc-gen-es` for Cursor's `agent.v1` API and is intentionally committed so the extension can run without a build step inside Pi.

The agent API base URL is resolved from `PI_CURSOR_AGENT_URL`, `CURSOR_AGENT_URL`, Cursor CLI's `~/.cursor/cli-config.json` `serverConfigCache.agentUrlConfig`, or the fallback `https://agentn.us.api5.cursor.sh`.

## Runtime RPCs

- `POST /agent.v1.AgentService/Run` — streaming agent run used for chat completions, tool calls, checkpoints, and blob exchange.
- `POST /agent.v1.AgentService/GetUsableModels` — unary model discovery using generated protobuf schemas.
- `POST /aiserver.v1.AiService/AvailableModels` — legacy unary parameterized model discovery when available from Cursor's older API endpoint.

`h2-bridge.mjs` is a small Node HTTP/2 child process, retained only as a
deprecated `PI_CURSOR_TRANSPORT=child` escape hatch. The **default transport**
since 0.2.0 is an in-process Connect client (`src/connect-transport.ts`) over
Node's `http2` (HTTP/2) or `https` (HTTP/1.1 Connect when `PI_CURSOR_HTTP_1_1=1`).
It speaks the same Connect framing as the legacy child bridge — the child once
existed because some runtimes had unreliable `node:http2`, but Pi now requires
Node 22.19+ so the framing runs in-process. Stream errors are classified
(`transport-errors.ts`: auth / transient / fatal) and an HTTP/2 PING keepalive
is sent every 30s.

## Generated protobuf

`proto/agent_pb.ts` should be regenerated whenever Cursor changes the `agent.v1` schema used by the CLI. When updating it:

1. Extract the matching Cursor CLI protobuf schema for the client version used by `h2-bridge.mjs`'s `x-cursor-client-version` header.
2. Regenerate with `protoc-gen-es` compatible with `@bufbuild/protobuf` v2.
3. Run `npm test`, `npm run typecheck`, and live metadata verification when credentials are available.
4. Update this file with any new protocol assumptions.

The repository currently commits the generated TypeScript only; the upstream `.proto` source is not redistributed here.

## Manual wire helpers

`cursor-wire.ts` contains the remaining reverse-engineered wire helpers that do not yet have generated schemas in this repo:

- `AvailableModelsRequest` encoder:
  - field 5: `use_model_parameters = true`
  - field 7: `do_not_use_markdown = true`
- `AvailableModelsResponse` decoder:
  - response field 2: repeated model
  - model field 1: name
  - model field 10: supports images
  - model field 14: supports max mode
  - model field 15: context token limit
  - model field 16: max-mode context token limit
  - model field 17: client display name
  - model field 18: server model name
  - model field 19: supports non-max mode
  - model field 30: repeated parameterized variant
  - variant field 1: repeated `{ id, value }` parameter
  - variant field 2: display name
  - variant field 3: is max mode
  - variant field 4: is default max config
  - variant field 5: is default non-max config
  - variant field 8: display name outside picker
  - variant field 9: variant string representation
- MCP schema compatibility:
  - Cursor CLI's current `agent.v1.McpToolDefinition.input_schema` and `McpArgs.args` map values are `google.protobuf.Value` messages.
  - The committed generated `proto/agent_pb.ts` still exposes those length-delimited fields as `bytes`, so the provider writes and reads serialized `Value` bytes at those positions.
- `selectedContextBlob` encoder:
  - field 1: repeated root prompt blob ids
  - field 22: client name

Prefer replacing these helpers with generated schemas once the corresponding `.proto` definitions are available.
