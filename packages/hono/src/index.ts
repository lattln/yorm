/**
 * @yorm/hono — the Hono transport adapter (PLAN.md Milestone 3, deliverable
 * 1): `app.route("/yorm", createHonoYorm(yorm))` turns any Hono app into a
 * YORM server.
 *
 * All behavior lives in [@yorm/server](../server/README.md); this module only
 * translates Hono's `Context` into a `YormRequest`, its `WSContext` into a
 * `YormSocket`, and the neutral `YormResponse` back into a `Response`.
 * See packages/hono/README.md for routes, options, and examples.
 */
import { Hono } from "hono";
import type { Context } from "hono";
import type { UpgradeWebSocket, WSContext, WSEvents, WSMessageReceive } from "hono/ws";
import type { Yorm } from "@yorm/yjs";
import { createYormServer } from "@yorm/server";
import type {
  HttpMethod,
  YormRequest,
  YormResponse,
  YormServerOptions,
  YormSocket,
  YormWebSocketEndpoint,
} from "@yorm/server";

export { guardCanonicalWrites } from "@yorm/server";
export type { WriteScope, YormRequest, YormServerOptions } from "@yorm/server";

export const YORM_HONO_VERSION = "0.1.0";

export interface HonoYormOptions extends YormServerOptions {
  /**
   * Runtime-specific WebSocket upgrader (e.g. `createNodeWebSocket(...)`
   * from `@hono/node-ws`, or Bun/Deno/Cloudflare equivalents). When
   * provided, {@link createHonoYorm} mounts `GET /ws/:type/:id` itself;
   * otherwise use {@link createHonoYormWebSocket} to mount it separately.
   */
  upgradeWebSocket?: UpgradeWebSocket;
}

/** Hono's `Context` seen through the neutral request contract. */
function honoRequest(c: Context): YormRequest {
  return {
    method: c.req.method,
    path: c.req.path,
    param: (name) => c.req.param(name),
    query: (name) => c.req.query(name),
    header: (name) => c.req.header(name),
    json: () => c.req.json(),
    rawBody: async () => new Uint8Array(await c.req.arrayBuffer()),
  };
}

/**
 * Built directly rather than through `c.json()` so the neutral numeric status
 * does not have to satisfy Hono's status-literal types.
 */
function toResponse(response: YormResponse): Response {
  return response.body === undefined
    ? new Response(null, { status: response.status })
    : Response.json(response.body, { status: response.status });
}

const HONO_METHOD = {
  GET: "get",
  PUT: "put",
  PATCH: "patch",
  POST: "post",
  DELETE: "delete",
} as const satisfies Record<HttpMethod, "get" | "put" | "patch" | "post" | "delete">;

/** Binary frames only; strings/Blobs are ignored (the Yjs protocol is binary). */
function toUint8Array(data: WSMessageReceive): Uint8Array | null {
  if (data instanceof Uint8Array) {
    return data;
  }
  if (data instanceof ArrayBuffer) {
    return new Uint8Array(data);
  }
  return null;
}

function honoSocket(ws: WSContext<unknown>): YormSocket {
  return {
    // lib0 encoders are backed by plain ArrayBuffers, which is what send wants.
    send: (data) => ws.send(data as Uint8Array<ArrayBuffer>),
    close: (code, reason) => ws.close(code, reason),
  };
}

function mountWebSocket(upgradeWebSocket: UpgradeWebSocket, endpoint: YormWebSocketEndpoint): Hono {
  const app = new Hono();
  app.get(
    endpoint.path,
    upgradeWebSocket(async (c): Promise<WSEvents<unknown>> => {
      const handlers = await endpoint.connect(honoRequest(c));
      // The room excludes the origin socket by reference, so one connection
      // must map to one YormSocket across all of its events.
      let socket: YormSocket | null = null;
      const socketFor = (ws: WSContext<unknown>): YormSocket => (socket ??= honoSocket(ws));
      return {
        onOpen(_evt, ws) {
          handlers.onOpen(socketFor(ws));
        },
        onMessage(evt, ws) {
          const data = toUint8Array(evt.data);
          if (data !== null) {
            handlers.onMessage(socketFor(ws), data);
          }
        },
        onClose(_evt, ws) {
          handlers.onClose(socketFor(ws));
        },
        onError(_evt, ws) {
          handlers.onClose(socketFor(ws));
        },
      };
    }),
  );
  return app;
}

/**
 * Creates the mountable YORM sub-app: the REST routes under `/docs/*`, plus
 * the WebSocket route under `/ws/*` when `options.upgradeWebSocket` is given.
 */
export function createHonoYorm(yorm: Yorm, options: HonoYormOptions = {}): Hono {
  const server = createYormServer(yorm, options);
  const app = new Hono();
  for (const route of server.routes) {
    app[HONO_METHOD[route.method]](route.path, async (c) =>
      toResponse(await route.handle(honoRequest(c))),
    );
  }
  if (options.upgradeWebSocket) {
    app.route("/", mountWebSocket(options.upgradeWebSocket, server.websocket));
  }
  return app;
}

/**
 * Creates a sub-app containing only `GET /ws/:type/:id` (y-protocols sync +
 * awareness). The upgrader is injected because Hono's `upgradeWebSocket` is
 * runtime-specific — this keeps the adapter free of runtime lock-in.
 *
 * This mounts its **own** session cache, so use it only when the REST routes
 * are not mounted; otherwise pass `upgradeWebSocket` to {@link createHonoYorm}
 * so HTTP writes broadcast to the WebSocket clients of the same document.
 */
export function createHonoYormWebSocket(
  yorm: Yorm,
  upgradeWebSocket: UpgradeWebSocket,
  options: HonoYormOptions = {},
): Hono {
  return mountWebSocket(upgradeWebSocket, createYormServer(yorm, options).websocket);
}
