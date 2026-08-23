import { afterAll, beforeAll, describe, expect, it } from "vitest";
import express from "express";
import { transportConformanceTests } from "@yorm/server";

import { createExpressYorm } from "../src/index.js";

transportConformanceTests(
  { describe, it, expect, beforeAll, afterAll },
  {
    name: "@yorm/express",
    async start(yorm, options) {
      const app = express();
      const yormExpress = createExpressYorm(yorm, options);
      app.use("/yorm", yormExpress.router);
      const server = await new Promise<ReturnType<typeof app.listen>>((resolve) => {
        const started = app.listen(0, "127.0.0.1", () => resolve(started));
      });
      yormExpress.attachWebSocket(server, "/yorm");
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
