// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalConsole:off globalFetch:off globalTimers:off -- fork-only plain-Node module; reads foreign files synchronously on a bounded timer.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";

import type {
  PersonalBrief,
  PersonalDigestResult,
  PersonalRoutine,
  PersonalRoutineAction,
  PersonalRoutinesResult,
  PersonalSourceStatus,
  PersonalTodo,
  PersonalTodosResult,
  PersonalWaitingItem,
  PersonalWaitingResult,
} from "@t3tools/contracts";

import { complete, CURATOR_MODEL, curatorAvailable, parseJsonObject } from "./curator.ts";
import { PersonalStore } from "./PersonalStore.ts";
import {
  type AgentTail,
  clipText,
  hermesActivity,
  scanClaude,
  scanCodex,
  scanHermes,
} from "./sources.ts";

const run = NodeUtil.promisify(NodeChildProcess.execFile);
const home = () => process.env.PERSONAL_HOME_DIR ?? NodeOS.homedir();

const WAITING_WINDOW_MS = 7 * 24 * 3600_000;
const STALE_MS = 48 * 3600_000;
const CLASSIFY_PER_TICK = 25;
const TICK_MS = 5 * 60_000;
const SCAN_TTL_MS = 30_000;
const DIGEST_WINDOW_HOURS = 24;

const CLASSIFY_SYSTEM = `You triage a person's AI-agent conversations. Given the user's last message and the agent's final reply, decide whether the conversation is now blocked on the USER: the agent asked a question, needs a decision, approval, credentials, a file, or asked the user to do something before work can continue. A plain report, summary, or "done" with optional offers like "let me know if..." is NOT waiting. Reply with JSON only: {"waiting": boolean, "ask": string|null}. "ask" is an imperative phrase of at most 15 words saying exactly what the user must do or decide, e.g. "Approve sending the Apna Bazar order ($42) to Ravi".`;

const DIGEST_SYSTEM = `You write a terse daily digest of what a person's AI agents did in the last 24 hours, for the person to skim in 20 seconds. Input is a list of sessions (origin, title, final agent message). Output GitHub markdown with up to three sections, omitting empty ones: "**Done**", "**Failed or blocked**", "**Still open**". At most 8 bullets in total, each under 25 words, concrete (names, amounts, numbers), merge duplicates and repeated cron runs, skip routine no-op runs. No preamble.`;

export class PersonalService {
  private readonly store: PersonalStore;
  private scanCache: { at: number; tails: AgentTail[]; statuses: PersonalSourceStatus[] } | null =
    null;
  private classifying = false;
  private digestRun: Promise<void> | null = null;
  private digestError: string | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(stateDir: string) {
    this.store = new PersonalStore(stateDir);
  }

