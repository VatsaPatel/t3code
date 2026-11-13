// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalConsole:off globalFetch:off globalTimers:off -- fork-only plain-Node module; reads foreign files synchronously on a bounded timer.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

/**
 * Fork-only state in its own file so upstream's migration table never sees a personal id.
 * Tables are created with IF NOT EXISTS; add columns with guarded ALTERs, never renumber.
 */
export class PersonalStore {
  readonly db: NodeSqlite.DatabaseSync;

  constructor(stateDir: string) {
    NodeFS.mkdirSync(stateDir, { recursive: true });
    this.db = new NodeSqlite.DatabaseSync(NodePath.join(stateDir, "personal.sqlite"));
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS personal_ask_cache (
        key TEXT PRIMARY KEY,
        revision TEXT NOT NULL,
        waiting INTEGER NOT NULL,
        ask TEXT,
        model TEXT NOT NULL,
        classified_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS personal_dismissed (
        key TEXT PRIMARY KEY,
        revision TEXT NOT NULL,
        dismissed_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS personal_digest (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        markdown TEXT NOT NULL,
        generated_at INTEGER NOT NULL,
        window_hours INTEGER NOT NULL,
        session_count INTEGER NOT NULL,
        model TEXT NOT NULL
      );
    `);
  }

  getAsk(key: string) {
    return this.db
      .prepare("SELECT revision, waiting, ask, classified_at FROM personal_ask_cache WHERE key = ?")
      .get(key) as
      | { revision: string; waiting: number; ask: string | null; classified_at: number }
      | undefined;
  }

  putAsk(key: string, revision: string, waiting: boolean, ask: string | null, model: string) {
    this.db
      .prepare(
        `INSERT INTO personal_ask_cache (key, revision, waiting, ask, model, classified_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET revision = excluded.revision, waiting = excluded.waiting,
           ask = excluded.ask, model = excluded.model, classified_at = excluded.classified_at`,
      )
      .run(key, revision, waiting ? 1 : 0, ask, model, Date.now());
  }

  latestClassifiedAt(): number | null {
    const row = this.db.prepare("SELECT MAX(classified_at) AS at FROM personal_ask_cache").get() as
      | { at: number | null }
      | undefined;
    return row?.at ?? null;
  }

  /** A dismissal holds only for the agent turn it was made on; a new turn resurfaces the chat. */
  isDismissed(key: string, revision: string) {
    const row = this.db
      .prepare("SELECT revision FROM personal_dismissed WHERE key = ?")
      .get(key) as { revision: string } | undefined;
    return row?.revision === revision;
  }

  setDismissed(key: string, revision: string, dismissed: boolean) {
    if (dismissed)
      this.db
        .prepare(
          `INSERT INTO personal_dismissed (key, revision, dismissed_at) VALUES (?, ?, ?)
           ON CONFLICT(key) DO UPDATE SET revision = excluded.revision, dismissed_at = excluded.dismissed_at`,
        )
        .run(key, revision, Date.now());
    else this.db.prepare("DELETE FROM personal_dismissed WHERE key = ?").run(key);
  }

  latestDigest() {
    return this.db
      .prepare(
        "SELECT markdown, generated_at, window_hours, session_count, model FROM personal_digest ORDER BY id DESC LIMIT 1",
      )
      .get() as
      | {
          markdown: string;
          generated_at: number;
          window_hours: number;
          session_count: number;
          model: string;
        }
      | undefined;
  }

  putDigest(markdown: string, windowHours: number, sessionCount: number, model: string) {
    this.db
      .prepare(
        "INSERT INTO personal_digest (markdown, generated_at, window_hours, session_count, model) VALUES (?, ?, ?, ?, ?)",
      )
      .run(markdown, Date.now(), windowHours, sessionCount, model);
    this.db.exec(
      "DELETE FROM personal_digest WHERE id NOT IN (SELECT id FROM personal_digest ORDER BY id DESC LIMIT 30)",
    );
  }
}
