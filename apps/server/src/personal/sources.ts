// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalConsole:off globalFetch:off globalTimers:off -- fork-only plain-Node module; reads foreign files synchronously on a bounded timer.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

import type { PersonalSourceKind, PersonalSourceStatus } from "@t3tools/contracts";

/** A conversation whose newest message is the agent's, i.e. it may be waiting on the user. */
export interface AgentTail {
  readonly source: PersonalSourceKind;
  readonly sessionId: string;
  readonly origin: string;
  readonly title: string;
  readonly cwd: string | null;
  readonly lastUserText: string;
  readonly lastAgentText: string;
  readonly lastAgentAtMs: number;
  /** Changes whenever a new agent turn lands; keys the curation cache. */
  readonly revision: string;
  readonly resumeCommand: string;
}

export interface ScanResult {
  readonly tails: ReadonlyArray<AgentTail>;
  readonly status: PersonalSourceStatus;
}

const home = () => process.env.PERSONAL_HOME_DIR ?? NodeOS.homedir();
const clip = (text: string, max: number) =>
  text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;

const HERMES_ORIGIN: Record<string, string> = {
  slack: "Slack",
  whatsapp: "WhatsApp",
  cli: "Hermes CLI",
  tui: "Hermes TUI",
  desktop: "Hermes desktop",
  webui: "Hermes web",
  acp: "Hermes ACP",
};

const openReadOnly = (path: string) => new NodeSqlite.DatabaseSync(path, { readOnly: true });

export function scanHermes(sinceMs: number): ScanResult {
  const path = NodePath.join(home(), ".hermes", "state.db");
  if (!NodeFS.existsSync(path))
    return { tails: [], status: { kind: "hermes", available: false, detail: `${path} not found` } };
  let db: NodeSqlite.DatabaseSync | undefined;
  try {
    db = openReadOnly(path);
    const sessions = db
      .prepare(
        `SELECT id, source, title, cwd FROM sessions
         WHERE source IN (${Object.keys(HERMES_ORIGIN)
           .map(() => "?")
           .join(",")})
           AND COALESCE(last_activity_at, started_at) >= ? AND COALESCE(archived, 0) = 0
           AND COALESCE(hidden, 0) = 0
         ORDER BY COALESCE(last_activity_at, started_at) DESC LIMIT 200`,
      )
      .all(...Object.keys(HERMES_ORIGIN), sinceMs / 1000) as Array<{
      id: string;
      source: string;
      title: string | null;
      cwd: string | null;
    }>;
    const lastTwo = db.prepare(
      `SELECT id, role, content, timestamp FROM messages
       WHERE session_id = ? AND role IN ('user','assistant') AND COALESCE(content,'') <> ''
       ORDER BY id DESC LIMIT 2`,
    );
    const tails: AgentTail[] = [];
    for (const session of sessions) {
      const rows = lastTwo.all(session.id) as Array<{
        id: number;
        role: string;
        content: string;
        timestamp: number;
      }>;
      const [last, previous] = rows;
      if (!last || last.role !== "assistant") continue;
      tails.push({
        source: "hermes",
        sessionId: session.id,
        origin: HERMES_ORIGIN[session.source] ?? session.source,
        title: session.title?.trim() || clip(previous?.content ?? "Hermes chat", 80),
        cwd: session.cwd,
        lastUserText: clip(previous?.content ?? "", 1500),
        lastAgentText: last.content,
        lastAgentAtMs: last.timestamp * 1000,
        revision: String(last.id),
        resumeCommand: `hermes --resume ${session.id}`,
      });
    }
    return { tails, status: { kind: "hermes", available: true, detail: null } };
  } catch (cause) {
    return { tails: [], status: { kind: "hermes", available: false, detail: String(cause) } };
  } finally {
    db?.close();
  }
}

