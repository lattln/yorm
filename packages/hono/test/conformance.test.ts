import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { serve } from "@hono/node-server";
import type { ServerType } from "@hono/node-server";
import { createNodeWebSocket } from "@hono/node-ws";
import { Hono } from "hono";
import { transportConformanceTests } from "@yorm/server";

import { createHonoYorm } from "../src/index.js";

transportConformanceTests(
  { describe, it, expect, beforeAll, afterAll },
  {
    name: "@yorm/hono",
    async start(yorm, options) {
      const app = new Hono();
      const { upgradeWebSocket, injectWebSocket } = createNodeWebSocket({ app });
      app.route("/yorm", createHonoYorm(yorm, { ...options, upgradeWebSocket }));
      const server = await new Promise<ServerType>((resolve) => {
        const started = serve({ fetch: app.fetch, port: 0 }, () => resolve(started));
      });
      injectWebSocket(server);
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      return {
        baseUrl: `http://127.0.0.1:${port}/yorm`,
        stop: () =>
          new Promise<void>((resolve, reject) => {
            server.close((error) => (error ? reject(error) : resolve()));
          }),
      };
    },
  },
);
