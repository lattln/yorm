/**
 * Transport conformance suite — the executable contract every YORM transport
 * adapter must satisfy (release-plan.md R3b). Ships in the package so a new
 * adapter only adds wire-up: implement a {@link TransportFactory} and call
 * {@link transportConformanceTests} from a test file, injecting the test API
 * (so this module has no dependency on any test framework).
 *
 * The suite drives a **real listener** over HTTP and WebSocket rather than an
 * in-process request helper, because WebSocket upgrades cannot be faked
 * uniformly across frameworks.
 */
import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";
import * as syncProtocol from "y-protocols/sync";
import * as Y from "yjs";
import { DEFAULT_ROOT_KEY, createYorm, defineRolePolicy, memoryRuntime } from "@yorm/yjs";
import type { RolePolicy, Yorm } from "@yorm/yjs";
import { defineMapping, one } from "@yorm/core";
import type {
  DocumentStore,
  DocumentUpdate,
  ProjectionCheckpoint,
  ProjectionPlan,
  ProjectionStateRecord,
  ProjectionStore,
  StoredDocument,
} from "@yorm/core";

import type { YormServerOptions } from "./types.js";

/**
 * Minimal y-protocols client on the global `WebSocket` (no client dependency
 * needed): sends SyncStep1 on open, answers sync messages, and forwards local
 * doc updates to the server. Awareness frames are ignored.
 */
export class MiniClient {
  readonly doc = new Y.Doc();
  readonly ws: WebSocket;
  closed: { code: number; reason: string } | null = null;
  synced = false;

  constructor(url: string) {
    this.ws = new WebSocket(url);
    this.ws.binaryType = "arraybuffer";
    this.ws.addEventListener("open", () => {
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, 0);
      syncProtocol.writeSyncStep1(encoder, this.doc);
      this.ws.send(encoding.toUint8Array(encoder));
    });
    this.ws.addEventListener("message", (evt: MessageEvent) => {
      const data = new Uint8Array(evt.data as ArrayBuffer);
      const decoder = decoding.createDecoder(data);
      if (decoding.readVarUint(decoder) !== 0) {
        return; // awareness — not exercised by the suite
      }
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, 0);
      const messageType = syncProtocol.readSyncMessage(decoder, encoder, this.doc, this);
      if (messageType === syncProtocol.messageYjsSyncStep2) {
        this.synced = true;
      }
      if (encoding.length(encoder) > 1) {
        this.ws.send(encoding.toUint8Array(encoder));
      }
    });
    this.ws.addEventListener("close", (evt) => {
      const { code, reason } = evt as { code: number; reason: string };
      this.closed = { code, reason };
    });
    this.doc.on("update", (update: Uint8Array, origin: unknown) => {
      if (origin === this) {
        return; // came from the server; don't echo back
      }
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, 0);
      syncProtocol.writeUpdate(encoder, update);
      this.ws.send(encoding.toUint8Array(encoder));
    });
  }

  /** The document root the JSON codec writes into. */
  root(): Record<string, unknown> {
    return this.doc.getMap(DEFAULT_ROOT_KEY).toJSON();
  }

  close(): void {
    this.ws.close();
  }
}

