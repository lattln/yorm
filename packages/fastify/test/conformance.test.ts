import { afterAll, beforeAll, describe, expect, it } from "vitest";
import Fastify from "fastify";
import { transportConformanceTests } from "@yorm/server";

import { yormFastify } from "../src/index.js";

transportConformanceTests(
  { describe, it, expect, beforeAll, afterAll },
  {
    name: "@yorm/fastify",
    async start(yorm, options) {
      const app = Fastify();
      await app.register(yormFastify(yorm, options), { prefix: "/yorm" });
      const baseUrl = await app.listen({ host: "127.0.0.1", port: 0 });
      return {
        baseUrl: `${baseUrl}/yorm`,
        stop: () => app.close(),
      };
    },
  },
);
