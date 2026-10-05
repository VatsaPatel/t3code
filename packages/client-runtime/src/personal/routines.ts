import type {
  EnvironmentId,
  PersonalTodayRoutine,
  ScheduledTask,
  ScheduledTaskSchedule,
} from "@t3tools/contracts";

import { toSortableTimestamp } from "../state/threadSort.ts";
import { gutterTime, localDateKey } from "./daybook.ts";

// Personal fork: Hermes cron jobs and T3 scheduled tasks as one list of routines.

export type RoutineStatusWord = "ok" | "failed" | "missed" | "paused" | "running" | null;

export type RoutineRow =
  | {
      readonly source: "hermes";
      readonly key: string;
      readonly name: string;
      readonly gutter: string;
      /** Cadence and owner in plain words, such as "Every day, Hermes". */
      readonly cadence: string;
      readonly status: RoutineStatusWord;
      readonly nextRunAt: number | null;
      readonly enabled: boolean;
      readonly routine: PersonalTodayRoutine;
    }
  | {
      readonly source: "t3";
      readonly key: string;
      readonly name: string;
      readonly gutter: string;
      readonly cadence: string;
      readonly status: RoutineStatusWord;
      readonly nextRunAt: number | null;
      readonly enabled: boolean;
      readonly environmentId: EnvironmentId;
      readonly task: ScheduledTask;
    };

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
const WEEKDAY_PLURALS = [
  "Sundays",
  "Mondays",
  "Tuesdays",
  "Wednesdays",
  "Thursdays",
  "Fridays",
  "Saturdays",
] as const;
/** A run this late without a newer schedule counts as missed. */
const MISSED_GRACE_MS = 15 * 60_000;

function everyMinutesLabel(minutes: number): string {
  if (minutes % 60 === 0) return `every ${minutes / 60}h`;
  return `every ${minutes}m`;
}

function clock(hour: number, minute: number): string {
  return `${hour}:${String(minute).padStart(2, "0")}`;
}

/**
 * Plain words for common cron expressions ("0 9 * * *" → "Every day at 9:00").
 * Anything unusual falls back to Hermes' own display text.
 */
export function describeCron(expression: string): string | null {
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const [minute, hour, dayOfMonth, month, dayOfWeek] = parts as [
    string,
    string,
    string,
    string,
    string,
  ];
  if (!/^\d+$/.test(minute) || month !== "*" || dayOfMonth !== "*") return null;
  const range = /^(\d+)-(\d+)\/(\d+)$/.exec(hour);
  if (range !== null && dayOfWeek === "*") {
    const [, from, to, step] = range.map(Number) as [number, number, number, number];
    return `Every ${step} hours, ${clock(from, Number(minute))} to ${clock(to, Number(minute))}`;
  }
  if (/^\d+(,\d+)+$/.test(hour) && dayOfWeek === "*") {
    const times = hour.split(",").map((value) => clock(Number(value), Number(minute)));
    return `Every day at ${times.slice(0, -1).join(", ")} and ${times[times.length - 1]}`;
  }
  if (!/^\d+$/.test(hour)) return null;
  const at = clock(Number(hour), Number(minute));
  if (dayOfWeek === "*") return `Every day at ${at}`;
  if (/^\d$/.test(dayOfWeek)) return `${WEEKDAY_PLURALS[Number(dayOfWeek) % 7]} at ${at}`;
  if (dayOfWeek === "1-5") return `Weekdays at ${at}`;
  return null;
}

function sentenceCase(text: string): string {
  return text.length === 0 ? text : `${text[0]!.toUpperCase()}${text.slice(1)}`;
}

function hermesCadence(routine: PersonalTodayRoutine, nextRunAt: number | null): string {
  if (routine.intervalMinutes !== null) {
    // The gutter already says how often, so say when it runs next.
    if (!routine.enabled || nextRunAt === null) return "Hermes";
    // @effect-diagnostics-next-line globalDate:off
    return `Next at ${gutterTime(new Date(nextRunAt))}, Hermes`;
  }
  const display = routine.scheduleDisplay.trim();
  const described =
    describeCron(display) ?? (display.length > 0 ? sentenceCase(display) : "On demand");
  return `${described}, Hermes`;
}

