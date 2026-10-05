import {
  EnvironmentId,
  RunId,
  RuntimeRequestId,
  ThreadId,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import { presentThreadShell } from "../state/models.ts";
import { v2ThreadShell } from "../state/orchestrationV2TestFixtures.ts";
import { delegationState, findCronRunThreadId, selectTodayAttention } from "./today.ts";

const environmentId = EnvironmentId.make("environment-1");
const at = (iso: string) => DateTime.makeUnsafe(iso);

function shell(id: string, overrides: Partial<OrchestrationV2ThreadShell> = {}) {
  return presentThreadShell(environmentId, {
    ...v2ThreadShell,
    id: ThreadId.make(id),
    title: id,
    lineage: { rootThreadId: ThreadId.make(id), parentThreadId: null, relationshipToParent: null },
    ...overrides,
  });
}

const askingQuestion = (id: string, overrides: Partial<OrchestrationV2ThreadShell> = {}) =>
  shell(id, {
    latestRunId: RunId.make(`${id}-run`),
    activeRunId: RunId.make(`${id}-run`),
    status: "waiting",
    pendingRuntimeRequest: {
      id: RuntimeRequestId.make(`${id}-request`),
      kind: "user_input",
      createdAt: at("2026-10-05T08:00:00.000Z"),
    },
    ...overrides,
  });

const failedRun = (id: string, overrides: Partial<OrchestrationV2ThreadShell> = {}) =>
  shell(id, {
    latestRunId: RunId.make(`${id}-run`),
    status: "failed",
    lastError: "Provider crashed",
    ...overrides,
  });

describe("selectTodayAttention", () => {
  it("keeps a thread in needs-you after it is visited, until the question is answered", () => {
    const unvisited = askingQuestion("question");
    const visited = askingQuestion("question", {
      lastVisitedAt: at("2026-10-05T09:00:00.000Z"),
      updatedAt: at("2026-10-05T09:00:00.000Z"),
    });

    for (const thread of [unvisited, visited]) {
      const attention = selectTodayAttention([thread]);
      expect(attention.needsYou.map((item) => [item.thread.id, item.kind])).toEqual([
        ["question", "input"],
      ]);
      expect(attention.needsYou[0]?.waitingSince).toBe("2026-10-05T08:00:00.000Z");
      expect(attention.working).toEqual([]);
    }

    const answered = askingQuestion("question", {
      pendingRuntimeRequest: null,
      status: "running",
      lastVisitedAt: at("2026-10-05T09:00:00.000Z"),
    });
    const afterAnswer = selectTodayAttention([answered]);
    expect(afterAnswer.needsYou).toEqual([]);
    expect(afterAnswer.working.map((item) => item.thread.id)).toEqual(["question"]);
  });

  it("lists failures separately only while a person has to act on them", () => {
    const attention = selectTodayAttention([
      failedRun("crashed"),
      // A usage limit with an automatic retry resumes on its own.
      failedRun("limited", {
        lastErrorClass: "usage_limit",
        limitRecovery: {
          runId: RunId.make("limited-run"),
          resetAt: "2026-10-05T12:00:00.000Z",
          autoResume: true,
        },
      }),
      // The user already settled it.
      failedRun("settled", { settledAt: at("2026-10-05T08:30:00.000Z") }),
      shell("finished", { latestRunId: RunId.make("finished-run"), status: "completed" }),
    ]);

    expect(attention.failed.map((item) => [item.thread.id, item.error])).toEqual([
      ["crashed", "Provider crashed"],
    ]);
    expect(attention.needsYou).toEqual([]);
    expect(attention.working).toEqual([]);
  });

  it("leaves subagent and archived threads out", () => {
    const attention = selectTodayAttention([
      askingQuestion("child", {
        lineage: {
          rootThreadId: ThreadId.make("parent"),
          parentThreadId: ThreadId.make("parent"),
          relationshipToParent: "subagent",
        },
      }),
      askingQuestion("archived", { archivedAt: at("2026-10-05T08:30:00.000Z") }),
    ]);
    expect(attention.needsYou).toEqual([]);
  });
});

describe("delegationState", () => {
  it("returns a finished agent run for review rather than treating it as done", () => {
    expect(
      delegationState(shell("done", { latestRunId: RunId.make("done-run"), status: "completed" })),
    ).toBe("review");
    expect(delegationState(askingQuestion("asking"))).toBe("needs_you");
    expect(delegationState(undefined)).toBe("missing");
  });
});

describe("findCronRunThreadId", () => {
  it("matches the session that started before the output on the same day", () => {
    const threadIds = [
      "import:hermes:cron_1ddfe19fb572_20261003_081033",
      "import:hermes:cron_1ddfe19fb572_20261004_081100",
      "import:hermes:cron_19439fc6140d_20261004_081500",
      "thread-unrelated",
    ];
    expect(
      findCronRunThreadId({ threadIds, jobId: "1ddfe19fb572", runStamp: "2026-10-04_08-11-30" }),
    ).toBe("import:hermes:cron_1ddfe19fb572_20261004_081100");
    // No synced session for that run yet: no link rather than a wrong one.
    expect(
      findCronRunThreadId({ threadIds, jobId: "1ddfe19fb572", runStamp: "2026-10-05_08-11-30" }),
    ).toBeNull();
  });
});