  start() {
    if (this.timer) return;
    const tick = () => {
      void this.classifyPending();
      void this.maybeDailyDigest();
    };
    setTimeout(tick, 10_000).unref();
    this.timer = setInterval(tick, TICK_MS);
    this.timer.unref();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private scan() {
    if (this.scanCache && Date.now() - this.scanCache.at < SCAN_TTL_MS) return this.scanCache;
    const since = Date.now() - WAITING_WINDOW_MS;
    const results = [scanHermes(since), scanCodex(since), scanClaude(since)];
    this.scanCache = {
      at: Date.now(),
      tails: results.flatMap((result) => result.tails),
      statuses: results.map((result) => result.status),
    };
    return this.scanCache;
  }

  private static keyOf(tail: AgentTail) {
    return `${tail.source}:${tail.sessionId}`;
  }

  async classifyPending() {
    if (this.classifying || !curatorAvailable()) return;
    this.classifying = true;
    try {
      const pending = this.scan()
        .tails.filter(
          (tail) => this.store.getAsk(PersonalService.keyOf(tail))?.revision !== tail.revision,
        )
        .toSorted((a, b) => b.lastAgentAtMs - a.lastAgentAtMs)
        .slice(0, CLASSIFY_PER_TICK);
      for (const tail of pending) {
        try {
          const text = await complete(
            CLASSIFY_SYSTEM,
            `Conversation: ${tail.title} (${tail.origin})\n\nUSER'S LAST MESSAGE:\n${clipText(tail.lastUserText, 1500)}\n\nAGENT'S FINAL REPLY (tail):\n${tail.lastAgentText.slice(-3000)}`,
            { maxTokens: 120, json: true, timeoutMs: 30_000 },
          );
          const parsed = parseJsonObject(text);
          if (!parsed || typeof parsed.waiting !== "boolean") continue;
          const ask =
            typeof parsed.ask === "string" && parsed.ask.trim() ? parsed.ask.trim() : null;
          this.store.putAsk(
            PersonalService.keyOf(tail),
            tail.revision,
            parsed.waiting,
            parsed.waiting ? ask : null,
            CURATOR_MODEL,
          );
        } catch (cause) {
          console.warn("[personal] classification failed", tail.sessionId, String(cause));
        }
      }
    } finally {
      this.classifying = false;
    }
  }

  waiting(): PersonalWaitingResult {
    const { tails, statuses } = this.scan();
    const items: PersonalWaitingItem[] = [];
    let pendingClassification = 0;
    for (const tail of tails) {
      const key = PersonalService.keyOf(tail);
      const cached = this.store.getAsk(key);
      const fresh = cached?.revision === tail.revision;
      if (!fresh) pendingClassification += 1;
      if (fresh && cached.waiting === 0) continue;
      // Without curation every agent-last chat would look blocked; show only classified asks then.
      if (!fresh && !curatorAvailable()) continue;
      items.push({
        key,
        source: tail.source,
        origin: tail.origin,
        sessionId: tail.sessionId,
        title: tail.title,
        cwd: tail.cwd,
        ask: fresh ? cached.ask : null,
        lastAgentText: clipText(tail.lastAgentText.trim(), 400),
        lastAgentAt: new Date(tail.lastAgentAtMs).toISOString(),
        stale: Date.now() - tail.lastAgentAtMs > STALE_MS,
        resumeCommand: tail.resumeCommand,
        dismissed: this.store.isDismissed(key, tail.revision),
      });
    }
    if (pendingClassification > 0) void this.classifyPending();
    const curatedAt = this.store.latestClassifiedAt();
    return {
      items: items.toSorted((a, b) => b.lastAgentAt.localeCompare(a.lastAgentAt)),
      pendingClassification,
      sources: statuses,
      curatorAvailable: curatorAvailable(),
      curatedAt: curatedAt ? new Date(curatedAt).toISOString() : null,
    };
  }

  setDismissed(key: string, dismissed: boolean) {
    const tail = this.scan().tails.find((candidate) => PersonalService.keyOf(candidate) === key);
    if (!tail) throw new Error("That conversation is no longer in the waiting window.");
    this.store.setDismissed(key, tail.revision, dismissed);
  }

  digest(): PersonalDigestResult {
    const latest = this.store.latestDigest();
    return {
      digest: latest
        ? {
            markdown: latest.markdown,
            generatedAt: new Date(latest.generated_at).toISOString(),
            windowHours: latest.window_hours,
            sessionCount: latest.session_count,
            model: latest.model,
          }
        : null,
      curatorAvailable: curatorAvailable(),
      generating: this.digestRun !== null,
      error: this.digestError,
    };
  }

  private async maybeDailyDigest() {
    const latest = this.store.latestDigest();
    if (latest && Date.now() - latest.generated_at < 20 * 3600_000) return;
    const hour = new Date().getHours();
    if (hour < 6) return;
    await this.refreshDigest();
  }

  refreshDigest(): Promise<void> {
    if (!curatorAvailable()) return Promise.resolve();
    this.digestRun ??= this.generateDigest().finally(() => {
      this.digestRun = null;
    });
    return this.digestRun;
  }

  private async generateDigest() {
    const since = Date.now() - DIGEST_WINDOW_HOURS * 3600_000;
    const sessions = [
      ...hermesActivity(since),
      ...scanCodex(since).tails.map((tail) => ({ ...tail, source: "codex" })),
      ...scanClaude(since).tails.map((tail) => ({ ...tail, source: "claude" })),
    ];
    const failures = this.routines()
      .routines.filter((routine) => routine.lastStatus && routine.lastStatus !== "ok")
      .map(
        (routine) =>
          `- Routine "${routine.name}" last status ${routine.lastStatus}: ${routine.lastError ?? ""}`,
      );
    let budget = 30_000;
    const lines: string[] = [];
    for (const session of sessions) {
      const line = `- [${session.origin}] ${session.title}: ${clipText(session.lastAgentText.replace(/\s+/g, " "), 600)}`;
      if (budget - line.length < 0) break;
      budget -= line.length;
      lines.push(line);
    }
    if (lines.length === 0 && failures.length === 0) {
      this.store.putDigest(
        "_No agent activity in the last 24 hours._",
        DIGEST_WINDOW_HOURS,
        0,
        "none",
      );
      this.digestError = null;
      return;
    }
    try {
      const markdown = await complete(
        DIGEST_SYSTEM,
        `Now: ${new Date().toString()}\n\nSESSIONS:\n${lines.join("\n")}\n\nROUTINE STATUS:\n${failures.join("\n") || "all ok"}`,
        { maxTokens: 700, timeoutMs: 90_000 },
      );
      this.store.putDigest(markdown.trim(), DIGEST_WINDOW_HOURS, lines.length, CURATOR_MODEL);
      this.digestError = null;
    } catch (cause) {
      this.digestError = String(cause);
    }
  }

  async todos(): Promise<PersonalTodosResult> {
    const script = todoScript();
    if (!NodeFS.existsSync(script))
      return { available: false, error: `${script} not found`, todos: [] };
    try {
      const { stdout } = await run("python3", [script, "list"], { timeout: 30_000 });
      const todos: PersonalTodo[] = stdout
        .split("\n")
        .filter(Boolean)
        .map((line) => line.split("\t"))
        .filter((fields) => fields.length >= 5)
        .map(([id, priority, due, project, ...text]) => ({
          id: id!,
          priority: Number(priority!.replace(/^P/, "")) || 4,
          due: due === "-" ? null : due!,
          project: project!,
          // Hermes sometimes nests a second "[Project] Pn · " prefix inside the text.
          text: text.join("\t").replace(/^\[[^\]]+\]\s*P\d\s*·\s*/, ""),
        }));
      return { available: true, error: null, todos };
    } catch (cause) {
      return { available: false, error: String(cause).slice(0, 300), todos: [] };
    }
  }