/** Polls `cond` until it holds or `timeoutMs` elapses (then throws `label`). */
export async function until(
  cond: () => boolean | Promise<boolean>,
  label: string,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await cond())) {
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for: ${label}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** One mounted adapter under test. */
export interface TransportHarness {
  /** Absolute base URL of the mounted server, e.g. `http://127.0.0.1:1234/yorm`. */
  baseUrl: string;
  stop(): Promise<void>;
}

/** Mounts the suite's `Yorm` + options on one framework and starts listening. */
export interface TransportFactory {
  /** Human-readable adapter name, used in test titles. */
  name: string;
  start(yorm: Yorm, options: YormServerOptions): Promise<TransportHarness>;
}

/** The slice of an assertion object the suite uses (vitest-compatible). */
export interface TransportExpectation {
  toBe(expected: unknown): void;
  toEqual(expected: unknown): void;
}

/** The slice of a test API the suite needs — pass vitest's exports directly. */
export interface TransportTestApi {
  describe(name: string, fn: () => void): void;
  it(name: string, fn: () => Promise<void>): void;
  expect(actual: unknown): TransportExpectation;
  beforeAll(fn: () => Promise<void>): void;
  afterAll(fn: () => Promise<void>): void;
}

interface Patient {
  name?: string;
  ssn?: string;
}

const patientMapping = defineMapping<Patient>({
  name: "conformance.Patient",
  version: 1,
  documentType: "Patient",
  projections: [
    one("patient", {
      key: ({ documentId }) => ({ id: documentId }),
      values: ({ object }) => ({ name: object.name ?? null }),
    }),
  ],
});

/** Front desk sees the name but never the SSN, and may edit the name. */
const frontDeskPolicy = defineRolePolicy<Patient>({
  role: "front-desk",
  documentType: "Patient",
  view: (patient) => ({ name: patient.name ?? "" }),
  canWrite: ({ before, after }) =>
    [...Object.keys(before), ...Object.keys(after)].every((key) => key === "name"),
});

/**
 * The options every adapter is tested against. `?token=bad` is refused
 * outright; `?mode=proposer` is refused any canonical write, which is what
 * puts the proposer-mode guard under test.
 */
export const CONFORMANCE_OPTIONS: YormServerOptions = {
  onAuthorize: (request) => request.query("token") !== "bad",
  onAuthorizeWrite: (request, _docRef, scope) =>
    (request.query("mode") ?? "editor") === "proposer" ? scope === "proposals" : true,
  rolePolicies: [frontDeskPolicy as RolePolicy],
};

/** Fresh in-memory stores, so the suite never needs a database. */
function memoryStores(): { documents: DocumentStore; projections: ProjectionStore } {
  const snapshots = new Map<string, StoredDocument>();
  const updates: DocumentUpdate[] = [];
  const states = new Map<string, ProjectionStateRecord>();
  const plans: ProjectionPlan[] = [];
  const failures: Array<{ checkpoint: ProjectionCheckpoint; error: string }> = [];
  return {
    documents: {
      async loadDocument(type, id) {
        return snapshots.get(`${type}/${id}`) ?? null;
      },
      async saveSnapshot(doc) {
        snapshots.set(`${doc.documentType}/${doc.documentId}`, doc);
      },
      async appendUpdate(update) {
        updates.push(update);
      },
      async listUpdates(_type, id, sinceVersion = 0) {
        return updates.filter(
          (update) => update.documentId === id && update.documentVersion > sinceVersion,
        );
      },
      async listDocuments(type) {
        return [...snapshots.values()]
          .filter((doc) => doc.documentType === type)
          .map((doc) => ({ documentId: doc.documentId, documentType: doc.documentType }));
      },
    },
    projections: {
      async applyPlan(plan) {
        plans.push(plan);
        states.set(`${plan.documentId}/${plan.mapping}`, {
          documentId: plan.documentId,
          mappingName: plan.checkpoint.mappingName,
          mappingVersion: plan.checkpoint.mappingVersion,
          sourceDocumentVersion: plan.documentVersion,
          status: "ok",
          projectedAt: new Date(),
        });
      },
      async getState(documentId, mappingName) {
        for (const state of states.values()) {
          if (state.documentId === documentId && state.mappingName === mappingName) {
            return state;
          }
        }
        return null;
      },
      async recordFailure(checkpoint, error) {
        failures.push({ checkpoint, error });
      },
    },
  };
}

/**
 * Runs the transport contract against one adapter. Every test shares a single
 * listener but a distinct document id, so ordering never matters.
 */
export function transportConformanceTests(api: TransportTestApi, factory: TransportFactory): void {
  const { describe, it, expect, beforeAll, afterAll } = api;

  describe(`transport conformance: ${factory.name}`, () => {
    let harness: TransportHarness;
    const clients: MiniClient[] = [];

    const http = async (path: string, init?: RequestInit): Promise<Response> =>
      await fetch(`${harness.baseUrl}${path}`, init);

    const put = async (path: string, body: unknown): Promise<Response> =>
      await http(path, {
        method: "PUT",
        body: JSON.stringify(body),
        headers: { "content-type": "application/json" },
      });

    const connect = (path: string): MiniClient => {
      const client = new MiniClient(`${harness.baseUrl.replace(/^http/, "ws")}${path}`);
      clients.push(client);
      return client;
    };

    beforeAll(async () => {
      const { documents, projections } = memoryStores();
      const yorm = createYorm({
        runtime: memoryRuntime(),
        documents,
        projections,
        mappings: [patientMapping],
      });
      harness = await factory.start(yorm, CONFORMANCE_OPTIONS);
    });

    afterAll(async () => {
      for (const client of clients) {
        client.close();
      }
      await harness.stop();
    });

    it("PUT then GET round-trips the document", async () => {
      const written = await put("/docs/Patient/crud", { name: "Ada", ssn: "123-45-6789" });
      expect(written.status).toBe(200);
      expect(await written.json()).toEqual({ version: 1 });

      const read = await http("/docs/Patient/crud");
      expect(read.status).toBe(200);
      expect(await read.json()).toEqual({
        object: { name: "Ada", ssn: "123-45-6789" },
        version: 1,
      });
    });

    it("GET of a never-written document is 404", async () => {
      expect((await http("/docs/Patient/missing")).status).toBe(404);
      // A failed GET must not create the document.
      expect((await http("/docs/Patient/missing")).status).toBe(404);
    });

    it("onAuthorize refusal is 403", async () => {
      const res = await http("/docs/Patient/crud?token=bad");
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: "forbidden" });
    });

    it("onAuthorizeWrite refusal is 403 while reads still pass", async () => {
      expect((await put("/docs/Patient/scoped?mode=proposer", { name: "Nope" })).status).toBe(403);
      expect((await http("/docs/Patient/scoped?mode=proposer")).status).toBe(404);
    });

    it("DELETE and 204 responses carry no body", async () => {
      await put("/docs/Patient/nobody", { name: "Grace" });
      const res = await http("/docs/Patient/nobody/policy", {
        method: "POST",
        body: JSON.stringify({ kind: "every-change" }),
        headers: { "content-type": "application/json" },
      });
      expect(res.status).toBe(204);
      expect(await res.text()).toBe("");
    });

    it("a malformed body is 400", async () => {
      const res = await http("/docs/Patient/crud", {
        method: "PUT",
        body: "not json",
        headers: { "content-type": "application/json" },
      });
      expect(res.status).toBe(400);
    });

    it("an unauthorized upgrade closes the socket with 1008", async () => {
      const client = connect("/ws/Patient/denied?token=bad");
      await until(() => client.closed !== null, "socket closed");
      expect(client.closed?.code).toBe(1008);
    });

    it("two WebSocket clients converge", async () => {
      const a = connect("/ws/Patient/live");
      const b = connect("/ws/Patient/live");
      await until(() => a.synced && b.synced, "both clients synced");

      a.doc.getMap(DEFAULT_ROOT_KEY).set("name", "Ada");
      await until(() => b.root()["name"] === "Ada", "b received a's edit");
      expect(b.root()["name"]).toBe("Ada");
    });

    it("an HTTP write reaches connected WebSocket clients", async () => {
      const client = connect("/ws/Patient/broadcast");
      await until(() => client.synced, "client synced");
      await put("/docs/Patient/broadcast", { name: "Grace" });
      await until(() => client.root()["name"] === "Grace", "client received the HTTP write");
      expect(client.root()["name"]).toBe("Grace");
    });

    it("proposer-mode canonical writes are refused with 1008", async () => {
      const client = connect("/ws/Patient/guarded?mode=proposer");
      await until(() => client.synced, "proposer synced");
      client.doc.getMap(DEFAULT_ROOT_KEY).set("name", "Mallory");
      await until(() => client.closed !== null, "proposer closed");
      expect(client.closed?.code).toBe(1008);
    });

    it("a role with a policy syncs a redacted lens", async () => {
      await put("/docs/Patient/lens", { name: "Ada", ssn: "123-45-6789" });
      const client = connect("/ws/Patient/lens?role=front-desk");
      await until(() => client.root()["name"] === "Ada", "lens synced the visible name");
      expect(client.root()).toEqual({ name: "Ada" });
    });
  });
}
