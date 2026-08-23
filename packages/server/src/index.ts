/**
 * @yorm/server — the framework-neutral YORM server: the REST route table and
 * the y-protocols collaboration endpoint, expressed against {@link YormRequest}
 * and {@link YormSocket} so `@yorm/hono`, `@yorm/fastify`, and `@yorm/express`
 * are thin adapters over one implementation.
 *
 * The server only sees `Yorm` interfaces from `@yorm/yjs` — it has no
 * dependency on any DB package. See packages/server/README.md.
 */
import type { Yorm } from "@yorm/yjs";

import { createHttpRoutes } from "./http/index.js";
import { createSessionCache } from "./shared.js";
import { createWebSocketEndpoint } from "./websocket/index.js";
import type { YormRoute, YormServerOptions, YormWebSocketEndpoint } from "./types.js";

export * from "./types.js";
export { guardCanonicalWrites } from "./websocket/index.js";
export { parsePolicy, policyFromQuery } from "./shared.js";
export type { SessionCache } from "./shared.js";
export * from "./conformance.js";

export const YORM_SERVER_VERSION = "0.1.0";

/** Everything an adapter mounts, sharing one session cache. */
export interface YormServer {
  routes: YormRoute[];
  websocket: YormWebSocketEndpoint;
}

/**
 * Builds the routes and the collaboration endpoint over a single session
 * cache — sharing it is what makes an HTTP `PUT` broadcast to the WebSocket
 * clients of the same document.
 */
export function createYormServer(yorm: Yorm, options: YormServerOptions = {}): YormServer {
  const sessions = createSessionCache(yorm, options);
  return {
    routes: createHttpRoutes(yorm, sessions, options),
    websocket: createWebSocketEndpoint(sessions, options),
  };
}
