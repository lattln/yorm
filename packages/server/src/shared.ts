/**
 * Shared server internals: the per-document session cache, the authorization
 * hooks, and projection-trigger-policy parsing — used by both the HTTP routes
 * (`src/http/`) and the WebSocket endpoint (`src/websocket/`).
 */
import type { DocumentSession, ProjectionTriggerPolicy, Yorm } from "@yorm/yjs";

import type { WriteScope, YormRequest, YormServerOptions } from "./types.js";

/**
 * Per-document session cache. Sessions are opened once and reused for the
 * lifetime of the server (never closed per request): HTTP requests are
 * stateless, and `@yorm/yjs` shares one channel (doc + scheduler) per
 * document underneath, so caching the session is both correct and cheap.
 */
export interface SessionCache {
  get(type: string, id: string): Promise<DocumentSession>;
}

/**
 * Creates the session cache. On first open per document the server applies
 * `options.defaultPolicy` (if any) and arms the `options.maxLagMs` safety
 * flush (if any).
 */
export function createSessionCache(yorm: Yorm, options: YormServerOptions): SessionCache {
  const cache = new Map<string, Promise<DocumentSession>>();
  return {
    get(type: string, id: string): Promise<DocumentSession> {
      const key = `${type}/${id}`;
      let pending = cache.get(key);
      if (!pending) {
        pending = openSession(yorm, type, id, options);
        cache.set(key, pending);
      }
      return pending;
    },
  };
}

async function openSession(
  yorm: Yorm,
  type: string,
  id: string,
  options: YormServerOptions,
): Promise<DocumentSession> {
  const session = await yorm.open(type, id);
  if (options.defaultPolicy) {
    session.setPolicy(options.defaultPolicy);
  }
  if (options.maxLagMs !== undefined) {
    attachMaxLagFlush(session, options.maxLagMs);
  }
  return session;
}

/**
 * Server-level max-lag safety cap: after a persisted change, at most
 * `maxLagMs` may pass before a flush is forced, so `explicit` / `on-blur`
 * sessions cannot defer projection forever. (The scheduler in `@yorm/yjs`
 * has its own `maxLagMs`; this option covers Yorm instances created without
 * one.) Timers only exist while changes are pending.
 */
function attachMaxLagFlush(session: DocumentSession, maxLagMs: number): void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  session.subscribe(() => {
    if (timer !== null) {
      return;
    }
    timer = setTimeout(() => {
      timer = null;
      void session.signal("flush");
    }, maxLagMs);
  });
}

/** Runs the `onAuthorize` hook; absent hook means allow. */
export async function authorize(
  request: YormRequest,
  options: YormServerOptions,
  type: string,
  id: string,
): Promise<boolean> {
  if (!options.onAuthorize) {
    return true;
  }
  return await options.onAuthorize(request, { type, id });
}

/** Runs the per-subtree `onAuthorizeWrite` hook; absent hook means allow. */
export async function authorizeWrite(
  request: YormRequest,
  options: YormServerOptions,
  type: string,
  id: string,
  scope: WriteScope,
): Promise<boolean> {
  if (!options.onAuthorizeWrite) {
    return true;
  }
  return await options.onAuthorizeWrite(request, { type, id }, scope);
}

const POLICY_KINDS = ["every-change", "on-blur", "idle", "explicit"] as const;

/**
 * Validates an untrusted value (request body or query-derived object) as a
 * {@link ProjectionTriggerPolicy}. Returns `null` when invalid.
 */
export function parsePolicy(value: unknown): ProjectionTriggerPolicy | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const { kind, ms } = value as { kind?: unknown; ms?: unknown };
  if (typeof kind !== "string" || !(POLICY_KINDS as readonly string[]).includes(kind)) {
    return null;
  }
  if (kind === "idle") {
    if (ms === undefined) {
      return { kind };
    }
    if (typeof ms !== "number" || !Number.isFinite(ms) || ms <= 0) {
      return null;
    }
    return { kind, ms };
  }
  if (ms !== undefined) {
    return null;
  }
  return { kind } as ProjectionTriggerPolicy;
}

/**
 * Maps the WebSocket `?policy=` / `?idleMs=` query params to a policy.
 * Returns `null` when the param is absent or invalid (invalid values are
 * ignored so a typo cannot take a collaboration socket down).
 */
export function policyFromQuery(
  policy: string | undefined,
  idleMs: string | undefined,
): ProjectionTriggerPolicy | null {
  if (policy === undefined) {
    return null;
  }
  const ms = idleMs === undefined ? undefined : Number(idleMs);
  return parsePolicy({ kind: policy, ...(policy === "idle" && ms !== undefined ? { ms } : {}) });
}
