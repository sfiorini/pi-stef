import type { Context, Model } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { BridgeHandle } from "../src/bridge";
import {
  __testInternals,
  createCursorNativeStream,
  setBridgeFactoryForTests,
  stopProxy,
} from "../src/proxy";

const noopMetricEmitter = () => undefined;
__testInternals.setMetricEmitterForTests(noopMetricEmitter);

function makeCursorModel(id = "gpt-5.4"): Model<"cursor-native"> {
  return {
    id,
    name: id,
    api: "cursor-native",
    provider: "cursor",
    baseUrl: "https://api2.cursor.sh",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200_000,
    maxTokens: 64_000,
  };
}

function makeUserContext(text = "hello"): Context {
  return { messages: [{ role: "user", content: text, timestamp: Date.now() }] };
}

interface Captured {
  dataCb?: (chunk: Buffer) => void;
  closeCb?: (code: number) => void;
}

function authErrorHandle(captured: Captured): BridgeHandle {
  return {
    proc: { kill: () => true },
    alive: true,
    lastError: Object.assign(new Error("Connect error http_401: unauthorized"), {
      kind: "auth",
      retryable: true,
    }),
    write: () => {},
    end: () => {},
    onData: (cb) => {
      captured.dataCb = cb;
    },
    onClose: (cb) => {
      captured.closeCb = cb;
      queueMicrotask(() => cb(1));
    },
    onResponseEnd: () => {},
  };
}

function okHandle(captured: Captured): BridgeHandle {
  return {
    proc: { kill: () => true },
    alive: true,
    lastError: null,
    write: () => {},
    end: () => {},
    onData: (cb) => {
      captured.dataCb = cb;
    },
    onClose: (cb) => {
      captured.closeCb = cb;
      queueMicrotask(() => cb(0));
    },
    onResponseEnd: () => {},
  };
}

afterEach(() => {
  vi.useRealTimers();
  __testInternals.setMetricEmitterForTests(noopMetricEmitter);
  __testInternals.activeBridges.clear();
  __testInternals.conversationStates.clear();
  setBridgeFactoryForTests();
  stopProxy();
});

describe("S-34 auth-refresh retry", () => {
  it("auth-classified close triggers one token refresh and one re-run", async () => {
    const calls: { accessToken: string }[] = [];
    let callIdx = 0;
    let refreshCalls = 0;
    const factory = vi.fn((opts: { accessToken: string }): BridgeHandle => {
      const idx = callIdx++;
      calls.push({ accessToken: opts.accessToken });
      const captured: Captured = {};
      return idx === 0 ? authErrorHandle(captured) : okHandle(captured);
    });
    setBridgeFactoryForTests(factory);

    const streamSimple = createCursorNativeStream({
      getAccessToken: async () => "initial-token",
      refreshAccessToken: async () => {
        refreshCalls += 1;
        return "refreshed-token";
      },
    });

    const stream = streamSimple(makeCursorModel(), makeUserContext(), {});
    let result: { stopReason?: string } | undefined;
    try {
      result = await stream.result();
    } catch {
      /* terminal error also terminates the stream */
    }
    await new Promise((r) => setTimeout(r, 0));

    expect(calls).toHaveLength(2);
    expect(calls[0]!.accessToken).toBe("initial-token");
    expect(calls[1]!.accessToken).toBe("refreshed-token");
    expect(refreshCalls).toBe(1);
    expect(result?.stopReason ?? "stop").toBeTruthy();
  });

  it("auth retry is skipped after upstream data was delivered (no double billing)", async () => {
    const calls: { accessToken: string }[] = [];
    let refreshCalls = 0;
    const factory = vi.fn((opts: { accessToken: string }): BridgeHandle => {
      calls.push({ accessToken: opts.accessToken });
      const captured: Captured = {};
      const handle = authErrorHandle(captured);
      // Deliver upstream bytes BEFORE the auth close -> deliveredUpstreamData guard trips.
      const origOnClose = handle.onClose;
      handle.onClose = (cb) => {
        queueMicrotask(() => {
          captured.dataCb?.(Buffer.from("upstream-bytes"));
          cb(1);
        });
      };
      void origOnClose;
      return handle;
    });
    setBridgeFactoryForTests(factory);

    const streamSimple = createCursorNativeStream({
      getAccessToken: async () => "initial-token",
      refreshAccessToken: async () => {
        refreshCalls += 1;
        return "refreshed-token";
      },
    });

    const stream = streamSimple(makeCursorModel(), makeUserContext(), {});
    try {
      await stream.result();
    } catch {
      /* terminal error */
    }
    await new Promise((r) => setTimeout(r, 0));

    expect(calls).toHaveLength(1);
    expect(refreshCalls).toBe(0);
  });
});
