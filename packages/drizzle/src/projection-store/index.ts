/**
 * `ProjectionStore` on Drizzle (better-sqlite3 driver).
 *
 * Identifier validation, scope conditions and checkpoint mapping live in
 * `./shared.js`; this file holds only what is SQLite-specific — the
 * `ON CONFLICT … DO UPDATE` upsert and the `NOT IN (VALUES …)` reconcile —
 * plus the synchronous better-sqlite3 transaction that runs a whole plan and
 * its checkpoint advance as one unit.
 */
import type {
  ProjectionCheckpoint,
  ProjectionPlan,
  ProjectionStateRecord,
  ProjectionStore,
  ReconcileOperation,
  UpsertOperation,
} from "@yorm/core";
import type { SQL } from "drizzle-orm";
import { and, eq, sql } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { SQLiteSyncDialect } from "drizzle-orm/sqlite-core";
import { yormProjectionState } from "../schema.js";
import type { DrizzleProjectionStoreOptions, ProjectionStatement } from "./shared.js";
import {
  COMMA,
  assertIdentifier,
  bindable,
  buildKeepRows,
  buildScopeCondition,
  cell,
  tableResolver,
  toStateRecord,
} from "./shared.js";

export type {
  DrizzleProjectionStoreOptions,
  ProjectionCommit,
  ProjectionStatement,
  ProjectionTableConfig,
} from "./shared.js";

function buildUpsert(op: UpsertOperation, table: string): SQL {
  const keyColumns = Object.keys(op.key);
  const ownedColumns = op.ownedColumns.map((column) => assertIdentifier(column, "column"));
  for (const column of keyColumns) assertIdentifier(column, "column");

  const insertColumns = [...keyColumns, ...ownedColumns];
  const columnList = sql.join(
    insertColumns.map((column) => sql.identifier(column)),
    COMMA,
  );
  const valueList = sql.join(
    insertColumns.map((column) =>
      column in op.key
        ? sql`${bindable(cell(op.key, column, "key", table))}`
        : sql`${bindable(cell(op.values, column, "owned", table))}`,
    ),
    COMMA,
  );
  const conflictTarget = sql.join(
    keyColumns.map((column) => sql.identifier(column)),
    COMMA,
  );

  if (ownedColumns.length === 0) {
    return sql`insert into ${sql.identifier(table)} (${columnList}) values (${valueList}) on conflict (${conflictTarget}) do nothing`;
  }
  const setList = sql.join(
    ownedColumns.map(
      (column) => sql`${sql.identifier(column)} = excluded.${sql.identifier(column)}`,
    ),
    COMMA,
  );
  return sql`insert into ${sql.identifier(table)} (${columnList}) values (${valueList}) on conflict (${conflictTarget}) do update set ${setList}`;
}

function buildReconcile(op: ReconcileOperation, table: string): SQL {
  if (Object.keys(op.scope).length === 0) {
    throw new Error(
      `drizzleProjectionStore: reconcile for table "${table}" has an empty scope; refusing an unconstrained delete`,
    );
  }
  const scopeCondition = buildScopeCondition(op.scope);
  if (op.keepKeys.length === 0) {
    return sql`delete from ${sql.identifier(table)} where ${scopeCondition}`;
  }

  const keyColumns = op.keyColumns.map((column) => assertIdentifier(column, "column"));
  const keyTuple = sql.join(
    keyColumns.map((column) => sql.identifier(column)),
    COMMA,
  );
  const keepRows = buildKeepRows(op.keepKeys, keyColumns, table);
  return sql`delete from ${sql.identifier(table)} where ${scopeCondition} and (${keyTuple}) not in (values ${keepRows})`;
}

/**
 * Creates a {@link ProjectionStore} that applies plans to SQLite projection
 * tables and tracks checkpoints in `yorm_projection_state`.
 *
 * Requirements on projection tables: the plan's key columns must be covered
 * by a `PRIMARY KEY` or `UNIQUE` constraint (upserts use
 * `ON CONFLICT (key columns)`).
 */
export function drizzleProjectionStore<TSchema extends Record<string, unknown>>(
  db: BetterSQLite3Database<TSchema>,
  options?: DrizzleProjectionStoreOptions,
): ProjectionStore {
  const registry = options?.tables ?? {};
  const resolveTable = tableResolver(registry);
  const onCommit = options?.onCommit;
  const dialect = new SQLiteSyncDialect();

  return {
    async applyPlan(plan: ProjectionPlan): Promise<void> {
      const statements: ProjectionStatement[] = [];
      db.transaction((tx) => {
        for (const op of plan.operations) {
          const table = resolveTable(op.table);
          const statement = op.kind === "upsert" ? buildUpsert(op, table) : buildReconcile(op, table);
          if (onCommit) statements.push(dialect.sqlToQuery(statement));
          tx.run(statement);
        }
        const checkpoint = plan.checkpoint;
        const advance = tx
          .insert(yormProjectionState)
          .values({
            documentId: checkpoint.documentId,
            mappingName: checkpoint.mappingName,
            mappingVersion: checkpoint.mappingVersion,
            sourceDocumentVersion: checkpoint.sourceDocumentVersion,
            status: "ok",
            projectedAt: new Date(),
            error: null,
          })
          .onConflictDoUpdate({
            target: [yormProjectionState.documentId, yormProjectionState.mappingName],
            set: {
              mappingVersion: checkpoint.mappingVersion,
              sourceDocumentVersion: checkpoint.sourceDocumentVersion,
              status: "ok",
              projectedAt: new Date(),
              error: null,
            },
          });
        if (onCommit) statements.push(advance.toSQL());
        advance.run();
      });
      // After the transaction, so a rollback reports no statements.
      onCommit?.({
        mapping: plan.mapping,
        documentId: plan.documentId,
        documentType: plan.documentType,
        documentVersion: plan.documentVersion,
        origin: plan.origin,
        statements,
      });
    },

    async getState(documentId: string, mappingName: string): Promise<ProjectionStateRecord | null> {
      const rows = await db
        .select()
        .from(yormProjectionState)
        .where(
          and(
            eq(yormProjectionState.documentId, documentId),
            eq(yormProjectionState.mappingName, mappingName),
          ),
        )
        .limit(1);
      const row = rows[0];
      return row ? toStateRecord(row) : null;
    },

    async listFailures(): Promise<ProjectionStateRecord[]> {
      const rows = await db
        .select()
        .from(yormProjectionState)
        .where(eq(yormProjectionState.status, "error"));
      return rows.map(toStateRecord);
    },

    async recordFailure(checkpoint: ProjectionCheckpoint, error: string): Promise<void> {
      await db
        .insert(yormProjectionState)
        .values({
          documentId: checkpoint.documentId,
          mappingName: checkpoint.mappingName,
          mappingVersion: checkpoint.mappingVersion,
          sourceDocumentVersion: checkpoint.sourceDocumentVersion,
          status: "error",
          projectedAt: new Date(),
          error,
        })
        .onConflictDoUpdate({
          target: [yormProjectionState.documentId, yormProjectionState.mappingName],
          set: {
            mappingVersion: checkpoint.mappingVersion,
            sourceDocumentVersion: checkpoint.sourceDocumentVersion,
            status: "error",
            projectedAt: new Date(),
            error,
          },
        });
    },
  };
}
