import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  RunId,
  ScheduledTaskId,
  ThreadId,
  type OrchestrationV2ThreadShell,
  type PersonalTodayRoutine,
  type PersonalTodayTask,
  type ScheduledTask,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import { presentThreadShell } from "../state/models.ts";
import { v2ThreadShell } from "../state/orchestrationV2TestFixtures.ts";
import { buildDayLedger, buildDayTodos } from "./daybook.ts";
import { buildRoutineRows, describeCron } from "./routines.ts";

const environmentId = EnvironmentId.make("environment-1");
// Local wall-clock dates so the expectations hold in any time zone.
// @effect-diagnostics-next-line globalDate:off
const now = new Date(2026, 9, 5, 11, 20);
// @effect-diagnostics-next-line globalDate:off
const local = (day: number, hour: number, minute = 0) => new Date(2026, 9, day, hour, minute);

function routine(overrides: Partial<PersonalTodayRoutine>): PersonalTodayRoutine {
  return {
    id: "job",
    name: "Job",
    enabled: true,
    state: "scheduled",
    scheduleDisplay: "0 9 * * *",
    intervalMinutes: null,
    promptPreview: "",
    nextRunAt: null,
    lastRunAt: null,
    lastStatus: null,
    lastError: null,
    deliver: null,
    isBrief: false,
    notifies: false,
    ...overrides,
  };
}

function finishedThread(
  id: string,
  completedAt: Date,
  overrides: Partial<OrchestrationV2ThreadShell> = {},
) {
  return presentThreadShell(environmentId, {
    ...v2ThreadShell,
    id: ThreadId.make(id),
    title: id,
    lineage: { rootThreadId: ThreadId.make(id), parentThreadId: null, relationshipToParent: null },
    latestRunId: RunId.make(`${id}-run`),
    status: "completed",
    latestRunCompletedAt: DateTime.makeUnsafe(completedAt.toISOString()),
    ...overrides,
  });
}

function task(id: string, due: PersonalTodayTask["due"], delegated = false): PersonalTodayTask {
  return {
    id,
    source: "todoist",
    content: id,
    description: "",
    url: null,
    projectName: null,
    priority: 1,
    due,
    labels: [],
    delegation: delegated
      ? { threadId: ThreadId.make(`${id}-thread`), delegatedAt: now.toISOString() }
      : null,
  };
}

describe("buildDayLedger", () => {
  it("lists today's brief, routine runs and finished agent runs, oldest first", () => {
    const entries = buildDayLedger({
      now,
      brief: {
        jobId: "brief",
        jobName: "Daily brief",
        runStamp: "2026-10-05_08-11-30",
        runAt: local(5, 8, 11).toISOString(),
        markdown: "## Now",
        firstLine: "Now",
        deliver: null,
      },
      routines: [
        // The brief job's own run is the brief entry, not a second row.
        routine({ id: "brief", isBrief: true, lastRunAt: local(5, 8, 11).toISOString() }),
        routine({
          id: "coach",
          name: "WHOOP coach",
          lastRunAt: local(5, 9).toISOString(),
          lastStatus: "ok",
        }),
        routine({ id: "old", lastRunAt: local(4, 9).toISOString(), lastStatus: "ok" }),
      ],
      threads: [
        finishedThread("portfolio", local(5, 10, 42)),
        finishedThread("yesterday", local(4, 22)),
        // Still waiting on the user: it belongs in "Waiting on you".
        finishedThread("asking", local(5, 10), {
          interactionMode: "plan",
          hasActionableProposedPlan: true,
        }),
      ],
    });

    expect(entries.map((entry) => entry.key)).toEqual([
      "brief:brief:2026-10-05_08-11-30",
      "routine:coach",
      "agent:environment-1:portfolio",
    ]);
  });
});

describe("buildDayTodos", () => {
  it("puts overdue first, then untimed and timed to-dos for today, and keeps delegated ones", () => {
    const todos = buildDayTodos(
      [
        task("gym", {
          date: "2026-10-05",
          datetime: local(5, 18).toISOString(),
          label: "6pm",
          isRecurring: false,
        }),
        task("bill", { date: "2026-10-05", datetime: null, label: "today", isRecurring: false }),
        task("late", { date: "2026-10-01", datetime: null, label: "Oct 1", isRecurring: false }),
        task("friday", { date: "2026-10-09", datetime: null, label: "Fri", isRecurring: false }),
        task(
          "delegated",
          { date: "2026-10-09", datetime: null, label: "Fri", isRecurring: false },
          true,
        ),
      ],
      now,
    );

    expect(todos.map((todo) => [todo.task.id, todo.gutter])).toEqual([
      ["late", "1 Oct"],
      ["bill", ""],
      ["delegated", ""],
      ["gym", "18:00"],
    ]);
  });
});

describe("buildRoutineRows", () => {
  it("merges Hermes and T3 routines by next run, with paused ones last and late runs missed", () => {
    const scheduled: ScheduledTask = {
      id: ScheduledTaskId.make("weekly"),
      title: "Weekly review",
      prompt: "Review the week",
      enabled: true,
      schedule: { type: "fixed_time", timeOfDay: "18:00", weekdays: [0] },
      projectId: ProjectId.make("project"),
      threadId: null,
      workspaceStrategy: { type: "root" },
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
      runtimeMode: "full-access",
      interactionMode: "default",
      createdBy: "user",
      creationSource: "web",
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      nextRunAt: local(11, 18).toISOString(),
      lastRunAt: null,
      lastRunStatus: "succeeded",
      lastRunError: null,
      runCount: 1,
    };
    const rows = buildRoutineRows({
      now,
      hermes: [
        routine({ id: "nag", name: "Accountability nag", enabled: false, state: "paused" }),
        routine({
          id: "coach",
          name: "WHOOP coach",
          nextRunAt: local(6, 9).toISOString(),
          lastStatus: "ok",
        }),
        routine({
          id: "radar",
          name: "Lead radar",
          nextRunAt: local(5, 9).toISOString(),
          lastStatus: "ok",
        }),
      ],
      scheduled: [{ environmentId, task: scheduled }],
    });

    expect(rows.map((row) => [row.name, row.gutter, row.status, row.cadence])).toEqual([
      ["Lead radar", "09:00", "missed", "Every day at 9:00, Hermes"],
      ["WHOOP coach", "Tue 09:00", "ok", "Every day at 9:00, Hermes"],
      ["Weekly review", "11 Oct", "ok", "Sundays at 18:00, T3"],
      ["Accountability nag", "", "paused", "Every day at 9:00, Hermes"],
    ]);
  });

  it("describes common cron schedules in words and leaves odd ones alone", () => {
    expect(describeCron("0 9-21/3 * * *")).toBe("Every 3 hours, 9:00 to 21:00");
    expect(describeCron("30 7 * * 1-5")).toBe("Weekdays at 7:30");
    expect(describeCron("0 9 5,20 10-12 *")).toBeNull();
  });
});