  async todoDone(id: string) {
    if (!/^[A-Za-z0-9]+$/.test(id)) throw new Error("Invalid to-do id");
    await run("python3", [todoScript(), "done", id], { timeout: 30_000 });
  }

  async todoAdd(text: string, due: string | undefined) {
    const clean = text.trim();
    if (!clean) throw new Error("To-do text is empty");
    const { stdout } = await run("python3", [todoScript(), "add", clean, due ?? "", "4"], {
      timeout: 30_000,
    });
    return stdout.trim();
  }

  brief(): PersonalBrief | null {
    for (const name of ["Daily life chief-of-staff brief", "Daily plan (morning)"]) {
      const job = readJobs().find((candidate) => candidate.name === name);
      if (!job) continue;
      const output = latestOutput(job.id);
      if (output?.markdown)
        return { jobName: name, ranAt: output.ranAt, markdown: output.markdown };
    }
    return null;
  }

  routines(): PersonalRoutinesResult {
    const path = jobsPath();
    if (!NodeFS.existsSync(path))
      return { available: false, error: `${path} not found`, routines: [] };
    try {
      const routines: PersonalRoutine[] = readJobs().map((job) => {
        const output = job.last_run_at ? latestOutput(job.id) : null;
        return {
          id: job.id,
          name: job.name ?? job.id,
          schedule: job.schedule_display ?? job.schedule?.display ?? "",
          enabled: job.enabled !== false,
          state: job.paused_at ? "paused" : (job.state ?? "scheduled"),
          nextRunAt: job.next_run_at ?? null,
          lastRunAt: job.last_run_at ?? null,
          lastStatus: job.last_status ?? null,
          lastError: job.last_error ?? job.last_delivery_error ?? null,
          lastOutputPreview: output?.markdown
            ? clipText(output.markdown.replace(/\s+/g, " "), 160)
            : null,
          deliver: typeof job.deliver === "string" ? job.deliver : null,
        };
      });
      return {
        available: true,
        error: null,
        routines: routines.toSorted(
          (a, b) =>
            (a.nextRunAt ? Date.parse(a.nextRunAt) : Infinity) -
            (b.nextRunAt ? Date.parse(b.nextRunAt) : Infinity),
        ),
      };
    } catch (cause) {
      return { available: false, error: String(cause), routines: [] };
    }
  }

