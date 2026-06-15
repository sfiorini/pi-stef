// TS declaration for ./schema.mjs.
// Hand-maintained. When you change schema.mjs, update this file's shape.
// The drift test catches mismatches between CONFIG_SCHEMA and the TypeScript
// Config/DeploymentConfig/ModelConfig types at runtime, but does not catch
// mismatches with this declaration. Keep it in sync manually.
export const CONFIG_SCHEMA: {
  readonly $schema: string;
  readonly title: string;
  readonly type: "object";
  readonly required: readonly ["deployments"];
  readonly additionalProperties: false;
  readonly properties: {
    readonly $schema: { readonly type: "string" };
    readonly deployments: {
      readonly type: "array";
      readonly items: {
        readonly type: "object";
        readonly required: readonly ["id", "name", "baseUrl", "apiKeyEnv", "api", "models"];
        readonly additionalProperties: false;
        readonly properties: {
          readonly id: { readonly type: "string"; readonly minLength: 1; readonly pattern: string };
          readonly name: { readonly type: "string"; readonly minLength: 1 };
          readonly baseUrl: { readonly type: "string"; readonly pattern: string };
          readonly apiKeyEnv: { readonly type: "string"; readonly minLength: 1; readonly pattern: string };
          readonly api: { readonly type: "string"; readonly enum: readonly string[] };
          readonly authHeader: { readonly type: "boolean" };
          readonly headers: {
            readonly type: "object";
            readonly additionalProperties: { readonly type: "string"; readonly pattern: string };
          };
          readonly models: {
            readonly type: "array";
            readonly minItems: 1;
            readonly items: {
              readonly type: "object";
              readonly required: readonly string[];
              readonly additionalProperties: false;
              readonly properties: {
                readonly id: { readonly type: "string"; readonly minLength: 1 };
                readonly name: { readonly type: "string"; readonly minLength: 1 };
                readonly reasoning: { readonly type: "boolean" };
                readonly input: {
                  readonly type: "array";
                  readonly minItems: 1;
                  readonly items: { readonly type: "string"; readonly enum: readonly string[] };
                };
                readonly contextWindow: { readonly type: "integer"; readonly minimum: number };
                readonly maxTokens: { readonly type: "integer"; readonly minimum: number };
                readonly cost: {
                  readonly type: "object";
                  readonly required: readonly ["input", "output", "cacheRead", "cacheWrite"];
                  readonly additionalProperties: false;
                  readonly properties: Record<
                    "input" | "output" | "cacheRead" | "cacheWrite",
                    { readonly type: "number"; readonly minimum: number }
                  >;
                };
              };
            };
          };
        };
      };
    };
  };
};
