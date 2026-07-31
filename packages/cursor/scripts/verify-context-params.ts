#!/usr/bin/env tsx
/**
 * Throwaway verification probe for the context-parameter §4f design.
 *
 * Confirms:
 *   (A) a target model exposes a `context` parameter with variants,
 *   (B) Agent.create({ model: { id, params: [{id:"context",value:"1m"}] } }) succeeds,
 *   (C) Agent.create({ model: { id: `${baseId}-1m` } }) fails (composite id not recognised).
 *
 * Skips cleanly (exit 0) when CURSOR_API_KEY is unset — NOT run in CI.
 * Delete this file after recording findings.
 */
import { loadCursorSdk } from "../src/sdk-runtime.js";

interface Finding {
  step: string;
  status: "ok" | "error" | "skip";
  detail?: unknown;
}

async function main(): Promise<void> {
  const apiKey = process.env.CURSOR_API_KEY?.trim();
  const findings: Finding[] = [];

  if (!apiKey) {
    console.log("[skip] CURSOR_API_KEY not set — verification probe skipped.");
    process.exit(0);
  }

  const sdk = await loadCursorSdk();

  // (A) Confirm a target model has a context parameter + variants
  const items = await sdk.Cursor.models.list({ apiKey });
  const TARGET_CANDIDATES = ["claude-opus-5", "gpt-5.4", "gpt-5.5"];
  const target =
    items.find(
      (m) =>
        TARGET_CANDIDATES.includes(m.id) &&
        m.parameters?.some((p) => p.id === "context"),
    ) ?? items.find((m) => m.parameters?.some((p) => p.id === "context"));

  if (!target) {
    findings.push({
      step: "A.find-target",
      status: "error",
      detail: "No model with a context parameter found.",
    });
    console.log(JSON.stringify(findings, null, 2));
    process.exit(0);
  }

  findings.push({
    step: "A.context-param",
    status: "ok",
    detail: {
      id: target.id,
      parameterIds: target.parameters?.map((p) => p.id),
      variantCount: target.variants?.length,
      contextValues: target.parameters
        ?.find((p) => p.id === "context")
        ?.values?.map((v) => v.value),
    },
  });

  const baseId = target.id;

  // (B) Agent.create with params-based context selection
  try {
    const agent = await sdk.Agent.create({
      apiKey,
      model: { id: baseId, params: [{ id: "context", value: "1m" }] },
      mode: "agent",
      local: { cwd: process.cwd() },
    });
    const run = await agent.send("Say OK");
    const result = await run.wait();
    findings.push({
      step: "B.params-context-1m",
      status: "ok",
      detail: { status: result.status, usage: result.usage },
    });
    agent.close();
  } catch (err) {
    findings.push({
      step: "B.params-context-1m",
      status: "error",
      detail: err instanceof Error ? err.message : String(err),
    });
  }

  // (C) Agent.create with composite -1m id
  try {
    const agent = await sdk.Agent.create({
      apiKey,
      model: { id: `${baseId}-1m` },
      mode: "agent",
      local: { cwd: process.cwd() },
    });
    const run = await agent.send("Say OK");
    const result = await run.wait();
    findings.push({
      step: "C.composite-id-1m",
      status: "ok",
      detail: {
        note: "Composite id was ACCEPTED (unexpected — server may alias)",
        status: result.status,
      },
    });
    agent.close();
  } catch (err) {
    findings.push({
      step: "C.composite-id-1m",
      status: "error",
      detail: {
        note: "Composite id REJECTED (expected — confirms params-based selection is required)",
        message: err instanceof Error ? err.message : String(err),
      },
    });
  }

  console.log(JSON.stringify(findings, null, 2));
  process.exit(0);
}

main().catch((err: unknown) => {
  console.error("Verification probe failed:", err);
  process.exit(1);
});
