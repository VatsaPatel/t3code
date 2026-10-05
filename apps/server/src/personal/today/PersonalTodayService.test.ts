import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as ServerConfig from "../../config.ts";
import * as ThreadManagementService from "../../orchestration-v2/ThreadManagementService.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import * as ProcessRunner from "../../processRunner.ts";
import * as Scheduler from "../../scheduling/Scheduler.ts";
import * as PersonalToday from "./PersonalTodayService.ts";
import * as TodayThreadLauncher from "./TodayThreadLauncher.ts";

const toJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const environmentLayer = Layer.mergeAll(
  SqlitePersistenceMemory,
  ServerConfig.layerTest(process.cwd(), { prefix: "t3-personal-today-test-" }),
).pipe(Layer.provideMerge(NodeServices.layer));

interface FakeWorld {
  readonly requests: Ref.Ref<ReadonlyArray<{ readonly method: string; readonly url: string }>>;
  readonly launches: Ref.Ref<number>;
}

/** Builds one service instance, like one server start, over shared state and a fake world. */
const startService = (world: FakeWorld) =>
  Effect.gen(function* () {
    const http = HttpClient.make((request) =>
      Effect.gen(function* () {
        yield* Ref.update(world.requests, (all) => [
          ...all,
          { method: request.method, url: request.url },
        ]);
        const body = request.url.endsWith("/projects")
          ? { results: [] }
          : request.url.endsWith("/tasks/filter")
            ? { results: [], next_cursor: null }
            : request.url.endsWith("/tasks/42")
              ? { id: "42", content: "Reply to the recruiter", description: "", priority: 1 }
              : null;
        return HttpClientResponse.fromWeb(
          request,
          new Response(body === null ? null : toJson(body), {
            status: body === null ? 204 : 200,
          }),
        );
      }),
    );
    const layer = PersonalToday.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.succeed(HttpClient.HttpClient, http),
          Layer.mock(ProcessRunner.ProcessRunner)({
            run: () =>
              Effect.succeed({
                stdout: "token-from-command\n",
                stderr: "",
                code: ChildProcessSpawner.ExitCode(0),
                timedOut: false,
                stdoutTruncated: false,
                stderrTruncated: false,
                stdoutInvalidUtf8: false,
                stderrInvalidUtf8: false,
              }),
          }),
          Layer.mock(Scheduler.Scheduler)({ register: () => Effect.void }),
          Layer.mock(ThreadManagementService.ThreadManagementService)({}),
          Layer.mock(TodayThreadLauncher.TodayThreadLauncher)({
            launch: () =>
              Ref.update(world.launches, (count) => count + 1).pipe(
                Effect.as(ThreadId.make("thread-delegated")),
              ),
          }),
        ),
      ),
    );
    const context = yield* Layer.build(layer);
    return Context.get(context, PersonalToday.PersonalTodayService);
  });

const makeWorld = Effect.gen(function* () {
  return {
    requests: yield* Ref.make<ReadonlyArray<{ readonly method: string; readonly url: string }>>([]),
    launches: yield* Ref.make(0),
  } satisfies FakeWorld;
});

it.effect("delegating a task links one thread and never completes the to-do", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const world = yield* makeWorld;
    const today = yield* startService(world);

    const first = yield* today.taskAction({ type: "delegate", taskId: "42" });
    const again = yield* today.taskAction({ type: "delegate", taskId: "42" });
    // The agent finishing its run is just a later refresh: the task stays open for review.
    const snapshot = yield* today.refresh();

    assert.equal(first.threadId, "thread-delegated");
    assert.equal(again.threadId, "thread-delegated");
    assert.equal(yield* Ref.get(world.launches), 1);
    const links = yield* sql<{ readonly thread_id: string }>`
      SELECT thread_id FROM personal_today_delegations WHERE task_id = '42'
    `;
    assert.deepEqual(
      links.map((row) => row.thread_id),
      ["thread-delegated"],
    );
    assert.isFalse(
      (yield* Ref.get(world.requests)).some(
        (request) => request.url.endsWith("/close") || request.method === "DELETE",
      ),
    );
    const task = snapshot.tasks.tasks.find((candidate) => candidate.id === "42");
    assert.equal(task?.delegation?.threadId, "thread-delegated");
  }).pipe(Effect.scoped, Effect.provide(environmentLayer)),
);

