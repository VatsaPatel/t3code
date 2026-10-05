/**
 * HermesStateReader - read-only access to a Hermes profile's `state.db`.
 *
 * Opens a second, read-only SQLite connection to the live Hermes store and
 * never writes. Hermes runs in WAL mode, so readers see committed rows while
 * Hermes keeps writing; a short busy timeout tolerates checkpoints. Every
 * query is per session or uses the `COALESCE(last_activity_at, started_at)`
 * expression index, so a poll stays cheap on a multi-GB store.
 *
 * @module personal/sync/HermesStateReader
 */
import * as NodeSqlite from "node:sqlite";

export interface HermesSessionRow {
  readonly id: string;
  readonly source: string;
  readonly parentSessionId: string | null;
  readonly title: string | null;
  readonly model: string | null;
  /** `model_config._delegate_from`: set on delegate/subagent children. */
  readonly delegateFrom: string | null;
  /** `model_config._branched_from`: set on user-visible branches. */
  readonly branchedFrom: string | null;
  readonly startedAt: number;
  /** Epoch seconds of the newest activity, falling back to the start. */
  readonly activityAt: number;
  readonly archived: boolean;
  readonly hidden: boolean;
  readonly cwd: string | null;
  readonly originChatName: string | null;
  readonly originChatId: string | null;
}

interface HermesMessageRow {
  readonly id: number;
  readonly role: "user" | "assistant";
  readonly text: string;
  /** Epoch seconds. */
  readonly timestamp: number;
}

interface SessionRecord {
  readonly id: string;
  readonly source: string;
  readonly parent_session_id: string | null;
  readonly title: string | null;
  readonly model: string | null;
  readonly model_config: string | null;
  readonly started_at: number;
  readonly activity_at: number;
  readonly archived: number | null;
  readonly hidden: number | null;
  readonly cwd: string | null;
  readonly origin_json: string | null;
}

interface MessageRecord {
  readonly id: number;
  readonly role: string;
  readonly content: string | null;
  readonly timestamp: number;
  readonly display_key: number;
}

const SESSION_COLUMNS = `
  id, source, parent_session_id, title, model, model_config, started_at,
  COALESCE(last_activity_at, started_at) AS activity_at, archived, hidden, cwd, origin_json
`;

/**
 * Rows Hermes itself shows in a transcript: user and assistant turns that are
 * active or compacted history, minus compression summaries and hidden or
 * internal notification rows. Duplicate copies of one display row share a
 * `display_order`, so callers keep one row per display key.
 */
const VISIBLE_MESSAGES = `
  session_id = ?
  AND (active = 1 OR compacted = 1)
  AND role IN ('user', 'assistant')
  AND COALESCE(_compressed_summary, 0) = 0
  AND (display_kind IS NULL OR display_kind NOT IN ('hidden', 'internal_notification'))
`;