  routineOutput(id: string) {
    const output = latestOutput(id);
    return { markdown: output?.markdown ?? null, ranAt: output?.ranAt ?? null };
  }

  /** The `hermes cron` CLI owns jobs.json locking and the scheduler; never write the file here. */
  async routineAction(id: string, action: PersonalRoutineAction) {
    if (!/^[a-f0-9]+$/i.test(id)) throw new Error("Invalid routine id");
    const { stdout, stderr } = await run(hermesBin(), ["cron", action, id], { timeout: 60_000 });
    return (stdout || stderr).trim();
  }
}

interface HermesJob {
  id: string;
  name?: string;
  schedule?: { display?: string };
  schedule_display?: string;
  enabled?: boolean;
  state?: string;
  paused_at?: string | null;
  next_run_at?: string | null;
  last_run_at?: string | null;
  last_status?: string | null;
  last_error?: string | null;
  last_delivery_error?: string | null;
  deliver?: unknown;
}

const todoScript = () =>
  process.env.PERSONAL_TODO_SCRIPT ??
  NodePath.join(home(), "repos", "personal-git", "todo", "slack_todo.py");
const jobsPath = () => NodePath.join(home(), ".hermes", "cron", "jobs.json");
const hermesBin = () => {
  const local = NodePath.join(home(), ".local", "bin", "hermes");
  return NodeFS.existsSync(local) ? local : "hermes";
};

function readJobs(): HermesJob[] {
  const parsed: unknown = JSON.parse(NodeFS.readFileSync(jobsPath(), "utf8"));
  const jobs = Array.isArray(parsed) ? parsed : (parsed as { jobs?: unknown }).jobs;
  return Array.isArray(jobs) ? (jobs as HermesJob[]) : [];
}

/** Hermes writes `<output>/<job>/<YYYY-MM-DD_HH-MM-SS>.md` with the reply under `## Response`. */
function latestOutput(jobId: string): { markdown: string; ranAt: string } | null {
  const dir = NodePath.join(home(), ".hermes", "cron", "output", jobId);
  if (!/^[a-f0-9]+$/i.test(jobId) || !NodeFS.existsSync(dir)) return null;
  const latest = NodeFS.readdirSync(dir)
    .filter((name) => name.endsWith(".md"))
    .toSorted()
    .at(-1);
  if (!latest) return null;
  const raw = NodeFS.readFileSync(NodePath.join(dir, latest), "utf8");
  const index = raw.indexOf("\n## Response");
  const markdown = (index >= 0 ? raw.slice(index + "\n## Response".length) : raw).trim();
  const match = /^(\d{4}-\d{2}-\d{2})_(\d{2})-(\d{2})-(\d{2})/.exec(latest);
  const ranAt = match
    ? new Date(`${match[1]}T${match[2]}:${match[3]}:${match[4]}`).toISOString()
    : new Date(NodeFS.statSync(NodePath.join(dir, latest)).mtimeMs).toISOString();
  return { markdown, ranAt };
}
