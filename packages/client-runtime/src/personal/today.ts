import type { PersonalTodayTask, ThreadId } from "@t3tools/contracts";

import { backgroundWorkHoldsCompletion } from "@t3tools/shared/orchestrationV2PendingBackgroundWork";
import * as DateTime from "effect/DateTime";

import { threadRuntimeIsActive, type EnvironmentThreadShell } from "../state/models.ts";
import { toSortableTimestamp } from "../state/threadSort.ts";

// Personal fork: what the Today hub shows from thread state the client already
// holds. Pure functions so web and mobile agree on what "needs you" means.

export type NeedsYouKind = "approval" | "input" | "plan";

export interface NeedsYouItem {
  readonly thread: EnvironmentThreadShell;
  readonly kind: NeedsYouKind;
  /** When the thread started waiting on the user, ISO. */
  readonly waitingSince: string;
}

export interface WorkingItem {
  readonly thread: EnvironmentThreadShell;
  /** When the current work started, ISO, or null when unknown. */
  readonly startedAt: string | null;
  /** The latest visible message, as a one-line activity summary. */
  readonly activity: string | null;
}

export interface FailedItem {
  readonly thread: EnvironmentThreadShell;
  readonly error: string | null;
  readonly failedAt: string;
}

export interface TodayAttention {
  readonly needsYou: ReadonlyArray<NeedsYouItem>;
  readonly working: ReadonlyArray<WorkingItem>;
  readonly failed: ReadonlyArray<FailedItem>;
}

const ACTIVE_RUN_STATUSES = new Set(["preparing", "queued", "starting", "running", "waiting"]);

function isVisible(thread: EnvironmentThreadShell): boolean {
  return (
    thread.archivedAt === null &&
    thread.deletedAt === null &&
    thread.lineage.relationshipToParent !== "subagent"
  );
}

/** A proposed plan waits on the user only once the run that wrote it has settled. */
function hasPlanPrompt(thread: EnvironmentThreadShell): boolean {
  if (thread.interactionMode !== "plan" || !thread.hasActionableProposedPlan) return false;
  const run = thread.latestRun;
  return (
    run !== null &&
    !ACTIVE_RUN_STATUSES.has(run.status) &&
    thread.runtime?.activeRunId !== run.runId
  );
}

export function needsYouKind(thread: EnvironmentThreadShell): NeedsYouKind | null {
  if (thread.hasPendingApprovals) return "approval";
  if (thread.hasPendingUserInput) return "input";
  if (hasPlanPrompt(thread)) return "plan";
  return null;
}

/**
 * A failure is listed only while it needs a person: a usage limit with a
 * scheduled automatic retry does not, and a settled thread was already handled.
 */
export function failureNeedsHuman(thread: EnvironmentThreadShell): boolean {
  const failed = thread.runtime?.status === "failed" || thread.latestRun?.status === "failed";
  if (!failed) return false;
  if (
    thread.runtime?.lastErrorClass === "usage_limit" &&
    thread.limitRecovery?.autoResume === true
  ) {
    return false;
  }
  return thread.settledOverride !== "settled" && thread.settledAt === null;
}

