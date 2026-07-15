import { Type, type Static } from "@sinclair/typebox";

const AgentDef = Type.Object(
  {
    tools: Type.Optional(Type.Array(Type.String())),
    model: Type.Optional(Type.String()),
    thinking: Type.Optional(
      Type.Union([
        Type.Literal("off"),
        Type.Literal("minimal"),
        Type.Literal("low"),
        Type.Literal("medium"),
        Type.Literal("high"),
        Type.Literal("xhigh"),
        Type.Literal("max"),
      ]),
    ),
    isolated: Type.Optional(Type.Boolean()),
    schema: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  },
  { additionalProperties: false },
);

const PhaseDef = Type.Object(
  {
    id: Type.String(),
    agent: Type.Optional(Type.String()),
    skill: Type.Optional(Type.String()),
    raw: Type.Optional(Type.String()),
    prompt: Type.Optional(Type.String()),
    fanout: Type.Optional(Type.String()),
    verify: Type.Optional(Type.String()),
    threshold: Type.Optional(Type.Number()),
    in: Type.Optional(Type.Union([Type.String(), Type.Array(Type.String())])),
    out: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

const LoopDef = Type.Object(
  {
    until_dry: Type.Optional(Type.Boolean()),
    until: Type.Optional(Type.Literal("approved")),
    fail_on: Type.Optional(
      Type.Array(
        Type.Union([
          Type.Literal("P0"),
          Type.Literal("P1"),
          Type.Literal("P2"),
          Type.Literal("P3"),
        ]),
      ),
    ),
    max_rounds: Type.Optional(Type.Integer()),
    consecutive_empty: Type.Optional(Type.Integer()),
    dedup_key: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

export const FlowYamlSchema = Type.Object(
  {
    name: Type.String(),
    description: Type.String(),
    input: Type.Union([
      Type.Literal("prompt"),
      Type.Literal("md-file"),
      Type.Literal("prd"),
      Type.Literal("jira"),
    ]),
    agents: Type.Record(Type.String(), AgentDef),
    phases: Type.Array(PhaseDef, { minItems: 1 }),
    loops: Type.Optional(Type.Record(Type.String(), LoopDef)),
  },
  { additionalProperties: false },
);

export type FlowYaml = Static<typeof FlowYamlSchema>;
