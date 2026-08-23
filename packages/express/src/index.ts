/**
 * @yorm/express — the Express transport adapter.
 *
 * ```ts
 * const yormExpress = createExpressYorm(yorm);
 * app.use("/yorm", yormExpress.router);
 * const server = app.listen(3000);
 * yormExpress.attachWebSocket(server, "/yorm");
 * ```
 *
 * All behavior lives in [@yorm/server](../server/README.md); this module only
 * translates Express requests into `YormRequest`s and `ws` sockets into
 * `YormSocket`s. Express has no native WebSocket support, so the collaboration
 * endpoint is served by the raw `ws` package on the HTTP server's `upgrade`
 * event (release-plan.md Decision #8).
 */
import type { IncomingMessage, Server as HttpServer } from "node:http";
import type { Duplex } from "node:stream";
import express from "express";
import type { Request, Response, Router } from "express";
import { WebSocketServer } from "ws";
import type { RawData, WebSocket } from "ws";
import type { Yorm } from "@yorm/yjs";
import { createYormServer } from "@yorm/server";
import type {
  YormRequest,
  YormResponse,
  YormServerOptions,
  YormSocket,
  YormSocketHandlers,
  YormWebSocketEndpoint,
} from "@yorm/server";

export { guardCanonicalWrites } from "@yorm/server";
export type { WriteScope, YormRequest, YormServerOptions } from "@yorm/server";

export const YORM_EXPRESS_VERSION = "0.1.0";

export type ExpressYormOptions = YormServerOptions;

export interface ExpressYorm {
  /** Mount with `app.use("/yorm", router)`. */
  router: Router;
  /**
   * Serves `GET <basePath>/ws/:type/:id` off the server's `upgrade` event.
   * `basePath` must match where {@link ExpressYorm.router} is mounted.
   * Upgrades to other paths are left untouched, so other WebSocket libraries
   * can share the same server.
   */
  attachWebSocket(server: HttpServer, basePath?: string): void;
}

function firstString(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value;
  }
  return Array.isArray(value) && typeof value[0] === "string" ? value[0] : undefined;
}

function expressRequest(req: Request): YormRequest {
  // `express.raw` below leaves `req.body` a Buffer; a host app that already
  // parsed the body globally leaves an object, which we take as-is.
  const parsed = async (): Promise<unknown> => {
    if (Buffer.isBuffer(req.body)) {
      if (req.body.length === 0) {
        throw new Error("request body is empty");
      }
      return JSON.parse(req.body.toString("utf8"));
    }
    if (req.body === undefined || req.body === null) {
      throw new Error("request body is empty");
    }
    return req.body;
  };
  return {
    method: req.method,
    path: req.path,
    param: (name) => firstString(req.params[name]),
    query: (name) => firstString(req.query[name]),
    header: (name) => req.get(name) ?? undefined,
    json: parsed,
    rawBody: async () => (Buffer.isBuffer(req.body) ? new Uint8Array(req.body) : new Uint8Array(0)),
  };
}

/** The upgrade request has no body, so `json`/`rawBody` reject. */
function upgradeRequest(req: IncomingMessage, params: Record<string, string>): YormRequest {
  const url = new URL(req.url ?? "/", "http://localhost");
  const noBody = async (): Promise<never> => {
    throw new Error("a WebSocket upgrade has no body");
  };
  return {
    method: req.method ?? "GET",
    path: url.pathname,
    param: (name) => params[name],
    query: (name) => url.searchParams.get(name) ?? undefined,
    header: (name) => firstString(req.headers[name.toLowerCase()]),
    json: noBody,
    rawBody: noBody,
  };
}

function send(res: Response, response: YormResponse): void {
  if (response.body === undefined) {
    res.status(response.status).end();
    return;
  }
  res.status(response.status).json(response.body);
}

function toBytes(data: RawData): Uint8Array | null {
  if (Buffer.isBuffer(data)) {
    return new Uint8Array(data);
  }
  if (Array.isArray(data)) {
    return new Uint8Array(Buffer.concat(data));
  }
  if (data instanceof ArrayBuffer) {
    return new Uint8Array(data);
  }
  return null;
}

/**
 * Wires one accepted socket to the endpoint. Listeners are attached
 * synchronously and frames received while `connect` is still pending are
 * queued, because a y-websocket client sends SyncStep1 the moment it opens.
 */
function bind(ws: WebSocket, connecting: Promise<YormSocketHandlers>): void {
  const socket: YormSocket = {
    send: (data) => ws.send(data),
    close: (code, reason) => ws.close(code, reason),
  };
  let handlers: YormSocketHandlers | null = null;
  const queue: Uint8Array[] = [];
  let closed = false;

  ws.on("message", (data) => {
    const bytes = toBytes(data);
    if (bytes === null) {
      return; // strings/Blobs are ignored — the Yjs protocol is binary
    }
    if (handlers === null) {
      queue.push(bytes);
      return;
    }
    handlers.onMessage(socket, bytes);
  });
  ws.on("close", () => {
    closed = true;
    handlers?.onClose(socket);
  });

  void connecting.then(
    (ready) => {
      if (closed) {
        return;
      }
      handlers = ready;
      ready.onOpen(socket);
      for (const bytes of queue) {
        ready.onMessage(socket, bytes);
      }
      queue.length = 0;
    },
    () => ws.close(1011, "internal error"),
  );
}

/** Turns `/yorm/ws/:type/:id` into a matcher for the upgrade event. */
function wsMatcher(basePath: string): (pathname: string) => Record<string, string> | null {
  const prefix = basePath.replace(/\/+$/, "");
  const pattern = new RegExp(
    `^${prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/ws/([^/]+)/([^/]+)$`,
  );
  return (pathname) => {
    const match = pattern.exec(pathname);
    return match
      ? { type: decodeURIComponent(match[1]!), id: decodeURIComponent(match[2]!) }
      : null;
  };
}

function attach(endpoint: YormWebSocketEndpoint, server: HttpServer, basePath: string): void {
  const matches = wsMatcher(basePath);
  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const params = matches(new URL(req.url ?? "/", "http://localhost").pathname);
    if (params === null) {
      return; // not ours — leave it for any other upgrade handler
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      bind(ws, endpoint.connect(upgradeRequest(req, params)));
    });
  });
}

/**
 * Creates the Express router and the WebSocket attacher over one shared
 * session cache, so an HTTP write broadcasts to the WebSocket clients of the
 * same document.
 */
export function createExpressYorm(yorm: Yorm, options: ExpressYormOptions = {}): ExpressYorm {
  const server = createYormServer(yorm, options);
  const router = express.Router();
  // One body mechanism for every route: the raw bytes, parsed by the neutral
  // handler. That is what makes `rawBody()` (webhook signatures) possible and
  // keeps malformed-JSON errors in YORM's `{ error }` shape.
  router.use(express.raw({ type: () => true, limit: "10mb" }));
  for (const route of server.routes) {
    const method = route.method.toLowerCase() as "get" | "put" | "patch" | "post" | "delete";
    router[method](route.path, (req, res, next) => {
      route
        .handle(expressRequest(req))
        .then((response) => send(res, response))
        .catch(next);
    });
  }
  return {
    router,
    attachWebSocket(httpServer: HttpServer, basePath = "/yorm") {
      attach(server.websocket, httpServer, basePath);
    },
  };
}
