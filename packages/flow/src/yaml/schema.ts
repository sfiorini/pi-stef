import { Type, type Static } from "@sinclair/typebox";

export const AgentDef = Type.Object(
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

export const ArtifactSpec = Type.Object(
  { file: Type.String(), template: Type.Optional(Type.String()) },
  { additionalProperties: false },
);

export const SlugSpec = Type.Object(
  {
    from: Type.String(), // "input" | a prior publish name
    prefix: Type.Optional(Type.Union([Type.Literal("date"), Type.Literal("none")])),
  },
  { additionalProperties: false },
);

export const PhaseOutputs = Type.Object(
  {
    slug: Type.Optional(SlugSpec),
    dir: Type.Optional(Type.String()),
    artifacts: Type.Optional(Type.Array(ArtifactSpec)),
    assert: Type.Optional(Type.Array(Type.String())),
    publish: Type.Optional(Type.Record(Type.String(), Type.String())),
  },
  { additionalProperties: false },
);

export const PhaseInputs = Type.Object(
  {
    require: Type.Optional(Type.Array(Type.String())),
    inject: Type.Optional(Type.Array(Type.String())),
  },
  { additionalProperties: false },
);

export const PhaseDef = Type.Object(
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
    questions: Type.Optional(Type.String()),
    max_rounds: Type.Optional(Type.Integer()),
    // Contract layer (spec §5): declarative per-phase I/O the engine enforces.
    inputs: Type.Optional(PhaseInputs),
    outputs: Type.Optional(PhaseOutputs),
    worktree: Type.Optional(
      Type.Union([Type.Literal("none"), Type.Literal("prepare"), Type.Literal("finalize")]),
    ),
  },
  { additionalProperties: false },
);

export const LoopDef = Type.Object(
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

export const GroupDef = Type.Object(
  { phases: Type.Array(Type.String(), { minItems: 2 }) },
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
    groups: Type.Optional(Type.Record(Type.String(), GroupDef)),
  },
  { additionalProperties: false },
);

export type FlowYaml = Static<typeof FlowYamlSchema>;

// Co-exported type alias (same name as the schema value — legal, separate
// namespaces) so consumers can use PhaseDef as a type as well as a value.
export type PhaseDef = Static<typeof PhaseDef>;
