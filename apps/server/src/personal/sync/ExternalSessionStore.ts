/**
 * ExternalSessionStore - the `personal_external_sessions` link table: one row
 * per T3 thread mirrored from a native Codex, Claude, or Hermes session, with
 * the sync cursor for that session.
 *
 * The table is created idempotently when the layer builds instead of through a
 * numbered migration. Effect's migrator skips every id at or below the latest
 * recorded one, so a fork-only migration id would hide upstream's next
 * migration after a rebase.
 *
 * `native_updated_at` is the cursor: the timestamp of the newest native message
 * already reflected in the thread (appended or absorbed). `last_synced_at` is
 * when the sync last started reading the session; native activity after it
 * means the session changed. `native_title` is the last native title applied,
 * so a T3 rename is detected and never overwritten. `native_source_path` is the
 * transcript file for Codex and Claude sessions.
 *
 * @module personal/sync/ExternalSessionStore
 */
import { ThreadId, type PersonalExternalSession } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

class ExternalSessionStoreError extends Schema.TaggedError<ExternalSessionStoreError>()(
  "ExternalSessionStoreError",
  { operation: Schema.String, cause: Schema.Defect() },
) {
  override get message(): string {
    return `External session store operation '${this.operation}' failed.`;
  }
}

export interface ExternalSessionRow extends PersonalExternalSession {
  readonly nativeTitle: string | null;
  readonly nativeSourcePath: string | null;
}

interface Row {
  readonly thread_id: string;
  readonly provider_instance_id: string;
  readonly driver: string;
  readonly native_session_id: string;
  readonly origin: string;
  readonly origin_detail: string | null;
  readonly cwd: string | null;
  readonly native_message_count: number;
  readonly native_updated_at: string;
  readonly last_synced_at: string;
  readonly parent_native_session_id: string | null;
  readonly native_title: string | null;
  readonly native_source_path: string | null;
}

const fromRow = (row: Row): ExternalSessionRow => ({
  threadId: ThreadId.make(row.thread_id),
  providerInstanceId: row.provider_instance_id,
  driver: row.driver,
  nativeSessionId: row.native_session_id,
  origin: row.origin,
  originDetail: row.origin_detail,
  cwd: row.cwd,
  nativeMessageCount: row.native_message_count,
  nativeUpdatedAt: row.native_updated_at,
  lastSyncedAt: row.last_synced_at,
  parentNativeSessionId: row.parent_native_session_id,
  nativeTitle: row.native_title,
  nativeSourcePath: row.native_source_path,
});

export class ExternalSessionStore extends Context.Service<
  ExternalSessionStore,
  {
    readonly get: (
      threadId: ThreadId,
    ) => Effect.Effect<ExternalSessionRow | null, ExternalSessionStoreError>;
    readonly list: (filter?: {
      readonly driver?: string;
    }) => Effect.Effect<ReadonlyArray<ExternalSessionRow>, ExternalSessionStoreError>;
    readonly upsert: (row: ExternalSessionRow) => Effect.Effect<void, ExternalSessionStoreError>;
  }
>()("t3/personal/sync/ExternalSessionStore") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const fail = (operation: string) => (cause: unknown) =>
    new ExternalSessionStoreError({ operation, cause });

  yield* sql`
    CREATE TABLE IF NOT EXISTS personal_external_sessions (
      thread_id TEXT PRIMARY KEY,
      provider_instance_id TEXT NOT NULL,
      driver TEXT NOT NULL,
      native_session_id TEXT NOT NULL,
      origin TEXT NOT NULL,
      origin_detail TEXT,
      cwd TEXT,
      native_message_count INTEGER NOT NULL,
      native_updated_at TEXT NOT NULL,
      last_synced_at TEXT NOT NULL,
      parent_native_session_id TEXT,
      native_title TEXT,
      native_source_path TEXT
    )
  `.pipe(Effect.orDie);
  yield* sql`
    CREATE INDEX IF NOT EXISTS personal_external_sessions_native_idx
    ON personal_external_sessions(driver, native_session_id)
  `.pipe(Effect.orDie);

  const get: ExternalSessionStore["Service"]["get"] = (threadId) =>
    sql<Row>`SELECT * FROM personal_external_sessions WHERE thread_id = ${threadId}`.pipe(
      Effect.map((rows) => (rows[0] === undefined ? null : fromRow(rows[0]))),
      Effect.mapError(fail("get")),
    );

  const list: ExternalSessionStore["Service"]["list"] = (filter) =>
    (filter?.driver === undefined
      ? sql<Row>`SELECT * FROM personal_external_sessions ORDER BY native_updated_at DESC`
      : sql<Row>`
          SELECT * FROM personal_external_sessions
          WHERE driver = ${filter.driver}
          ORDER BY native_updated_at DESC
        `
    ).pipe(
      Effect.map((rows) => rows.map(fromRow)),
      Effect.mapError(fail("list")),
    );

  const upsert: ExternalSessionStore["Service"]["upsert"] = (row) =>
    sql`
      INSERT INTO personal_external_sessions (
        thread_id, provider_instance_id, driver, native_session_id, origin, origin_detail, cwd,
        native_message_count, native_updated_at, last_synced_at, parent_native_session_id,
        native_title, native_source_path
      ) VALUES (
        ${row.threadId}, ${row.providerInstanceId}, ${row.driver}, ${row.nativeSessionId},
        ${row.origin}, ${row.originDetail}, ${row.cwd}, ${row.nativeMessageCount},
        ${row.nativeUpdatedAt}, ${row.lastSyncedAt}, ${row.parentNativeSessionId},
        ${row.nativeTitle}, ${row.nativeSourcePath}
      )
      ON CONFLICT(thread_id) DO UPDATE SET
        origin = excluded.origin,
        origin_detail = excluded.origin_detail,
        cwd = excluded.cwd,
        native_message_count = excluded.native_message_count,
        native_updated_at = excluded.native_updated_at,
        last_synced_at = excluded.last_synced_at,
        parent_native_session_id = excluded.parent_native_session_id,
        native_title = excluded.native_title,
        native_source_path = excluded.native_source_path
    `.pipe(Effect.asVoid, Effect.mapError(fail("upsert")));

  return ExternalSessionStore.of({ get, list, upsert });
});

export const layer = Layer.effect(ExternalSessionStore, make);
