# @yorm/fastify

Fastify adapter for [@yorm/server](../server/README.md). **Routes, WebSocket
protocol, query params and options are documented in
[@yorm/server](../server/README.md)** — this README covers only what is
Fastify-specific.

## Mounting

```ts
import Fastify from "fastify";
import { yormFastify } from "@yorm/fastify";

const app = Fastify();

await app.register(yormFastify(yorm, { onAuthorize, defaultPolicy: { kind: "on-blur" } }), {
  prefix: "/yorm",
});

await app.listen({ port: 3000 });
```

That single registration mounts both the HTTP routes and
`GET /yorm/ws/:type/:id`; `@fastify/websocket` is registered for you.

Peer dependencies: `fastify ^5`, `@fastify/websocket ^11`, `yjs ^13`.

## Encapsulation (why this is not a `fastify-plugin`)

The plugin is deliberately **not** wrapped in `fastify-plugin`. It installs a
catch-all `parseAs: "buffer"` content-type parser (and removes the built-in
JSON parser, because Fastify prefers exact-match parsers over regex ones) so
that `rawBody()` works and malformed bodies produce YORM's `400 { error }`
shape rather than Fastify's.

Staying encapsulated keeps that parser inside the plugin's scope, so your own
routes keep their normal JSON body parsing. The cost is that the plugin cannot
decorate the root instance — it does not need to.
