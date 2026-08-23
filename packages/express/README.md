# @yorm/express

Express adapter for [@yorm/server](../server/README.md). **Routes, WebSocket
protocol, query params and options are documented in
[@yorm/server](../server/README.md)** — this README covers only what is
Express-specific.

## Mounting

Express has no WebSocket support of its own, so the adapter returns a router
**and** an upgrade hook for the underlying `http.Server`:

```ts
import express from "express";
import { createExpressYorm } from "@yorm/express";

const app = express();
const yormExpress = createExpressYorm(yorm, { onAuthorize });

app.use("/yorm", yormExpress.router);

const server = app.listen(3000);
yormExpress.attachWebSocket(server, "/yorm"); // GET /yorm/ws/:type/:id
```

The `basePath` passed to `attachWebSocket` must match the mount path — the
upgrade listener matches on the raw request URL, which knows nothing about
Express routers. Upgrades that do not match are left untouched, so other
WebSocket libraries can share the same server.

Peer dependencies: `express ^5`, `yjs ^13` (the `ws` client library is a
regular dependency).

## Body parsing

The router installs `express.raw({ type: () => true })` for its own routes so
the body is read exactly once as bytes: that is what makes `rawBody()` work
and what lets malformed JSON produce YORM's `400 { error }` shape. This is
scoped to the router, so your app's own `express.json()` is unaffected — and
if a global parser already ran, the adapter reuses the parsed object.
