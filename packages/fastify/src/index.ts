/**
 * @yorm/fastify — the Fastify transport adapter.
 *
 * ```ts
 * await app.register(yormFastify(yorm), { prefix: "/yorm" });
 * ```
 *
 * All behavior lives in [@yorm/server](../server/README.md); this module only
 * translates Fastify requests into `YormRequest`s and `@fastify/websocket`
 * sockets into `YormSocket`s.
 *
 * The plugin is deliberately **encapsulated** (not wrapped in
 * `fastify-plugin`): it installs a buffer content-type parser so `rawBody()`
 * works, and encapsulation keeps that from replacing the host app's own body
 * parsing.
 */
import websocket from "@fastify/websocket";
import type { FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import type { RawData, WebSocket } from "ws";
import type { Yorm } from "@yorm/yjs";
import { createYormServer } from "@yorm/server";
import type {
  YormRequest,
  YormResponse,
  YormServerOptions,
  YormSocket,
  YormSocketHandlers,
} from "@yorm/server";

export { guardCanonicalWrites } from "@yorm/server";
export type { WriteScope, YormRequest, YormServerOptions } from "@yorm/server";

export const YORM_FASTIFY_VERSION = "0.1.0";

export type FastifyYormOptions = YormServerOptions;

function firstString(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value;
  }
  return Array.isArray(value) && typeof value[0] === "string" ? value[0] : undefined;
}

function fastifyRequest(request: FastifyRequest): YormRequest {
  const params = request.params as Record<string, unknown>;
  const query = request.query as Record<string, unknown>;
  return {
    method: request.method,
    path: request.url.split("?")[0] ?? request.url,
    param: (name) => firstString(params[name]),
    query: (name) => firstString(query[name]),
    header: (name) => firstString(request.headers[name.toLowerCase()]),
    // The content-type parser below leaves `body` a Buffer, so the neutral
    // handler owns JSON parsing (and its 400 shape).
    json: async () => {
      if (!Buffer.isBuffer(request.body) || request.body.length === 0) {
        throw new Error("request body is empty");
      }
      return JSON.parse(request.body.toString("utf8"));
    },
    rawBody: async () =>
      Buffer.isBuffer(request.body) ? new Uint8Array(request.body) : new Uint8Array(0),
  };
}

function send(reply: FastifyReply, response: YormResponse): void {
  if (response.body === undefined) {
    void reply.status(response.status).send();
    return;
  }
  void reply.status(response.status).send(response.body);
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

  ws.on("message", (data: RawData) => {
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

/**
 * Creates the Fastify plugin: REST routes plus the collaboration endpoint over
 * one shared session cache, so an HTTP write broadcasts to the WebSocket
 * clients of the same document.
 */
export function yormFastify(yorm: Yorm, options: FastifyYormOptions = {}): FastifyPluginAsync {
  const server = createYormServer(yorm, options);
  return async (fastify: FastifyInstance): Promise<void> => {
    await fastify.register(websocket);
    // Every content type arrives as a Buffer: that is what makes `rawBody()`
    // (webhook signatures) possible without a second read of the stream.
    // Fastify prefers exact-match parsers over regex ones, so the built-in
    // application/json parser has to go first — encapsulation keeps that
    // scoped to this plugin.
    fastify.removeAllContentTypeParsers();
    fastify.addContentTypeParser(
      /^.*$/,
      { parseAs: "buffer" },
      (_request, body, done: (error: Error | null, body?: unknown) => void) => {
        done(null, body);
      },
    );

    for (const route of server.routes) {
      fastify.route({
        method: route.method,
        url: route.path,
        handler: async (request, reply) => {
          send(reply, await route.handle(fastifyRequest(request)));
        },
      });
    }

    fastify.get(server.websocket.path, { websocket: true }, (socket: WebSocket, request) => {
      bind(socket, server.websocket.connect(fastifyRequest(request)));
    });
  };
}