/** Reads the last `bytes` of a file as complete lines. */
function tailLines(path: string, bytes: number): string[] {
  const fd = NodeFS.openSync(path, "r");
  try {
    const size = NodeFS.fstatSync(fd).size;
    const start = Math.max(0, size - bytes);
    const buffer = Buffer.alloc(size - start);
    NodeFS.readSync(fd, buffer, 0, buffer.length, start);
    const lines = buffer.toString("utf8").split("\n");
    if (start > 0) lines.shift();
    return lines.filter((line) => line.length > 0);
  } finally {
    NodeFS.closeSync(fd);
  }
}

const parse = (line: string): Record<string, unknown> | null => {
  try {
    const value: unknown = JSON.parse(line);
    return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
};

const textOfContent = (content: unknown): string => {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part: unknown) =>
      part && typeof part === "object" && "type" in part && part.type === "text" && "text" in part
        ? String(part.text)
        : "",
    )
    .filter(Boolean)
    .join("\n");
};

// Codex `exec` runs are scripted and never wait on a person, so only interactive origins count.
const CODEX_INTERACTIVE_SOURCES = ["cli", "vscode"];

export function scanCodex(sinceMs: number): ScanResult {
  const path = NodePath.join(home(), ".codex", "state_5.sqlite");
  if (!NodeFS.existsSync(path))
    return { tails: [], status: { kind: "codex", available: false, detail: `${path} not found` } };
  let db: NodeSqlite.DatabaseSync | undefined;
  try {
    db = openReadOnly(path);
    const threads = db
      .prepare(
        `SELECT id, rollout_path, cwd, title, source, updated_at FROM threads
         WHERE archived = 0 AND updated_at >= ? AND source IN (${CODEX_INTERACTIVE_SOURCES.map(() => "?").join(",")})
           AND originator NOT LIKE 'acp-%'
         ORDER BY updated_at DESC LIMIT 50`,
      )
      .all(sinceMs / 1000, ...CODEX_INTERACTIVE_SOURCES) as Array<{
      id: string;
      rollout_path: string;
      cwd: string;
      title: string;
      source: string;
      updated_at: number;
    }>;
    const tails: AgentTail[] = [];
    for (const thread of threads) {
      if (!NodeFS.existsSync(thread.rollout_path)) continue;
      let lastUser = "";
      let lastAgent: { text: string; at: number } | null = null;
      for (const line of tailLines(thread.rollout_path, 256 * 1024)) {
        const record = parse(line);
        const payload = record?.payload as Record<string, unknown> | undefined;
        if (!payload) continue;
        if (payload.type === "user_message" && typeof payload.message === "string") {
          lastUser = payload.message;
          lastAgent = null;
        } else if (
          payload.type === "task_complete" &&
          typeof payload.last_agent_message === "string"
        )
          lastAgent = {
            text: payload.last_agent_message,
            at: Date.parse(String(record?.timestamp)),
          };
      }
      if (!lastAgent) continue;
      tails.push({
        source: "codex",
        sessionId: thread.id,
        origin: thread.source === "vscode" ? "Codex IDE" : "Codex CLI",
        title: clip(thread.title || lastUser, 80),
        cwd: thread.cwd,
        lastUserText: clip(lastUser, 1500),
        lastAgentText: lastAgent.text,
        lastAgentAtMs: lastAgent.at || thread.updated_at * 1000,
        revision: String(lastAgent.at),
        resumeCommand: `codex resume ${thread.id}`,
      });
    }
    return { tails, status: { kind: "codex", available: true, detail: null } };
  } catch (cause) {
    return { tails: [], status: { kind: "codex", available: false, detail: String(cause) } };
  } finally {
    db?.close();
  }
}

