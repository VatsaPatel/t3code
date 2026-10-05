import type { PersonalTodayRoutine } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";

// Pure readers for the Hermes cron store (`<HERMES_HOME>/cron`). The service
// does the file IO; everything here takes already-read text so it is testable
// without a Hermes install.

export interface HermesCronJob {
  readonly id: string;
  readonly name: string;
  readonly enabled: boolean;
  readonly state: string;
  readonly scheduleDisplay: string;
  readonly intervalMinutes: number | null;
  readonly promptPreview: string;
  readonly nextRunAt: string | null;
  readonly lastRunAt: string | null;
  readonly lastStatus: string | null;
  readonly lastError: string | null;
  readonly deliver: string | null;
}

const OUTPUT_STAMP_PATTERN = /^(\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2})\.md$/;

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** Parses `jobs.json`. Malformed entries are skipped rather than failing the list. */
export function parseCronJobs(text: string): ReadonlyArray<HermesCronJob> {
  const parsed: unknown = JSON.parse(text);
  const rawJobs = Array.isArray(parsed)
    ? parsed
    : parsed !== null &&
        typeof parsed === "object" &&
        Array.isArray((parsed as { jobs?: unknown }).jobs)
      ? (parsed as { jobs: unknown[] }).jobs
      : [];
  const jobs: HermesCronJob[] = [];
  for (const raw of rawJobs) {
    if (raw === null || typeof raw !== "object") continue;
    const job = raw as Record<string, unknown>;
    const id = stringOrNull(job.id);
    if (id === null || !/^[A-Za-z0-9_-]+$/.test(id)) continue;
    const schedule = job.schedule as Record<string, unknown> | null | undefined;
    jobs.push({
      id,
      name: stringOrNull(job.name) ?? id,
      enabled: job.enabled === true,
      state: stringOrNull(job.state) ?? (job.enabled === true ? "scheduled" : "paused"),
      scheduleDisplay:
        stringOrNull(schedule?.display) ??
        stringOrNull(job.schedule_display) ??
        stringOrNull(schedule?.expr) ??
        "",
      intervalMinutes:
        schedule?.kind === "interval" && typeof schedule.minutes === "number"
          ? schedule.minutes
          : null,
      promptPreview: (stringOrNull(job.prompt) ?? stringOrNull(job.script) ?? "")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 160),
      nextRunAt: stringOrNull(job.next_run_at),
      lastRunAt: stringOrNull(job.last_run_at),
      lastStatus: stringOrNull(job.last_status),
      lastError: stringOrNull(job.last_error),
      deliver: stringOrNull(job.deliver),
    });
  }
  return jobs;
}

/** The configured brief jobs, else enabled jobs named like a brief (e.g. "Daily life chief-of-staff brief"). */
export function resolveBriefJobIds(
  jobs: ReadonlyArray<HermesCronJob>,
  configured: ReadonlyArray<string> | null,
): ReadonlyArray<string> {
  if (configured !== null) return configured;
  return jobs.filter((job) => job.enabled && /brief/i.test(job.name)).map((job) => job.id);
}

/** Output file stamps (`YYYY-MM-DD_HH-MM-SS`), newest first. Other files are ignored. */
export function sortedOutputStamps(fileNames: ReadonlyArray<string>): ReadonlyArray<string> {
  const stamps: string[] = [];
  for (const name of fileNames) {
    const match = OUTPUT_STAMP_PATTERN.exec(name);
    if (match?.[1] !== undefined) stamps.push(match[1]);
  }
  return stamps.toSorted((left, right) => right.localeCompare(left));
}

/**
 * The response part of a cron output file. Hermes writes a `# Cron Job:`
 * header, the prompt, and then `## Response`; script-only jobs may have no
 * response heading, in which case the whole body after the header is shown.
 */
export function extractCronResponse(markdown: string): string {
  const lines = markdown.split(/\r?\n/);
  let responseStart = -1;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (/^##\s+Response\s*$/.test(lines[index] ?? "")) {
      responseStart = index + 1;
      break;
    }
  }
  if (responseStart >= 0) return lines.slice(responseStart).join("\n").trim();
  const body = lines[0]?.startsWith("# Cron Job:") ? lines.slice(1) : lines;
  return body.join("\n").trim();
}

