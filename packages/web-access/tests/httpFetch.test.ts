import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import { afterEach, describe, expect, it } from "vitest";

import { createGuardedHttpRequestPlan, fetchGuardedText } from "../src/fetch/httpFetch";
import type { WebAccessConfig } from "../src/types";

const serverClosers: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(serverClosers.splice(0).map((close) => close()));
});

const TEST_CONFIG: WebAccessConfig = {
  allowPrivateNetworks: true,
  fetchTimeoutMs: 1000,
  fetchMaxBytes: 512,
  maxBytes: 128,
  maxLines: 100,
  maxResults: 5,
  outputDir: "/tmp/sf-web-access-tests",
  profilesDir: "/tmp/sf-web-access-profiles",
  searchProviders: ["duckduckgo"],
  sensitiveQueryKeys: ["token"],
  userAgent: "sf-test",
};

describe("guarded HTTP request primitive", () => {
  it("builds an http/https request plan with a pinned public lookup", async () => {
    const plan = await createGuardedHttpRequestPlan("https://example.com/path?q=1", {
      lookup: async () => [{ address: "93.184.216.34", family: 4 }],
    });

    expect(plan.transport).toBe("https");
    expect(plan.url.href).toBe("https://example.com/path?q=1");
    expect(plan.resolvedAddress).toEqual({ address: "93.184.216.34", family: 4 });
    expect(typeof plan.lookup).toBe("function");
    expect(typeof plan.request).toBe("function");
  });

  it("rejects unsafe request targets before creating a request plan", async () => {
    await expect(
      createGuardedHttpRequestPlan("http://metadata.internal/", {
        lookup: async () => [{ address: "169.254.169.254", family: 4 }],
      }),
    ).rejects.toThrow(/blocked/i);
  });

  it("follows redirects through the same guarded request path", async () => {
    const { url } = await listen((request, response) => {
      if (request.url === "/redirect") {
        response.writeHead(302, { location: "/final" });
        response.end();
        return;
      }
      response.end("redirected");
    });

    const result = await fetchGuardedText(`${url}/redirect`, { config: TEST_CONFIG });

    expect(result.status).toBe(200);
    expect(result.text).toBe("redirected");
    expect(result.url).toBe(`${url}/final`);
  });

  it("uses fetchMaxBytes for the network body cap instead of the output cap", async () => {
    const { url } = await listen((_, response) => {
      response.end("x".repeat(TEST_CONFIG.maxBytes + 1));
    });

    await expect(fetchGuardedText(url, { config: TEST_CONFIG })).resolves.toMatchObject({
      status: 200,
      text: "x".repeat(TEST_CONFIG.maxBytes + 1),
    });
  });

  it("rejects responses that exceed the configured fetch body limit", async () => {
    const { url } = await listen((_, response) => {
      response.end("x".repeat(TEST_CONFIG.fetchMaxBytes + 1));
    });

    await expect(fetchGuardedText(url, { config: TEST_CONFIG })).rejects.toThrow(/exceeded.*fetchMaxBytes/i);
  });

  it("rejects immediately when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(fetchGuardedText("http://example.com", { config: TEST_CONFIG, signal: controller.signal })).rejects.toThrow(
      /aborted/i,
    );
  });

  it("rejects when the response stream errors before completion", async () => {
    const { url } = await listen((_, response) => {
      response.write("partial");
      response.destroy(new Error("stream failed"));
    });

    await expect(fetchGuardedText(url, { config: TEST_CONFIG })).rejects.toThrow(/stream|aborted|socket/i);
  });

  it("requests identity encoding so parser providers receive plain text", async () => {
    let acceptEncoding = "";
    const { url } = await listen((request, response) => {
      acceptEncoding = request.headers["accept-encoding"]?.toString() ?? "";
      response.end("plain");
    });

    await fetchGuardedText(url, { config: TEST_CONFIG });

    expect(acceptEncoding).toBe("identity");
  });
});

async function listen(
  handler: (request: IncomingMessage, response: ServerResponse) => void,
): Promise<{ close: () => Promise<void>; url: string }> {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Test server did not expose an address");
  }
  const close = () => closeServer(server);
  serverClosers.push(close);
  return {
    close,
    url: `http://127.0.0.1:${address.port}`,
  };
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}
