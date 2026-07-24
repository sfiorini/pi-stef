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
});
