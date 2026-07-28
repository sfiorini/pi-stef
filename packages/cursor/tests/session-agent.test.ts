import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  acquireSessionAgent,
  disposeAllSessionAgents,
  __resetSessionAgentPoolForTests,
  type ModelSelection,
} from "../src/session-agent.js";

// Minimal fakes for the SDK seam
interface FakeAgent {
  id: string;
  close: ReturnType<typeof vi.fn>;
}
function fakeAgent(id: string): FakeAgent {
  return { id, close: vi.fn().mockResolvedValue(undefined) };
}

function makeFakeLoadSdk(agentMap: Map<string, FakeAgent>) {
  return async () => ({
    Agent: {
      create: vi.fn(async (opts: { apiKey: string; model: { id: string } }) => {
        const id = `agent:${opts.apiKey.slice(0, 8)}:${opts.model.id}`;
        if (!agentMap.has(id)) agentMap.set(id, fakeAgent(id));
        return agentMap.get(id)!;
      }),
    },
    Cursor: { configure: vi.fn() },
  });
}

const baseOpts = {
  apiKey: "crsr_abcdef1234567890deadbeef",
  modelSelection: { id: "claude-sonnet-4-20250514" },
  cwd: "/tmp/test",
  scopeKey: "default",
  toolNames: ["read_file", "write_file"],
};

