import { Type, type Static } from "@sinclair/typebox";

export const ConfigSchema = Type.Object(
  {
    reviewer: Type.Optional(
      Type.Object(
        {
          model: Type.Optional(
            Type.String({
              minLength: 1,
              description:
                "Model for the reviewer agent (e.g. 'anthropic/sonnet-4-6')",
            })
          ),
        },
        { additionalProperties: false }
      )
    ),
    explorer: Type.Optional(
      Type.Object(
        {
          model: Type.Optional(
            Type.String({
              minLength: 1,
              description:
                "Model for the explorer agent (e.g. 'anthropic/sonnet-4-6'). Falls back to parent model if not set.",
            })
          ),
        },
        { additionalProperties: false }
      )
    ),
  },
  { additionalProperties: false }
);

export type PairConfig = Static<typeof ConfigSchema>;

export interface ResolvedPairConfig {
  reviewer: {
    model: string | null;
  };
  explorer: {
    model: string | null;
  };
}

export const DEFAULT_CONFIG: ResolvedPairConfig = {
  reviewer: {
    model: null, // null = not configured, must ask user
  },
  explorer: {
    model: null, // null = not configured, inherit parent model
  },
};