/** First line of readable text, stripped of markdown markers, for notification bodies. */
export function firstMeaningfulLine(markdown: string, maxLength = 140): string {
  for (const rawLine of markdown.split(/\r?\n/)) {
    const line = rawLine
      .replace(/^#+\s*/, "")
      .replace(/^[-*>]\s+/, "")
      .replace(/\*\*|__|`/g, "")
      .trim();
    if (line.length === 0) continue;
    return line.length > maxLength ? `${line.slice(0, maxLength - 1)}…` : line;
  }
  return "";
}

export function toRoutine(
  job: HermesCronJob,
  briefJobIds: ReadonlySet<string>,
  notifyJobIds: ReadonlySet<string>,
): PersonalTodayRoutine {
  return {
    id: job.id,
    name: job.name,
    enabled: job.enabled,
    state: job.state,
    scheduleDisplay: job.scheduleDisplay,
    intervalMinutes: job.intervalMinutes,
    promptPreview: job.promptPreview,
    nextRunAt: job.nextRunAt,
    lastRunAt: job.lastRunAt,
    lastStatus: job.lastStatus,
    lastError: job.lastError,
    deliver: job.deliver,
    isBrief: briefJobIds.has(job.id),
    notifies: notifyJobIds.has(job.id),
  };
}

export interface BriefOutputObservation {
  readonly jobId: string;
  /** Newest output stamp for the job, or null when it has none. */
  readonly latestStamp: string | null;
  /** Modification time of that output file. */
  readonly latestModifiedAtMs: number | null;
}

/**
 * Decides which brief outputs to announce and the markers to persist. A job
 * seen for the first time only takes a baseline, and an output older than
 * the server start is recorded without announcing it, so restarts and
 * backfills never replay old briefs.
 */
export function planBriefNotifications(input: {
  readonly observations: ReadonlyArray<BriefOutputObservation>;
  readonly markers: Readonly<Record<string, string>>;
  readonly serverStartedAtMs: number;
}): {
  readonly announce: ReadonlyArray<{ readonly jobId: string; readonly stamp: string }>;
  readonly markers: Readonly<Record<string, string>>;
} {
  const markers: Record<string, string> = { ...input.markers };
  const announce: Array<{ jobId: string; stamp: string }> = [];
  for (const observation of input.observations) {
    const stamp = observation.latestStamp;
    const marker = input.markers[observation.jobId];
    if (stamp === null) {
      // An empty marker means "seen with no output", so its first run announces.
      if (marker === undefined) markers[observation.jobId] = "";
      continue;
    }
    markers[observation.jobId] = marker === undefined || stamp > marker ? stamp : marker;
    if (marker === undefined || stamp <= marker) continue;
    if ((observation.latestModifiedAtMs ?? 0) < input.serverStartedAtMs) continue;
    announce.push({ jobId: observation.jobId, stamp });
  }
  return { announce, markers };
}

/** `2026-10-04T08:11:31.1-07:00` → `2026-10-04_08-11-31`, in the timestamp's own offset. */
function wallClockStamp(isoWithOffset: string): string | null {
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})/.exec(isoWithOffset);
  return match === null ? null : `${match[1]}_${match[2]}-${match[3]}-${match[4]}`;
}

function stampSeconds(stamp: string): number {
  const match = /^(\d{4})-(\d{2})-(\d{2})_(\d{2})-(\d{2})-(\d{2})$/.exec(stamp);
  if (match === null) return Number.NaN;
  const [, year, month, day, hour, minute, second] = match.map(Number) as [
    number,
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  return Date.UTC(year, month - 1, day, hour, minute, second) / 1000;
}

/** The output stamp written within two minutes of a run finishing, if any. */
export function matchOutputStamp(
  finishedAt: string | null,
  outputStamps: ReadonlyArray<string>,
): string | null {
  const finished = finishedAt === null ? null : wallClockStamp(finishedAt);
  if (finished === null) return null;
  const target = stampSeconds(finished);
  let best: { stamp: string; distance: number } | null = null;
  for (const stamp of outputStamps) {
    const distance = Math.abs(stampSeconds(stamp) - target);
    if (distance <= 120 && (best === null || distance < best.distance)) best = { stamp, distance };
  }
  return best?.stamp ?? null;
}

/** The `timezone:` Hermes writes cron output stamps in, from its config.yaml. */
export function parseHermesTimeZone(configYaml: string): string | null {
  const match = /^timezone:\s*["']?([A-Za-z0-9_+\-/]+)["']?\s*(?:#.*)?$/m.exec(configYaml);
  return match?.[1] ?? null;
}

/**
 * An output stamp is wall-clock time in the Hermes time zone, which need not
 * be the server's or the client's, so clients get the instant instead.
 */
export function stampToIso(stamp: string, timeZone: string): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})_(\d{2})-(\d{2})-(\d{2})$/.exec(stamp);
  if (match === null) return null;
  const [, year, month, day, hour, minute, second] = match.map(Number) as [
    number,
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  return DateTime.makeZoned(
    { year, month, day, hour, minute, second, millisecond: 0 },
    { timeZone, adjustForTimeZone: true },
  ).pipe(
    Option.map(DateTime.formatIso),
    Option.getOrElse(() => null),
  );
}