function scheduledTaskCadence(schedule: ScheduledTaskSchedule): string {
  if (schedule.type === "interval") {
    return `Every ${everyMinutesLabel(Math.max(1, Math.round(schedule.everyMs / 60_000))).slice("every ".length)}, T3`;
  }
  const [hour, minute] = schedule.timeOfDay.split(":").map(Number) as [number, number];
  const at = clock(hour, minute);
  const weekdays = schedule.weekdays ?? [];
  if (weekdays.length === 0 || weekdays.length === 7) return `Every day at ${at}, T3`;
  if (weekdays.length === 1) return `${WEEKDAY_PLURALS[weekdays[0]! % 7]} at ${at}, T3`;
  return `${weekdays.map((day) => WEEKDAYS[day % 7]).join(", ")} at ${at}, T3`;
}

/** Gutter text for the next run: a time today, weekday and time this week, else a date. */
export function routineGutter(
  nextRunAt: number | null,
  now: Date,
  intervalMinutes?: number | null,
): string {
  if (intervalMinutes != null) return everyMinutesLabel(intervalMinutes);
  if (nextRunAt === null) return "";
  // The daybook works in the viewer's local calendar, which DateTime zones do not model here.
  // @effect-diagnostics-next-line globalDate:off
  const next = new Date(nextRunAt);
  if (localDateKey(next) === localDateKey(now)) return gutterTime(next);
  if (nextRunAt - now.getTime() < 6 * 24 * 60 * 60_000) {
    return `${WEEKDAYS[next.getDay()]} ${gutterTime(next)}`;
  }
  return `${next.getDate()} ${next.toLocaleString("en", { month: "short" })}`;
}

function hermesStatus(routine: PersonalTodayRoutine, nowMs: number): RoutineStatusWord {
  if (!routine.enabled || routine.state === "paused") return "paused";
  if (routine.state === "running") return "running";
  const next = toSortableTimestamp(routine.nextRunAt ?? undefined);
  if (next != null && next < nowMs - MISSED_GRACE_MS) return "missed";
  if (routine.lastStatus === null) return null;
  return routine.lastStatus === "ok" ? "ok" : "failed";
}

function scheduledTaskStatus(task: ScheduledTask): RoutineStatusWord {
  if (!task.enabled) return "paused";
  switch (task.lastRunStatus) {
    case "succeeded":
      return "ok";
    case "failed":
      return "failed";
    case "running":
      return "running";
    case "never":
      return null;
  }
}

/**
 * One list of routines, soonest next run first; paused ones sink to the end.
 * Hermes interval jobs repeat too often to place by clock, so their gutter
 * shows the interval.
 */
export function buildRoutineRows(input: {
  readonly now: Date;
  readonly hermes: ReadonlyArray<PersonalTodayRoutine>;
  readonly scheduled: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly task: ScheduledTask;
  }>;
}): ReadonlyArray<RoutineRow> {
  const nowMs = input.now.getTime();
  const rows: RoutineRow[] = [];
  for (const routine of input.hermes) {
    const nextRunAt = toSortableTimestamp(routine.nextRunAt ?? undefined) ?? null;
    rows.push({
      source: "hermes",
      key: `hermes:${routine.id}`,
      name: routine.name,
      gutter: routineGutter(routine.enabled ? nextRunAt : null, input.now, routine.intervalMinutes),
      cadence: hermesCadence(routine, nextRunAt),
      status: hermesStatus(routine, nowMs),
      nextRunAt: routine.enabled ? nextRunAt : null,
      enabled: routine.enabled,
      routine,
    });
  }
  for (const { environmentId, task } of input.scheduled) {
    const nextRunAt = toSortableTimestamp(task.nextRunAt ?? undefined) ?? null;
    rows.push({
      source: "t3",
      key: `t3:${environmentId}:${task.id}`,
      name: task.title,
      gutter: routineGutter(
        task.enabled ? nextRunAt : null,
        input.now,
        task.schedule.type === "interval" ? Math.round(task.schedule.everyMs / 60_000) : null,
      ),
      cadence: scheduledTaskCadence(task.schedule),
      status: scheduledTaskStatus(task),
      nextRunAt: task.enabled ? nextRunAt : null,
      enabled: task.enabled,
      environmentId,
      task,
    });
  }
  return rows.sort(
    (left, right) =>
      Number(!left.enabled) - Number(!right.enabled) ||
      (left.nextRunAt ?? Number.MAX_SAFE_INTEGER) - (right.nextRunAt ?? Number.MAX_SAFE_INTEGER) ||
      left.name.localeCompare(right.name),
  );
}