const JOBS_JSON = toJson({
  jobs: [
    {
      id: "brief1",
      name: "Daily life chief-of-staff brief",
      prompt: "Create the brief",
      schedule: { kind: "cron", expr: "0 8 * * *", display: "every day at 8am" },
      enabled: true,
      state: "scheduled",
      next_run_at: "2026-10-06T08:00:00-07:00",
      last_run_at: "2026-10-05T08:11:30-07:00",
      last_status: "ok",
      deliver: "slack:C123",
    },
    {
      id: "nag1",
      name: "Accountability nag",
      prompt: "Nag me",
      schedule: { kind: "interval", minutes: 180, display: "every 180m" },
      enabled: false,
      state: "paused",
      deliver: "slack",
    },
    { id: "once1", name: "Old reminder", enabled: false, state: "completed" },
  ],
});

const briefOutput = (day: string) =>
  [
    "# Cron Job: Daily life chief-of-staff brief",
    "",
    "## Prompt",
    "",
    "Create the brief",
    "",
    "## Response",
    "",
    `## NOW ${day}`,
    "- **Health:** sleep was short.",
  ].join("\n");

it.effect(
  "reads routines and the latest brief, and announces only briefs that land while running",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const config = yield* ServerConfig.ServerConfig;
      const home = yield* fs.makeTempDirectoryScoped({ prefix: "t3-hermes-home-" });
      const outputs = path.join(home, "cron", "output", "brief1");
      yield* fs.makeDirectory(outputs, { recursive: true });
      yield* fs.writeFileString(path.join(home, "cron", "jobs.json"), JOBS_JSON);
      // Stamps are Hermes wall-clock time, here seven hours behind UTC.
      yield* fs.writeFileString(
        path.join(home, "config.yaml"),
        "model:\n  default: x\ntimezone: America/Los_Angeles\n",
      );
      const writeBrief = (stamp: string, modifiedAt: string) =>
        Effect.gen(function* () {
          const file = path.join(outputs, `${stamp}.md`);
          yield* fs.writeFileString(file, briefOutput(stamp));
          const modified = DateTime.toDateUtc(DateTime.makeUnsafe(modifiedAt));
          yield* fs.utimes(file, modified, modified);
        });
      // Todoist stays off so this test only exercises the cron store.
      yield* fs.writeFileString(
        path.join(config.stateDir, "personal-today-settings.json"),
        toJson({ settings: { todoistEnabled: false, hermesHome: home } }),
      );
      yield* writeBrief("2026-10-04_08-11-30", "2026-10-04T15:11:30Z");

      // First start: an existing brief is a baseline, never a notification.
      yield* TestClock.setTime(Date.parse("2026-10-05T12:00:00Z"));
      const world = yield* makeWorld;
      const announcedAtStart = yield* Effect.scoped(
        Effect.gen(function* () {
          const today = yield* startService(world);
          const atStart = yield* today.pollCron;
          const snapshot = yield* today.refresh();
          assert.deepEqual(
            snapshot.cron.routines.map((routine) => [
              routine.id,
              routine.isBrief,
              routine.notifies,
            ]),
            [
              ["brief1", true, true],
              ["nag1", false, false],
            ],
          );
          assert.equal(snapshot.cron.routines[1]?.intervalMinutes, 180);
          assert.equal(snapshot.cron.brief?.runStamp, "2026-10-04_08-11-30");
          assert.equal(snapshot.cron.brief?.runAt, "2026-10-04T15:11:30.000Z");
          assert.equal(
            snapshot.cron.brief?.markdown,
            "## NOW 2026-10-04_08-11-30\n- **Health:** sleep was short.",
          );
          assert.equal(snapshot.cron.brief?.firstLine, "NOW 2026-10-04_08-11-30");

          // A brief written while the server runs is announced once.
          yield* writeBrief("2026-10-05_08-11-30", "2026-10-05T13:00:00Z");
          const arrived = yield* today.pollCron;
          assert.deepEqual(arrived, [
            {
              jobId: "brief1",
              jobName: "Daily life chief-of-staff brief",
              runStamp: "2026-10-05_08-11-30",
              runAt: "2026-10-05T15:11:30.000Z",
              firstLine: "NOW 2026-10-05_08-11-30",
            },
          ]);
          assert.deepEqual(yield* today.pollCron, []);
          return atStart;
        }),
      );
      assert.deepEqual(announcedAtStart, []);

      // Restart: the announced brief is not replayed, and a brief that landed
      // while the server was down is shown but not notified.
      yield* writeBrief("2026-10-06_08-00-00", "2026-10-05T13:30:00Z");
      yield* TestClock.setTime(Date.parse("2026-10-05T14:00:00Z"));
      yield* Effect.scoped(
        Effect.gen(function* () {
          const today = yield* startService(world);
          assert.deepEqual(yield* today.pollCron, []);
          const snapshot = yield* today.refresh();
          assert.equal(snapshot.cron.brief?.runStamp, "2026-10-06_08-00-00");
        }),
      );
    }).pipe(Effect.scoped, Effect.provide(environmentLayer)),
);
