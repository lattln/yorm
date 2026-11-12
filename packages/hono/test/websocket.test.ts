import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { serve } from "@hono/node-server";
import type { ServerType } from "@hono/node-server";
import { createNodeWebSocket } from "@hono/node-ws";
import { Hono } from "hono";
import * as Y from "yjs";
import * as encoding from "lib0/encoding";
import * as syncProtocol from "y-protocols/sync";
import { defineMapping, one } from "@yorm/core";
import { createYorm, memoryRuntime, proposalsApi } from "@yorm/yjs";

import { createHonoYorm, guardCanonicalWrites } from "../src/index.js";
import type { FakeDocumentStore, FakeProjectionStore } from "./fakes.js";
import { fakeDocumentStore, fakeProjectionStore, until } from "./fakes.js";
import { MiniClient } from "@yorm/server";

const patientMapping = defineMapping<{ name?: string }>({
  name: "test.Patient",
  version: 1,
  documentType: "Patient",
  projections: [
    one("patient", {
      key: ({ documentId }) => ({ id: documentId }),
      values: ({ object }) => ({ name: object.name ?? null }),
    }),
  ],
});

describe("@yorm/hono WebSocket route", () => {
  let app: Hono;
  let server: ServerType;
  let port: number;
  let documents: FakeDocumentStore;
  let projections: FakeProjectionStore;
  const clients: MiniClient[] = [];

  const connect = (path: string): MiniClient => {
    const client = new MiniClient(`ws://127.0.0.1:${port}${path}`);
    clients.push(client);
    return client;
  };

  beforeAll(async () => {
    documents = fakeDocumentStore();
    projections = fakeProjectionStore();
    const yorm = createYorm({
      runtime: memoryRuntime(),
      documents,
      projections,
      mappings: [patientMapping],
    });
    const rootSession = await yorm.open("Patient", "root-types");
    rootSession.doc.getMap("map");
    rootSession.doc.getArray("array");
    rootSession.doc.getText("text");
    rootSession.doc.get("xml-text", Y.XmlText);
    rootSession.doc.get("xml-element", Y.XmlElement);
    rootSession.doc.getXmlFragment("xml-fragment");
    app = new Hono();
    const { upgradeWebSocket, injectWebSocket } = createNodeWebSocket({ app });
    app.route(
      "/yorm",
      createHonoYorm(yorm, {
        upgradeWebSocket,
        allowReadOnlySockets: true,
        onAuthorize: (ctx) => ctx.query("token") !== "bad",
        // Proposer-mode connections may only write the proposals subtree.
        onAuthorizeWrite: (ctx, _docRef, scope) =>
          ctx.query("reader") !== "yes" &&
          ((ctx.query("mode") ?? "editor") === "proposer" ? scope === "proposals" : true),
        onValidateSyncUpdate: (ctx, _ref, before, after) => {
          if (ctx.query("guard") === "throws") {
            throw new Error("validator failed");
          }
          if (ctx.query("guard") === "types") {
            return [...before.share].every(
              ([name, root]) => root.constructor === after.share.get(name)?.constructor,
            );
          }
          if (ctx.query("guard") === "json") {
            return (
              before.toJSON().resource?.locked === after.toJSON().resource?.locked &&
              after.toJSON().resource?.name !== undefined
            );
          }
          return (
            ctx.query("guard") !== "yes" ||
            before.getMap("resource").get("locked") === after.getMap("resource").get("locked")
          );
        },
      }),
    );
    app.route(
      "/write-required",
      createHonoYorm(yorm, {
        upgradeWebSocket,
        onAuthorizeWrite: () => false,
      }),
    );
    await new Promise<void>((resolve) => {
      server = serve({ fetch: app.fetch, port: 0 }, (info) => {
        port = info.port;
        resolve();
      });
    });
    injectWebSocket(server);
  });

  afterAll(async () => {
    for (const client of clients) {
      client.close();
    }
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  });

  it("two clients converge and the server projects the edit", async () => {
    const a = connect("/yorm/ws/Patient/p1");
    const b = connect("/yorm/ws/Patient/p1");
    await until(() => a.synced && b.synced, "both clients synced");

    a.doc.getMap("resource").set("name", "Ada");
    await until(() => b.doc.getMap("resource").get("name") === "Ada", "edit converged to client B");

    // Default policy is every-change: the projection store received a plan
    // reflecting the edit.
    await until(
      () =>
        projections.plans.some(
          (plan) =>
            plan.documentId === "p1" &&
            plan.operations.some((op) => op.kind === "upsert" && op.values["name"] === "Ada"),
        ),
      "server projected the edit",
    );
    // …and the document itself was persisted.
    await until(() => documents.snapshots.has("Patient/p1"), "document persisted");
  });

  it("a late joiner receives existing state via sync", async () => {
    const late = connect("/yorm/ws/Patient/p1");
    await until(() => late.doc.getMap("resource").get("name") === "Ada", "late joiner caught up");
  });

  it("validates raw updates before persistence or fan-out without blocking ordinary edits", async () => {
    const client = connect("/yorm/ws/Patient/guarded?guard=yes");
    const observer = connect("/yorm/ws/Patient/guarded?guard=yes");
    await until(() => client.synced && observer.synced, "guarded clients synced");
    client.doc.getMap("resource").set("name", "Allowed");
    await until(
      () => observer.doc.getMap("resource").get("name") === "Allowed",
      "ordinary edit accepted",
    );
    client.doc.transact(() => {
      client.doc.getMap("resource").set("name", "Rejected");
      client.doc.getMap("resource").set("locked", "Changed");
    });
    await until(() => client.closed !== null, "guard refused mixed update");
    expect(client.closed).toEqual({ code: 1008, reason: "document update refused" });
    expect(observer.doc.getMap("resource").toJSON()).toEqual({ name: "Allowed" });
    const response = await app.request("/yorm/docs/Patient/guarded");
    expect((await response.json()).object).toEqual({ name: "Allowed" });
  });

  it("also validates offline state uploaded through SyncStep2", async () => {
    const client = connect("/yorm/ws/Patient/offline-guard?guard=yes");
    // Before open, seed an offline document without sending an Update frame.
    Y.applyUpdate(
      client.doc,
      (() => {
        const offline = new Y.Doc();
        try {
          offline.getMap("resource").set("locked", "Offline change");
          return Y.encodeStateAsUpdate(offline);
        } finally {
          offline.destroy();
        }
      })(),
      client,
    );
    await until(() => client.closed !== null, "offline upload refused");
    expect(client.closed).toEqual({ code: 1008, reason: "document update refused" });
    const response = await app.request("/yorm/docs/Patient/offline-guard");
    expect(response.status).toBe(404);
  });

  it.each(["reader=yes", "guard=yes", "mode=proposer"])(
    "rejects malformed sync uploads without throwing (%s)",
    async (query) => {
      const client = connect(`/yorm/ws/Patient/malformed-${query}?${query}`);
      await until(() => client.synced, "client synced");
      client.ws.send(new Uint8Array([0, 2, 0]));
      await until(() => client.closed !== null, "malformed upload refused");
      expect(client.closed?.code).toBe(1008);
      expect((await app.request(`/yorm/docs/Patient/malformed-${query}`)).status).toBe(404);
    },
  );

  it("rejects a throwing validator without persisting the upload", async () => {
    const client = connect("/yorm/ws/Patient/throwing?guard=throws");
    await until(() => client.closed !== null, "throwing validator refused");
    expect(client.closed?.code).toBe(1008);
    expect((await app.request("/yorm/docs/Patient/throwing")).status).toBe(404);
  });

  it("preserves initialized root types for whole-document validators", async () => {
    const writer = connect("/yorm/ws/Patient/json-validator");
    await until(() => writer.synced, "writer synced");
    writer.doc.getMap("resource").set("name", "Before");
    await until(() => documents.snapshots.has("Patient/json-validator"), "seed persisted");
    const client = connect("/yorm/ws/Patient/json-validator?guard=json");
    await until(() => client.synced, "validated client synced");
    client.doc.getMap("resource").set("name", "After");
    await until(() => writer.root().name === "After", "whole-document validation accepted");
    client.doc.getMap("resource").set("locked", "Forbidden");
    await until(() => client.closed !== null, "whole-document validation refused");
    expect(writer.root()).toEqual({ name: "After" });
  });

  it("preserves all built-in root constructors, including XML text", async () => {
    const client = connect("/yorm/ws/Patient/root-types?guard=types");
    await until(() => client.synced, "typed roots synced");
    client.doc.getMap("resource").set("name", "Typed roots");
    await until(() => documents.snapshots.has("Patient/root-types"), "typed roots accepted");
    expect(client.closed).toBeNull();
  });

  it.each(["structs", "deletes"])("rejects unresolved %s before validation", async (kind) => {
    const id = `pending-${kind}`;
    const client = connect(`/yorm/ws/Patient/${id}?guard=yes`);
    await until(() => client.synced, "client synced");
    const offline = new Y.Doc();
    try {
      offline.getMap("resource").set("locked", "Forbidden");
      const vector = Y.encodeStateVector(offline);
      if (kind === "structs") offline.getMap("resource").set("name", "Later");
      else offline.getMap("resource").delete("locked");
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, 0);
      syncProtocol.writeUpdate(encoder, Y.encodeStateAsUpdate(offline, vector));
      client.ws.send(encoding.toUint8Array(encoder));
      await until(() => client.closed !== null, "unresolved upload refused");
      expect(client.closed?.code).toBe(1008);
      expect(documents.snapshots.has(`Patient/${id}`)).toBe(false);
    } finally {
      offline.destroy();
    }
  });

  it("unauthorized sockets are closed with 1008", async () => {
    const denied = connect("/yorm/ws/Patient/p1?token=bad");
    await until(() => denied.closed !== null, "unauthorized socket closed");
    expect(denied.closed?.code).toBe(1008);
  });

  it("still requires write access unless read-only fallback is enabled", async () => {
    const denied = connect("/write-required/ws/Patient/p1");
    await until(() => denied.closed !== null, "write-required socket closed");
    expect(denied.closed).toEqual({ code: 1008, reason: "forbidden" });
  });

  it("read-only sockets sync existing state and live updates without persisting the handshake", async () => {
    const writer = connect("/yorm/ws/Patient/readable");
    await until(() => writer.synced, "writer synced");
    writer.doc.getMap("resource").set("name", "Closed case");
    writer.doc.getMap("resource").set("obsolete", "Removed before viewing");
    writer.doc.getMap("resource").delete("obsolete");
    await until(
      () => (documents.snapshots.get("Patient/readable")?.documentVersion ?? 0) >= 3,
      "initial state and deletion persisted",
    );
    const version = documents.snapshots.get("Patient/readable")!.documentVersion;
    const reader = connect("/yorm/ws/Patient/readable?reader=yes&policy=explicit");
    await until(() => reader.synced, "reader synced");
    expect(reader.root()).toEqual({ name: "Closed case" });
    expect(reader.closed).toBeNull();
    expect(documents.snapshots.get("Patient/readable")!.documentVersion).toBe(version);
    writer.doc.getMap("resource").set("name", "Live update");
    await until(() => reader.root().name === "Live update", "reader received live update");
    await until(
      () =>
        projections.plans.some(
          (plan) =>
            plan.documentId === "readable" &&
            plan.operations.some((op) => op.kind === "upsert" && op.values.name === "Live update"),
        ),
      "reader did not change projection policy",
    );
    const denied = await app.request("/yorm/docs/Patient/readable?reader=yes", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Forbidden" }),
    });
    expect(denied.status).toBe(403);
  });

  it.each(["resource", "yorm:proposals", "unknown"])(
    "read-only sockets refuse writes to %s before persistence or fan-out",
    async (root) => {
      const writer = connect(`/yorm/ws/Patient/read-only-${root}`);
      await until(() => writer.synced, "writer synced");
      writer.doc.getMap("resource").set("name", "Unchanged");
      await until(
        () => documents.snapshots.has(`Patient/read-only-${root}`),
        "initial state persisted",
      );
      const snapshot = documents.snapshots.get(`Patient/read-only-${root}`)!;
      const reader = connect(`/yorm/ws/Patient/read-only-${root}?reader=yes`);
      await until(() => reader.synced, "reader synced");
      reader.doc.getMap(root).set("name", "Rejected");
      await until(() => reader.closed !== null, "read-only write refused");
      expect(reader.closed).toEqual({
        code: 1008,
        reason: "read-only connection: document writes are forbidden",
      });
      expect(writer.doc.getMap(root).get("name")).toBe(
        root === "resource" ? "Unchanged" : undefined,
      );
      expect(documents.snapshots.get(`Patient/read-only-${root}`)).toBe(snapshot);
    },
  );

  it("refuses offline state uploaded through read-only SyncStep2", async () => {
    const reader = connect("/yorm/ws/Patient/read-only-offline?reader=yes");
    const offline = new Y.Doc();
    try {
      offline.getMap("resource").set("name", "Offline change");
      Y.applyUpdate(reader.doc, Y.encodeStateAsUpdate(offline), reader);
    } finally {
      offline.destroy();
    }
    await until(() => reader.closed !== null, "read-only offline upload refused");
    expect(reader.closed?.code).toBe(1008);
    expect(documents.snapshots.has("Patient/read-only-offline")).toBe(false);
  });

  it("refuses CRDT writes even when the visible JSON is unchanged", async () => {
    const writer = connect("/yorm/ws/Patient/read-only-same-json");
    await until(() => writer.synced, "writer synced");
    writer.doc.getMap("resource").set("name", "Same");
    await until(
      () => documents.snapshots.has("Patient/read-only-same-json"),
      "initial state persisted",
    );
    const reader = connect("/yorm/ws/Patient/read-only-same-json?reader=yes");
    await until(() => reader.synced, "reader synced");
    reader.doc.getMap("resource").set("name", "Same");
    await until(() => reader.closed !== null, "same-JSON write refused");
    expect(reader.closed?.code).toBe(1008);
  });

  it("?policy=explicit defers projection until an HTTP flush", async () => {
    const client = connect("/yorm/ws/Patient/p2?policy=explicit");
    await until(() => client.synced, "client synced");

    client.doc.getMap("resource").set("name", "Grace");
    await until(
      () => documents.updates.some((update) => update.documentId === "p2"),
      "update persisted",
    );
    await new Promise((resolve) => setTimeout(resolve, 100)); // bounded settle
    expect(projections.plans.filter((plan) => plan.documentId === "p2")).toHaveLength(0);

    const flush = await app.request("/yorm/docs/Patient/p2/flush", { method: "POST" });
    expect(flush.status).toBe(200);
    expect(projections.plans.filter((plan) => plan.documentId === "p2")).toHaveLength(1);
  });

  it("proposer WS: proposals-subtree updates flow, canonical edits are refused", async () => {
    const proposer = connect("/yorm/ws/Patient/p3?mode=proposer");
    await until(() => proposer.synced, "proposer synced");

    // A proposal from the proposer connection syncs to the server…
    proposalsApi(proposer.doc, { genId: () => "prop-1" }).propose({
      path: ["name"],
      op: "set",
      proposedValue: "Grace",
      actor: "bob",
    });
    await until(async () => {
      const res = await app.request("/yorm/docs/Patient/p3/proposals");
      const body = (await res.json()) as { proposals: Array<{ id: string }> };
      return body.proposals.some((p) => p.id === "prop-1");
    }, "proposal reached the server");

    // …but a direct canonical edit is refused: the socket closes with 1008
    // and the server-side document is unchanged.
    proposer.doc.getMap("resource").set("name", "Mallory");
    await until(() => proposer.closed !== null, "proposer socket closed");
    expect(proposer.closed?.code).toBe(1008);
    const doc = await (await app.request("/yorm/docs/Patient/p3")).json();
    expect(doc.object).toEqual({});
  });

  it("guardCanonicalWrites flags only updates that touch the canonical subtree", () => {
    const server = new Y.Doc();
    server.getMap("resource").set("name", "Ada");

    const client = new Y.Doc();
    Y.applyUpdate(client, Y.encodeStateAsUpdate(server));
    const before = Y.encodeStateAsUpdate(client);

    client.getMap("yorm:proposals").set("p1", "pending");
    const proposalOnly = Y.encodeStateAsUpdate(client, Y.encodeStateVectorFromUpdate(before));
    expect(guardCanonicalWrites(server, proposalOnly)).toBe(false);

    const mid = Y.encodeStateAsUpdate(client);
    client.getMap("resource").set("name", "Mallory");
    const canonical = Y.encodeStateAsUpdate(client, Y.encodeStateVectorFromUpdate(mid));
    expect(guardCanonicalWrites(server, canonical)).toBe(true);
  });
});