function firstLine(text: string | undefined, max = 160): string | null {
  const line = text
    ?.split("\n")
    .map((part) => part.trim())
    .find((part) => part.length > 0);
  if (line === undefined) return null;
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

function newestFirst<T>(items: T[], at: (item: T) => string | null): T[] {
  return [...items].sort(
    (left, right) =>
      (toSortableTimestamp(at(right) ?? undefined) ?? 0) -
      (toSortableTimestamp(at(left) ?? undefined) ?? 0),
  );
}

/**
 * An agent is working while its run is live, or while background work it
 * started (a subagent, a monitor) will wake it. A runtime parked at idle for
 * any other reason, such as a synced history thread that never ran here, is at rest.
 */
function isAgentWorking(thread: EnvironmentThreadShell): boolean {
  if (threadRuntimeIsActive(thread.runtime)) return true;
  return (
    thread.runtime?.status === "idle" &&
    backgroundWorkHoldsCompletion(thread.source.pendingBackgroundTasks ?? [])
  );
}

/**
 * Splits threads into what needs the user, what agents are working on, and
 * failures that need a person. Visiting or reading a thread never removes it
 * from "needs you": only answering, approving, or acting on the plan does.
 */
export function selectTodayAttention(
  threads: ReadonlyArray<EnvironmentThreadShell>,
): TodayAttention {
  const needsYou: NeedsYouItem[] = [];
  const working: WorkingItem[] = [];
  const failed: FailedItem[] = [];
  for (const thread of threads) {
    if (!isVisible(thread)) continue;
    const kind = needsYouKind(thread);
    if (kind !== null) {
      const requestAt = thread.source.pendingRuntimeRequest?.createdAt;
      needsYou.push({
        thread,
        kind,
        waitingSince:
          kind !== "plan" && requestAt !== undefined
            ? DateTime.formatIso(requestAt)
            : (thread.latestRun?.completedAt ?? thread.updatedAt),
      });
      continue;
    }
    if (isAgentWorking(thread)) {
      working.push({
        thread,
        startedAt:
          thread.runtime?.activityStartedAt ??
          thread.latestRun?.startedAt ??
          thread.latestRun?.requestedAt ??
          null,
        activity: firstLine(thread.source.latestVisibleMessage?.text),
      });
      continue;
    }
    if (!threadRuntimeIsActive(thread.runtime) && failureNeedsHuman(thread)) {
      failed.push({
        thread,
        error: thread.runtime?.lastError ?? null,
        failedAt: thread.latestRun?.completedAt ?? thread.updatedAt,
      });
    }
  }
  return {
    needsYou: newestFirst(needsYou, (item) => item.waitingSince),
    working: newestFirst(working, (item) => item.startedAt),
    failed: newestFirst(failed, (item) => item.failedAt),
  };
}

export type DelegationState = "working" | "needs_you" | "review" | "failed" | "missing";

/** Where a delegated to-do stands, from its agent thread. A finished run means "review", never "done". */
export function delegationState(thread: EnvironmentThreadShell | undefined): DelegationState {
  if (thread === undefined || thread.deletedAt !== null) return "missing";
  if (needsYouKind(thread) !== null) return "needs_you";
  if (isAgentWorking(thread)) return "working";
  if (failureNeedsHuman(thread)) return "failed";
  return "review";
}

export interface TodayTaskGroups {
  readonly overdue: ReadonlyArray<PersonalTodayTask>;
  readonly today: ReadonlyArray<PersonalTodayTask>;
  readonly upcoming: ReadonlyArray<PersonalTodayTask>;
  readonly unscheduled: ReadonlyArray<PersonalTodayTask>;
}

/** Groups to-dos by due date against the viewer's local calendar date (`YYYY-MM-DD`). */
export function groupTodayTasks(
  tasks: ReadonlyArray<PersonalTodayTask>,
  localToday: string,
): TodayTaskGroups {
  const overdue: PersonalTodayTask[] = [];
  const today: PersonalTodayTask[] = [];
  const upcoming: PersonalTodayTask[] = [];
  const unscheduled: PersonalTodayTask[] = [];
  for (const task of tasks) {
    const date = task.due?.date;
    if (date === undefined) unscheduled.push(task);
    else if (date < localToday) overdue.push(task);
    else if (date === localToday) today.push(task);
    else upcoming.push(task);
  }
  const byDue = (left: PersonalTodayTask, right: PersonalTodayTask) =>
    (left.due?.datetime ?? left.due?.date ?? "").localeCompare(
      right.due?.datetime ?? right.due?.date ?? "",
    ) || right.priority - left.priority;
  return {
    overdue: [...overdue].sort(byDue),
    today: [...today].sort(byDue),
    upcoming: [...upcoming].sort(byDue),
    unscheduled,
  };
}

const CRON_SESSION_PATTERN = /^import:([^:]+):cron_([A-Za-z0-9-]+)_(\d{8}_\d{6})$/;

/**
 * The synced Hermes thread for one cron output. The session id carries the
 * session's start (`cron_<job>_<YYYYMMDD_HHMMSS>`) while the output file is
 * stamped when the run finished, so the match is the latest session of that
 * job that started on the same day at or before the output.
 */
export function findCronRunThreadId(input: {
  readonly threadIds: Iterable<ThreadId | string>;
  readonly jobId: string;
  /** Output stamp, `YYYY-MM-DD_HH-MM-SS`. */
  readonly runStamp: string;
}): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})_(\d{2})-(\d{2})-(\d{2})$/.exec(input.runStamp);
  if (match === null) return null;
  const outputKey = `${match[1]}${match[2]}${match[3]}_${match[4]}${match[5]}${match[6]}`;
  const day = outputKey.slice(0, 8);
  let best: { readonly id: string; readonly key: string } | null = null;
  for (const id of input.threadIds) {
    const parsed = CRON_SESSION_PATTERN.exec(id);
    if (parsed === null || parsed[2] !== input.jobId) continue;
    const key = parsed[3]!;
    if (!key.startsWith(day) || key > outputKey) continue;
    if (best === null || key > best.key) best = { id, key };
  }
  return best?.id ?? null;
}
