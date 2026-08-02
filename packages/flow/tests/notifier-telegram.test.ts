import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer, type Server, type IncomingMessage } from "node:http";
import { spawn } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const scriptPath = join(pkgRoot, "bin", "notify-telegram.sh");

function startMockServer(): Promise<{ server: Server; port: number; requests: Array<{ url: string | undefined; body: string }> }> {
  return new Promise((resolve) => {
    const requests: Array<{ url: string | undefined; body: string }> = [];
    const server = createServer((req: IncomingMessage, res) => {
      let body = "";
      req.on("data", (chunk: Buffer) => { body += chunk.toString(); });
      req.on("end", () => {
        requests.push({ url: req.url, body });
        res.writeHead(200, { "content-type": "application/json" });
        res.end('{"ok":true}');
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (typeof addr === "object" && addr) resolve({ server, port: addr.port, requests });
    });
  });
}

function runScript(
  args: string[],
  env: Record<string, string>,
): Promise<{ exitCode: number; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn("bash", [scriptPath, ...args], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });
    child.on("close", (code: number | null) => {
      resolve({ exitCode: code ?? 1, stderr });
    });
  });
}

function parseForm(body: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [k, v] of new URLSearchParams(body)) {
    result[k] = v;
  }
  return result;
}

describe("notify-telegram.sh", () => {
  let server: Server;
  let port: number;
  let requests: Array<{ url: string | undefined; body: string }>;
  let apiBase: string;
  const baseEnv = { ...process.env } as Record<string, string>;

  beforeAll(async () => {
    const mock = await startMockServer();
    server = mock.server;
    port = mock.port;
    requests = mock.requests;
    apiBase = `http://127.0.0.1:${port}`;
  });

  afterAll(() => {
    server.close();
  });

  it("success: sends message and returns exit 0", async () => {
    const env = {
      ...baseEnv,
      TELEGRAM_BOT_TOKEN: "test-token",
      TELEGRAM_CHAT_ID: "test-chat",
      TELEGRAM_API_BASE_URL: apiBase,
    };
    const { exitCode, stderr } = await runScript(
      ["--message", "Hello from flow"],
      env,
    );
    expect(exitCode).toBe(0);
    const last = requests[requests.length - 1];
    expect(last).toBeDefined();
    expect(last!.url).toBe("/bottest-token/sendMessage");
    const form = parseForm(last!.body);
    expect(form.chat_id).toBe("test-chat");
    expect(form.text).toBe("Hello from flow");
  });

  it("missing TELEGRAM_BOT_TOKEN → exit 2, stderr: bot token is required", async () => {
    const env = {
      ...baseEnv,
      TELEGRAM_BOT_TOKEN: "",
      TELEGRAM_CHAT_ID: "test-chat",
      TELEGRAM_API_BASE_URL: apiBase,
    };
    const { exitCode, stderr } = await runScript(
      ["--message", "hi"],
      env,
    );
    expect(exitCode).toBe(2);
    expect(stderr).toContain("bot token is required");
  });

  it("missing TELEGRAM_CHAT_ID → exit 2, stderr: chat id is required", async () => {
    const env = {
      ...baseEnv,
      TELEGRAM_BOT_TOKEN: "test-token",
      TELEGRAM_CHAT_ID: "",
      TELEGRAM_API_BASE_URL: apiBase,
    };
    const { exitCode, stderr } = await runScript(
      ["--message", "hi"],
      env,
    );
    expect(exitCode).toBe(2);
    expect(stderr).toContain("chat id is required");
  });
});