describe("session-agent", () => {
  beforeEach(() => {
    __resetSessionAgentPoolForTests();
  });

  it("reuses same wrapper after release (createAgent called once)", async () => {
    const agents = new Map<string, FakeAgent>();
    const loadSdk = makeFakeLoadSdk(agents);
    const createAgent = vi.fn(async (sdk: unknown, opts: { apiKey: string; model: ModelSelection; mode: string; local: { cwd: string; enableAgentRetries: boolean } }) => {
      const s = sdk as { Agent: { create: (o: any) => Promise<any> } };
      return s.Agent.create(opts);
    });

    const r1 = await acquireSessionAgent(baseOpts, { loadSdk, createAgent });
    r1.release();

    const r2 = await acquireSessionAgent(baseOpts, { loadSdk, createAgent });

    expect(r1.session).toBe(r2.session); // same wrapper after release+reuse
    expect(createAgent).toHaveBeenCalledOnce();
    r2.release();
  });

  it("release+reuse: after release, acquire returns the same wrapper", async () => {
    const agents = new Map<string, FakeAgent>();
    const loadSdk = makeFakeLoadSdk(agents);

    const r1 = await acquireSessionAgent(baseOpts, { loadSdk });
    r1.release();

    const r2 = await acquireSessionAgent(baseOpts, { loadSdk });
    expect(r1.session).toBe(r2.session);
    r2.release();
  });

  it("different modelSelection → new agent", async () => {
    const agents = new Map<string, FakeAgent>();
    const loadSdk = makeFakeLoadSdk(agents);

    const r1 = await acquireSessionAgent(baseOpts, { loadSdk });
    const r2 = await acquireSessionAgent(
      { ...baseOpts, modelSelection: { id: "gpt-4o" } },
      { loadSdk },
    );

    expect(r1.session).not.toBe(r2.session);
    expect(r1.session.agent).not.toBe(r2.session.agent);
    r1.release();
    r2.release();
  });

  it("disposeAll → next acquire creates a new agent", async () => {
    const agents = new Map<string, FakeAgent>();
    const loadSdk = makeFakeLoadSdk(agents);

    const r1 = await acquireSessionAgent(baseOpts, { loadSdk });
    r1.release();

    disposeAllSessionAgents();

    const r2 = await acquireSessionAgent(baseOpts, { loadSdk });
    expect(r1.session).not.toBe(r2.session);
    // Old bridge should have been rejected
    r2.release();
  });

  it("toolNames order-insensitive ([\"a\",\"b\"] == [\"b\",\"a\"])", async () => {
    const agents = new Map<string, FakeAgent>();
    const loadSdk = makeFakeLoadSdk(agents);

    const r1 = await acquireSessionAgent(baseOpts, { loadSdk });
    r1.release();

    const r2 = await acquireSessionAgent(
      { ...baseOpts, toolNames: ["write_file", "read_file"] },
      { loadSdk },
    );

    expect(r1.session).toBe(r2.session);
    r2.release();
  });

  it("wrapper exposes coordinator, bridge, currentRun, lastSentMessageIndex, firstTurn", async () => {
    const agents = new Map<string, FakeAgent>();
    const loadSdk = makeFakeLoadSdk(agents);

    const { session, release } = await acquireSessionAgent(baseOpts, { loadSdk });

    expect(session.coordinator).toBeDefined();
    expect(typeof session.coordinator.handleDelta).toBe("function");
    expect(typeof session.coordinator.reset).toBe("function");
    expect(session.bridge).toBeDefined();
    expect(typeof session.bridge.pending).toBe("function");
    expect(typeof session.bridge.hasPending).toBe("function");
    expect(session.currentRun).toBeUndefined();
    expect(session.lastSentMessageIndex).toBe(0);
    expect(session.firstTurn).toBe(true);
    expect(session.modelSelection).toEqual(baseOpts.modelSelection);
    expect(session.apiKey).toBe(baseOpts.apiKey);

    release();
  });

  it("concurrent busy acquire → returns a DIFFERENT agent (createAgent called twice)", async () => {
    const agents = new Map<string, FakeAgent>();
    const loadSdk = makeFakeLoadSdk(agents);
    let agentSeq = 0;
    const createAgent = vi.fn(async (_sdk: unknown, _opts: { apiKey: string; model: ModelSelection }) => {
      agentSeq++;
      return { id: `agent-${agentSeq}`, close: vi.fn().mockResolvedValue(undefined), send: vi.fn() };
    });

    // First acquire — NOT released (busy)
    const r1 = await acquireSessionAgent(baseOpts, { loadSdk, createAgent });

    // Second acquire with same opts — should create a NEW agent
    const r2 = await acquireSessionAgent(baseOpts, { loadSdk, createAgent });

    // They must be DIFFERENT sessions
    expect(r1.session).not.toBe(r2.session);
    expect(r1.session.agent).not.toBe(r2.session.agent);

    // createAgent must have been called twice
    expect(createAgent).toHaveBeenCalledTimes(2);

    // Release both
    r1.release();
    r2.release();

    // disposeAll should clean up both
    disposeAllSessionAgents();
  });

  // S-M5-4: enableAgentRetries must be configurable (default true, SDK default unchanged)
  it("S-M5-4: enableAgentRetries=false passed through to the local block", async () => {
    const agents = new Map<string, FakeAgent>();
    const loadSdk = makeFakeLoadSdk(agents);
    const createAgent = vi.fn(async (sdk: unknown, opts: { apiKey: string; model: ModelSelection; mode: string; local: { cwd: string; enableAgentRetries: boolean } }) => {
      const s = sdk as { Agent: { create: (o: any) => Promise<any> } };
      return s.Agent.create(opts);
    });

    const { release } = await acquireSessionAgent(
      { ...baseOpts, enableAgentRetries: false },
      { loadSdk, createAgent },
    );

    expect(createAgent).toHaveBeenCalledOnce();
    expect(createAgent.mock.calls[0][1].local.enableAgentRetries).toBe(false);
    release();
  });

  it("S-M5-4: enableAgentRetries defaults to true when omitted", async () => {
    const agents = new Map<string, FakeAgent>();
    const loadSdk = makeFakeLoadSdk(agents);
    const createAgent = vi.fn(async (sdk: unknown, opts: { apiKey: string; model: ModelSelection; mode: string; local: { cwd: string; enableAgentRetries: boolean } }) => {
      const s = sdk as { Agent: { create: (o: any) => Promise<any> } };
      return s.Agent.create(opts);
    });

    const { release } = await acquireSessionAgent(baseOpts, { loadSdk, createAgent });

    expect(createAgent).toHaveBeenCalledOnce();
    expect(createAgent.mock.calls[0][1].local.enableAgentRetries).toBe(true);
    release();
  });

  // S-P3-2: enableAgentRetries is now a 6th pool-key dimension — acquisitions
  // that differ ONLY in retries must pool separately (distinct keys → distinct
  // wrappers), so a no-retry probe can't accidentally resume a retrying run.
  it("S-P3-2: distinct enableAgentRetries → distinct pool keys (no reuse)", async () => {
    const agents = new Map<string, FakeAgent>();
    const loadSdk = makeFakeLoadSdk(agents);

    // retries=true (default / omitted) — released back to the pool
    const r1 = await acquireSessionAgent(baseOpts, { loadSdk });
    r1.release();

    // Same opts but retries=false — must NOT reuse the retries=true wrapper.
    // (Wrapper identity is the real pool-key signal here: the fake SDK dedupes
    // the underlying agent by apiKey+model, so we assert on the wrapper, not
    // the agent object.)
    const r2 = await acquireSessionAgent(
      { ...baseOpts, enableAgentRetries: false },
      { loadSdk },
    );

    expect(r1.session).not.toBe(r2.session);
    r2.release();
  });

  it("S-P3-2: same enableAgentRetries (both omitted/true) → still reuses", async () => {
    const agents = new Map<string, FakeAgent>();
    const loadSdk = makeFakeLoadSdk(agents);

    const r1 = await acquireSessionAgent(baseOpts, { loadSdk });
    r1.release();
    // Explicit true must pool with omitted (both normalize to true)
    const r2 = await acquireSessionAgent(
      { ...baseOpts, enableAgentRetries: true },
      { loadSdk },
    );

    expect(r1.session).toBe(r2.session);
    r2.release();
  });
});
