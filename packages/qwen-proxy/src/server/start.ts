import { serve } from "@hono/node-server";
import { createApp, type AppDeps } from "./app";

export interface StartServerDeps extends AppDeps {
  host?: string;
  port?: number;
}

export interface ServerHandle {
  close: () => void;
  port: number;
}

export async function startServer(deps: StartServerDeps): Promise<ServerHandle> {
  const host = deps.host ?? "127.0.0.1";
  const port = deps.port ?? 7790;

  const app = createApp(deps);

  return new Promise((resolve, reject) => {
    try {
      const server = serve(
        {
          fetch: app.fetch,
          hostname: host,
          port,
        },
        (info) => {
          deps.log?.info("server started", { host, port: info.port });
          resolve({
            close: () => server.close(),
            port: info.port,
          });
        },
      );

      server.on("error", (err: NodeJS.ErrnoException) => {
        if (err.code === "EADDRINUSE") {
          reject(new Error(`Port ${port} is already in use (EADDRINUSE)`));
        } else {
          reject(err);
        }
      });
    } catch (err) {
      reject(err);
    }
  });
}
