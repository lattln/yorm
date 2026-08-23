/**
 * REST routes of the YORM server (PLAN.md M3), described as a
 * framework-neutral {@link YormRoute} table.
 *
 * All routes are JSON, run `onAuthorize` first (403 on refusal), return 400
 * for malformed bodies and 500 with `{ error }` for everything unexpected.
 * See packages/server/README.md for the route table.
 */
import {
  DEFAULT_ROOT_KEY,
  ProposalNotFoundError,
  ProposalStateError,
  applyJsonPatchLike,
} from "@yorm/yjs";
import type { DocumentSession, ProposalOp, ProposalStatus, Yorm } from "@yorm/yjs";

import type { SessionCache } from "../shared.js";
import { authorize, authorizeWrite, parsePolicy } from "../shared.js";
import type {
  HttpMethod,
  WriteScope,
  YormRequest,
  YormResponse,
  YormRoute,
  YormServerOptions,
} from "../types.js";

/** Client error carrying a 400 response message. */
class BadRequestError extends Error {}

/** One PATCH operation: set `value` at `path`, or remove when `value` is omitted. */
interface PatchOp {
  path: Array<string | number>;
  value?: unknown;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function readJsonBody(request: YormRequest): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    throw new BadRequestError("request body must be valid JSON");
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parsePatchOp(value: unknown): PatchOp {
  if (!isPlainObject(value)) {
    throw new BadRequestError("each patch operation must be an object with a path array");
  }
  const path = value["path"];
  if (
    !Array.isArray(path) ||
    path.length === 0 ||
    !path.every((segment) => typeof segment === "string" || typeof segment === "number")
  ) {
    throw new BadRequestError(
      "patch path must be a non-empty array of string keys and number indices",
    );
  }
  return { path: path as Array<string | number>, value: value["value"] };
}

const PROPOSAL_OPS = ["set", "insert", "remove"] as const;
const PROPOSAL_STATUSES = ["proposed", "accepted", "rejected", "superseded"] as const;

/** Validates a POST /proposals body. */
function parseProposeBody(value: unknown): {
  path: Array<string | number>;
  op: ProposalOp;
  proposedValue?: unknown;
  actor: string;
} {
  if (!isPlainObject(value)) {
    throw new BadRequestError("proposal body must be a JSON object");
  }
  const { path } = parsePatchOp({ path: value["path"] });
  const op = value["op"];
  if (typeof op !== "string" || !(PROPOSAL_OPS as readonly string[]).includes(op)) {
    throw new BadRequestError('proposal op must be "set", "insert", or "remove"');
  }
  const actor = value["actor"];
  if (typeof actor !== "string" || actor.length === 0) {
    throw new BadRequestError("proposal actor must be a non-empty string");
  }
  if (op !== "remove" && value["proposedValue"] === undefined) {
    throw new BadRequestError(`proposal op "${op}" requires a proposedValue`);
  }
  return {
    path,
    op: op as ProposalOp,
    ...(value["proposedValue"] !== undefined ? { proposedValue: value["proposedValue"] } : {}),
    actor,
  };
}

/** `resolvedBy` from an optional JSON body, defaulting to `"unknown"`. */
async function resolvedByFrom(request: YormRequest): Promise<string> {
  const body: unknown = await request.json().catch(() => undefined);
  const resolvedBy = isPlainObject(body) ? body["resolvedBy"] : undefined;
  return typeof resolvedBy === "string" && resolvedBy.length > 0 ? resolvedBy : "unknown";
}

type SessionHandler = (
  request: YormRequest,
  session: DocumentSession,
  type: string,
  id: string,
) => Promise<YormResponse>;

const json = (body: unknown, status = 200): YormResponse => ({ status, body });
const noContent: YormResponse = { status: 204 };

/**
 * Builds the `/docs/*` route table.
 */
export function createHttpRoutes(
  yorm: Yorm,
  sessions: SessionCache,
  options: YormServerOptions,
): YormRoute[] {
  /**
   * Authorize (plus per-subtree write authorization when `writeScope` is
   * given) → open cached session → handler; maps errors to 400/404/409/500.
   */
  const handle =
    (fn: SessionHandler, writeScope?: WriteScope) =>
    async (request: YormRequest): Promise<YormResponse> => {
      const type = request.param("type") ?? "";
      const id = request.param("id") ?? "";
      if (!(await authorize(request, options, type, id))) {
        return json({ error: "forbidden" }, 403);
      }
      if (
        writeScope !== undefined &&
        !(await authorizeWrite(request, options, type, id, writeScope))
      ) {
        return json({ error: "forbidden" }, 403);
      }
      try {
        const session = await sessions.get(type, id);
        return await fn(request, session, type, id);
      } catch (error) {
        if (error instanceof BadRequestError) {
          return json({ error: error.message }, 400);
        }
        if (error instanceof ProposalNotFoundError) {
          return json({ error: error.message }, 404);
        }
        if (error instanceof ProposalStateError) {
          return json({ error: error.message }, 409);
        }
        return json({ error: errorMessage(error) }, 500);
      }
    };

  const route = (
    method: HttpMethod,
    path: string,
    fn: SessionHandler,
    writeScope?: WriteScope,
  ): YormRoute => ({ method, path, handle: handle(fn, writeScope) });

  return [
    route("GET", "/docs/:type/:id", async (_request, session, type, id) => {
      // "Not found" (pragmatic v1 definition): the document was never
      // persisted (no stored snapshot) AND no in-memory state exists
      // (version 0) — merely opening a session must not create a document.
      const stored = await yorm.stores.documents.loadDocument(type, id);
      const version = session.projectionState().version;
      if (stored === null && version === 0) {
        return json({ error: "not found" }, 404);
      }
      return json({ object: session.read(), version });
    }),

    route(
      "PUT",
      "/docs/:type/:id",
      async (request, session) => {
        const body = await readJsonBody(request);
        if (!isPlainObject(body)) {
          throw new BadRequestError("document body must be a JSON object");
        }
        await session.write(body);
        return json({ version: session.projectionState().version });
      },
      "canonical",
    ),

    route(
      "PATCH",
      "/docs/:type/:id",
      async (request, session) => {
        const body = await readJsonBody(request);
        const ops = (Array.isArray(body) ? body : [body]).map(parsePatchOp);
        // v1: one semantic transaction per operation (documented in README).
        // PATCH assumes the JSON codec's default root key.
        for (const op of ops) {
          try {
            applyJsonPatchLike(session.doc, DEFAULT_ROOT_KEY, op.path, op.value);
          } catch (error) {
            throw new BadRequestError(errorMessage(error));
          }
        }
        return json({ version: session.projectionState().version });
      },
      "canonical",
    ),

    route("GET", "/docs/:type/:id/projection-state", async (_request, session, type, id) => {
      const state = session.projectionState();
      const mappings = yorm.mappings.filter((mapping) => mapping.documentType === type);
      const checkpoints = await Promise.all(
        mappings.map(async (mapping) => ({
          mappingName: mapping.name,
          mappingVersion: mapping.version,
          state: await yorm.stores.projections.getState(id, mapping.name),
        })),
      );
      return json({ ...state, checkpoints });
    }),

    route("POST", "/docs/:type/:id/flush", async (_request, session) => {
      await session.signal("flush");
      const state = session.projectionState();
      return json({ version: state.version, pending: state.pending });
    }),

    route("POST", "/docs/:type/:id/signal", async (request, session) => {
      const body = await readJsonBody(request);
      const kind = isPlainObject(body) ? body["kind"] : undefined;
      if (kind !== "blur" && kind !== "flush") {
        throw new BadRequestError('signal kind must be "blur" or "flush"');
      }
      await session.signal(kind);
      const state = session.projectionState();
      return json({ version: state.version, pending: state.pending });
    }),

    route("POST", "/docs/:type/:id/policy", async (request, session) => {
      const policy = parsePolicy(await readJsonBody(request));
      if (policy === null) {
        throw new BadRequestError(
          'policy must be { kind: "every-change" | "on-blur" | "idle" | "explicit", ms? }',
        );
      }
      // v1 (same simplification as @yorm/yjs, documented): the policy applies
      // to the shared per-document scheduler, not to one HTTP "session".
      session.setPolicy(policy);
      return noContent;
    }),

    // --- Proposed changes (PLAN.md M7) -----------------------------------

    route("GET", "/docs/:type/:id/proposals", async (request, session) => {
      const status = request.query("status");
      if (status !== undefined && !(PROPOSAL_STATUSES as readonly string[]).includes(status)) {
        throw new BadRequestError(
          'status filter must be "proposed", "accepted", "rejected", or "superseded"',
        );
      }
      const filter = status !== undefined ? { status: status as ProposalStatus } : undefined;
      return json({ proposals: session.proposals().list(filter) });
    }),

    route(
      "POST",
      "/docs/:type/:id/proposals",
      async (request, session) => {
        const input = parseProposeBody(await readJsonBody(request));
        const proposal = session.proposals().propose(input);
        return json({ proposal }, 201);
      },
      "proposals",
    ),

    // Accepting writes canonical state, so accept routes need "canonical".
    route(
      "POST",
      "/docs/:type/:id/proposals/:pid/accept",
      async (request, session) => {
        const pid = request.param("pid") ?? "";
        const result = session.proposals().accept(pid, await resolvedByFrom(request));
        if (result.conflict) {
          return json({ conflict: true, currentValue: result.currentValue ?? null }, 409);
        }
        return json({ conflict: false, version: session.projectionState().version });
      },
      "canonical",
    ),

    route(
      "POST",
      "/docs/:type/:id/proposals/:pid/accept-anyway",
      async (request, session) => {
        const pid = request.param("pid") ?? "";
        session.proposals().acceptAnyway(pid, await resolvedByFrom(request));
        return json({ conflict: false, version: session.projectionState().version });
      },
      "canonical",
    ),

    route(
      "POST",
      "/docs/:type/:id/proposals/:pid/reject",
      async (request, session) => {
        const pid = request.param("pid") ?? "";
        session.proposals().reject(pid, await resolvedByFrom(request));
        return json({ ok: true });
      },
      "canonical",
    ),

    route(
      "DELETE",
      "/docs/:type/:id/proposals/:pid",
      async (request, session) => {
        session.proposals().withdraw(request.param("pid") ?? "");
        return noContent;
      },
      "proposals",
    ),

    // Deleting resolved history rewrites the shared subtree for everyone, so
    // it needs the "canonical" write scope (an editor/moderator action).
    route(
      "POST",
      "/docs/:type/:id/proposals/clear-resolved",
      async (_request, session) => {
        const cleared = session.proposals().clearResolved();
        return json({ cleared });
      },
      "canonical",
    ),
  ];
}