const readJsonObject = (text: string | null): Record<string, unknown> => {
  if (text === null || text.trim() === "") return {};
  try {
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
};

const stringOrNull = (value: unknown): string | null =>
  typeof value === "string" && value.trim() !== "" ? value : null;

const toSession = (record: SessionRecord): HermesSessionRow => {
  const modelConfig = readJsonObject(record.model_config);
  const origin = readJsonObject(record.origin_json);
  return {
    id: record.id,
    source: record.source,
    parentSessionId: record.parent_session_id,
    title: stringOrNull(record.title),
    model: stringOrNull(record.model),
    delegateFrom: stringOrNull(modelConfig._delegate_from),
    branchedFrom: stringOrNull(modelConfig._branched_from),
    startedAt: record.started_at,
    activityAt: record.activity_at,
    archived: record.archived === 1,
    hidden: record.hidden === 1,
    cwd: stringOrNull(record.cwd),
    originChatName: stringOrNull(origin.chat_name),
    originChatId: stringOrNull(origin.chat_id),
  };
};

/** Keep the first row per display key; rows arrive in the caller's preferred order. */
const dedupeDisplayRows = (records: ReadonlyArray<MessageRecord>): Array<HermesMessageRow> => {
  const seen = new Set<number>();
  const rows: Array<HermesMessageRow> = [];
  for (const record of records) {
    if (seen.has(record.display_key)) continue;
    seen.add(record.display_key);
    const text = record.content?.trim() ?? "";
    if (text === "" || (record.role !== "user" && record.role !== "assistant")) continue;
    rows.push({ id: record.id, role: record.role, text, timestamp: record.timestamp });
  }
  return rows;
};

export interface HermesStateReader {
  /** Sessions whose newest activity is after `sinceEpochSeconds`, newest first. */
  readonly listSessionsActiveSince: (sinceEpochSeconds: number) => Array<HermesSessionRow>;
  readonly getSession: (sessionId: string) => HermesSessionRow | null;
  /** The newest `limit` visible messages in display order, plus the visible total. */
  readonly recentMessages: (
    sessionId: string,
    limit: number,
  ) => { readonly messages: Array<HermesMessageRow>; readonly total: number };
  /** Visible messages newer than `afterEpochSeconds`, in display order. */
  readonly messagesAfter: (
    sessionId: string,
    afterEpochSeconds: number,
    limit: number,
  ) => Array<HermesMessageRow>;
  readonly close: () => void;
}

/** Throws when the store is missing or unreadable; callers map that to a sync error. */
export function openHermesStateReader(stateDbPath: string): HermesStateReader {
  const database = new NodeSqlite.DatabaseSync(stateDbPath, { readOnly: true });
  try {
    database.exec("PRAGMA busy_timeout = 2000");
    database.exec("PRAGMA query_only = 1");
  } catch (cause) {
    database.close();
    throw cause;
  }
  const listSince = database.prepare(`
    SELECT ${SESSION_COLUMNS}
    FROM sessions
    WHERE COALESCE(last_activity_at, started_at) > ?
    ORDER BY COALESCE(last_activity_at, started_at) DESC
  `);
  const getOne = database.prepare(`SELECT ${SESSION_COLUMNS} FROM sessions WHERE id = ?`);
  const recent = database.prepare(`
    SELECT id, role, content, timestamp, COALESCE(display_order, id) AS display_key
    FROM messages
    WHERE ${VISIBLE_MESSAGES}
    ORDER BY COALESCE(display_order, id) DESC, active DESC, id DESC
    LIMIT ?
  `);
  const count = database.prepare(`
    SELECT COUNT(DISTINCT COALESCE(display_order, id)) AS total
    FROM messages
    WHERE ${VISIBLE_MESSAGES}
      AND role IN ('user', 'assistant')
      AND TRIM(COALESCE(content, '')) <> ''
  `);
  const after = database.prepare(`
    SELECT id, role, content, timestamp, COALESCE(display_order, id) AS display_key
    FROM messages
    WHERE ${VISIBLE_MESSAGES} AND timestamp > ?
    ORDER BY COALESCE(display_order, id) ASC, active DESC, id DESC
    LIMIT ?
  `);

  return {
    listSessionsActiveSince: (since) =>
      (listSince.all(since) as unknown as Array<SessionRecord>).map(toSession),
    getSession: (sessionId) => {
      const record = getOne.get(sessionId) as SessionRecord | undefined;
      return record === undefined ? null : toSession(record);
    },
    recentMessages: (sessionId, limit) => {
      // Duplicate display copies can take slots, so over-fetch before trimming.
      const rows = dedupeDisplayRows(
        recent.all(sessionId, limit * 2) as unknown as Array<MessageRecord>,
      )
        .slice(0, limit)
        .toReversed();
      const total = (count.get(sessionId) as { total: number } | undefined)?.total ?? rows.length;
      return { messages: rows, total };
    },
    messagesAfter: (sessionId, afterEpochSeconds, limit) =>
      dedupeDisplayRows(
        after.all(sessionId, afterEpochSeconds, limit * 2) as unknown as Array<MessageRecord>,
      ).slice(0, limit),
    close: () => database.close(),
  };
}