export function scanClaude(sinceMs: number): ScanResult {
  const root = NodePath.join(home(), ".claude", "projects");
  if (!NodeFS.existsSync(root))
    return { tails: [], status: { kind: "claude", available: false, detail: `${root} not found` } };
  try {
    const files: Array<{ path: string; mtimeMs: number }> = [];
    for (const dir of NodeFS.readdirSync(root)) {
      const full = NodePath.join(root, dir);
      let entries: string[];
      try {
        entries = NodeFS.readdirSync(full);
      } catch {
        continue;
      }
      for (const name of entries) {
        if (!name.endsWith(".jsonl")) continue;
        const path = NodePath.join(full, name);
        const mtimeMs = NodeFS.statSync(path).mtimeMs;
        if (mtimeMs >= sinceMs) files.push({ path, mtimeMs });
      }
    }
    files.sort((a, b) => b.mtimeMs - a.mtimeMs);
    const tails: AgentTail[] = [];
    for (const file of files.slice(0, 80)) {
      let title = "";
      let cwd: string | null = null;
      let interactive = false;
      let lastUser = "";
      let lastAgent: { text: string; at: number; uuid: string } | null = null;
      for (const line of tailLines(file.path, 512 * 1024)) {
        const record = parse(line);
        if (!record) continue;
        if (record.type === "ai-title" && typeof record.aiTitle === "string")
          title = record.aiTitle;
        if (record.entrypoint === "cli") interactive = true;
        if (typeof record.cwd === "string") cwd = record.cwd;
        if (record.isSidechain === true) continue;
        const message = record.message as Record<string, unknown> | undefined;
        if (record.type === "user" && message) {
          const text = textOfContent(message.content);
          if (text && !text.startsWith("<")) {
            lastUser = text;
            lastAgent = null;
          }
        } else if (record.type === "assistant" && message) {
          const text = textOfContent(message.content);
          if (text)
            lastAgent = {
              text,
              at: Date.parse(String(record.timestamp)),
              uuid: String(record.uuid),
            };
        }
      }
      // SDK sessions are driven by other programs (including T3 itself), not a person at a terminal.
      if (!interactive || !lastAgent) continue;
      const sessionId = NodePath.basename(file.path, ".jsonl");
      tails.push({
        source: "claude",
        sessionId,
        origin: "Claude Code",
        title: clip(title || lastUser || "Claude Code session", 80),
        cwd,
        lastUserText: clip(lastUser, 1500),
        lastAgentText: lastAgent.text,
        lastAgentAtMs: lastAgent.at || file.mtimeMs,
        revision: lastAgent.uuid,
        resumeCommand: `${cwd ? `cd ${JSON.stringify(cwd)} && ` : ""}claude --resume ${sessionId}`,
      });
    }
    return { tails, status: { kind: "claude", available: true, detail: null } };
  } catch (cause) {
    return { tails: [], status: { kind: "claude", available: false, detail: String(cause) } };
  }
}

export interface DigestSession {
  readonly source: string;
  readonly origin: string;
  readonly title: string;
  readonly lastAgentText: string;
}

/** Everything that happened in the window, excluding subagent noise; cron runs collapse per job. */
export function hermesActivity(sinceMs: number): DigestSession[] {
  const path = NodePath.join(home(), ".hermes", "state.db");
  if (!NodeFS.existsSync(path)) return [];
  const db = openReadOnly(path);
  try {
    const rows = db
      .prepare(
        `SELECT s.id, s.source, s.title,
          (SELECT content FROM messages m WHERE m.session_id = s.id AND m.role = 'assistant'
             AND COALESCE(m.content,'') <> '' ORDER BY m.id DESC LIMIT 1) AS last
         FROM sessions s
         WHERE s.source NOT IN ('subagent','oneshot') AND COALESCE(s.last_activity_at, s.started_at) >= ?
         ORDER BY COALESCE(s.last_activity_at, s.started_at) DESC LIMIT 150`,
      )
      .all(sinceMs / 1000) as Array<{
      id: string;
      source: string;
      title: string | null;
      last: string | null;
    }>;
    const seenCron = new Set<string>();
    const out: DigestSession[] = [];
    for (const row of rows) {
      if (!row.last) continue;
      const title = row.title?.trim() || "(untitled)";
      if (row.source === "cron") {
        const job = title.replace(/\s*[-–·#(].*$/, "");
        if (seenCron.has(job)) continue;
        seenCron.add(job);
      }
      out.push({
        source: "hermes",
        origin: HERMES_ORIGIN[row.source] ?? row.source,
        title,
        lastAgentText: row.last,
      });
    }
    return out;
  } finally {
    db.close();
  }
}

export const clipText = clip;
