import type {
  PersonalTodayBrief,
  PersonalTodayRoutine,
  PersonalTodayTask,
} from "@t3tools/contracts";

import type { EnvironmentThreadShell } from "../state/models.ts";
import { toSortableTimestamp } from "../state/threadSort.ts";
import { needsYouKind } from "./today.ts";

// Personal fork: the Home daybook. Everything here takes the viewer's clock
// and calendar as input so it stays pure and testable.

/** `YYYY-MM-DD` of a local date. */
export function localDateKey(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

/** 24-hour `HH:MM` for the time gutter. */
export function gutterTime(date: Date): string {
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

/** An ISO instant from the server as a local `Date`, or null when missing or invalid. */
export function parseIso(value: string | null | undefined): Date | null {
  const ms = toSortableTimestamp(value ?? undefined);
  // @effect-diagnostics-next-line globalDate:off
  return ms == null ? null : new Date(ms);
}

export type LedgerEntry =
  | {
      readonly kind: "brief";
      readonly key: string;
      readonly at: number;
      readonly brief: PersonalTodayBrief;
    }
  | {
      readonly kind: "routine";
      readonly key: string;
      readonly at: number;
      readonly routine: PersonalTodayRoutine;
      readonly failed: boolean;
    }
  | {
      readonly kind: "agent";
      readonly key: string;
      readonly at: number;
      readonly thread: EnvironmentThreadShell;
    };

const MAX_AGENT_ENTRIES = 6;

/**
 * What already happened today, oldest first: the brief, routine runs, and
 * agent runs that finished. Threads that still need the user live in
 * "Waiting on you" instead, and the brief job's own run is the brief entry.
 */
export function buildDayLedger(input: {
  readonly now: Date;
  readonly brief: PersonalTodayBrief | null;
  readonly routines: ReadonlyArray<PersonalTodayRoutine>;
  readonly threads: ReadonlyArray<EnvironmentThreadShell>;
}): ReadonlyArray<LedgerEntry> {
  const today = localDateKey(input.now);
  const nowMs = input.now.getTime();
  const isToday = (date: Date | null): date is Date =>
    date !== null && localDateKey(date) === today && date.getTime() <= nowMs;
  const entries: LedgerEntry[] = [];

  const briefAt = input.brief === null ? null : parseIso(input.brief.runAt);
  if (input.brief !== null && isToday(briefAt)) {
    entries.push({
      kind: "brief",
      key: `brief:${input.brief.jobId}:${input.brief.runStamp}`,
      at: briefAt.getTime(),
      brief: input.brief,
    });
  }

  for (const routine of input.routines) {
    if (routine.isBrief && input.brief?.jobId === routine.id && isToday(briefAt)) continue;
    const ranAt = parseIso(routine.lastRunAt);
    if (!isToday(ranAt)) continue;
    entries.push({
      kind: "routine",
      key: `routine:${routine.id}`,
      at: ranAt.getTime(),
      routine,
      failed: routine.lastStatus !== null && routine.lastStatus !== "ok",
    });
  }

  const finished = input.threads
    .filter(
      (thread) =>
        thread.archivedAt === null &&
        thread.deletedAt === null &&
        thread.lineage.relationshipToParent !== "subagent" &&
        thread.latestRun?.status === "completed" &&
        thread.runtime?.status !== "running" &&
        needsYouKind(thread) === null,
    )
    .flatMap((thread) => {
      const at = parseIso(thread.latestRun?.completedAt);
      return isToday(at) ? [{ thread, at: at.getTime() }] : [];
    })
    .sort((left, right) => right.at - left.at)
    .slice(0, MAX_AGENT_ENTRIES);
  for (const { thread, at } of finished) {
    entries.push({ kind: "agent", key: `agent:${thread.environmentId}:${thread.id}`, at, thread });
  }

  return entries.sort((left, right) => left.at - right.at);
}

export interface DayTodo {
  readonly task: PersonalTodayTask;
  /** Gutter text: a time for timed to-dos today, a short date when overdue, else empty. */
  readonly gutter: string;
}

const SHORT_MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const;

/**
 * Open to-dos for below the "now" rule: overdue first, then today's, untimed
 * before timed ones in time order. Delegated to-dos stay listed until done.
 */
export function buildDayTodos(
  tasks: ReadonlyArray<PersonalTodayTask>,
  now: Date,
): ReadonlyArray<DayTodo> {
  const today = localDateKey(now);
  const rows: Array<DayTodo & { readonly sort: string }> = [];
  for (const task of tasks) {
    const date = task.due?.date;
    const delegated = task.delegation !== null;
    if (date === undefined) {
      if (delegated) rows.push({ task, gutter: "", sort: `1:${today}` });
      continue;
    }
    if (date > today && !delegated) continue;
    if (date < today) {
      const [, month, day] = date.split("-").map(Number) as [number, number, number];
      rows.push({ task, gutter: `${day} ${SHORT_MONTHS[month - 1]}`, sort: `0:${date}` });
      continue;
    }
    const timed = task.due?.datetime ? parseIso(task.due.datetime) : null;
    rows.push({
      task,
      gutter: timed === null || date !== today ? "" : gutterTime(timed),
      sort: timed === null ? `1:${date}` : `2:${task.due?.datetime}`,
    });
  }
  return rows
    .sort(
      (left, right) =>
        left.sort.localeCompare(right.sort) || right.task.priority - left.task.priority,
    )
    .map(({ task, gutter }) => ({ task, gutter }));
}

/** "18 min", "2 hr", "3 days": a compact age in tabular-friendly words. */
export function formatAge(fromMs: number, nowMs: number): string {
  const minutes = Math.max(0, Math.round((nowMs - fromMs) / 60_000));
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hr`;
  const days = Math.round(hours / 24);
  return days === 1 ? "1 day" : `${days} days`;
}
