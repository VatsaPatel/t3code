import {
  PersonalTodayError,
  PersonalTodaySettings,
  PersonalTodaySettingsPatch,
  ThreadId,
  type PersonalTodayBrief,
  type PersonalTodayBriefArrived,
  type PersonalTodayCronState,
  type PersonalTodayPendingPrompt,
  type PersonalTodayPendingPromptsInput,
  type PersonalTodayPendingPromptsResult,
  type PersonalTodayRoutineActionInput,
  type PersonalTodayRoutineHistory,
  type PersonalTodayRoutineHistoryInput,
  type PersonalTodayRoutineRun,
  type PersonalTodaySnapshot,
  type PersonalTodayTask,
  type PersonalTodayTaskActionInput,
  type PersonalTodayTaskActionResult,
  type PersonalTodayTasksState,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { fromJsonStringPretty } from "@t3tools/shared/schemaJson";
import * as NodeOS from "node:os";
import * as NodeSqlite from "node:sqlite";

import { writeFileStringAtomically } from "../../atomicWrite.ts";
import * as ServerConfig from "../../config.ts";
import type * as Orchestrator from "../../orchestration-v2/Orchestrator.ts";
import * as ThreadManagementService from "../../orchestration-v2/ThreadManagementService.ts";
import * as ProcessRunner from "../../processRunner.ts";
import * as Scheduler from "../../scheduling/Scheduler.ts";
import {
  extractCronResponse,
  firstMeaningfulLine,
  matchOutputStamp,
  parseCronJobs,
  parseHermesTimeZone,
  planBriefNotifications,
  resolveBriefJobIds,
  sortedOutputStamps,
  stampToIso,
  toRoutine,
  type BriefOutputObservation,
  type HermesCronJob,
} from "./hermesCron.ts";
import {
  makeTodoistSource,
  PersonalTaskSourceError,
  type PersonalTaskSource,
  type SourceTask,
} from "./TaskSource.ts";
import * as TodayThreadLauncher from "./TodayThreadLauncher.ts";

const SETTINGS_FILE = "personal-today-settings.json";
const CRON_POLL_MS = 30_000;
const TASK_POLL_MS = 3 * 60_000;
/** A subscriber arriving after this long without a fetch triggers one. */
const TASK_STALE_MS = 60_000;
const PROMPT_MAX_LENGTH = 280;

const DEFAULT_PERSONAL_TODAY_SETTINGS: PersonalTodaySettings = {
  todoistEnabled: true,
  todoistTokenCommand: "hsecret get todoist.token",
  hermesHome: null,
  briefJobIds: null,
  notifyJobIds: null,
};

const StoreFile = Schema.Struct({
  settings: Schema.optional(PersonalTodaySettingsPatch),
  briefMarkers: Schema.optional(Schema.Record(Schema.String, Schema.String)),
});
const decodeStoreFile = Schema.decodeUnknownOption(Schema.fromJsonString(StoreFile));
const encodeStoreFile = Schema.encodeEffect(fromJsonStringPretty(StoreFile));
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

/** Structural equality for plain JSON data, used to skip no-op publishes. */
function sameJson<A>(left: A, right: A): boolean {
  return encodeJson(left) === encodeJson(right);
}

interface Store {
  readonly settings: PersonalTodaySettings;
  readonly briefMarkers: Readonly<Record<string, string>>;
}

export class PersonalTodayService extends Context.Service<
  PersonalTodayService,
  {
    /** Snapshot on subscribe, then after each change. Tasks poll while anyone is subscribed. */
    readonly subscribe: () => Stream.Stream<PersonalTodaySnapshot, PersonalTodayError>;
    /** Brief outputs that land while the server runs. */
    readonly subscribeBriefs: () => Stream.Stream<PersonalTodayBriefArrived>;
    readonly refresh: () => Effect.Effect<PersonalTodaySnapshot, PersonalTodayError>;
    readonly taskAction: (
      input: PersonalTodayTaskActionInput,
    ) => Effect.Effect<PersonalTodayTaskActionResult, PersonalTodayError>;
    readonly routineAction: (
      input: PersonalTodayRoutineActionInput,
    ) => Effect.Effect<void, PersonalTodayError>;
    /** Recent runs of one Hermes cron job and one of its outputs. */
    readonly routineHistory: (
      input: PersonalTodayRoutineHistoryInput,
    ) => Effect.Effect<PersonalTodayRoutineHistory, PersonalTodayError>;
    readonly pendingPrompts: (
      input: PersonalTodayPendingPromptsInput,
    ) => Effect.Effect<PersonalTodayPendingPromptsResult, PersonalTodayError>;
    readonly updateSettings: (
      patch: PersonalTodaySettingsPatch,
    ) => Effect.Effect<PersonalTodaySettings, PersonalTodayError>;
    /** Reads the cron store now: routines, the latest brief, and brief notifications. Returns the briefs it announced. */
    readonly pollCron: Effect.Effect<ReadonlyArray<PersonalTodayBriefArrived>>;
  }
>()("t3/personal/today/PersonalTodayService") {}

function mergeSettings(
  base: PersonalTodaySettings,
  patch: PersonalTodaySettingsPatch,
): PersonalTodaySettings {
  return {
    todoistEnabled: patch.todoistEnabled ?? base.todoistEnabled,
    todoistTokenCommand: patch.todoistTokenCommand ?? base.todoistTokenCommand,
    hermesHome:
      patch.hermesHome === undefined
        ? base.hermesHome
        : patch.hermesHome?.trim()
          ? patch.hermesHome.trim()
          : null,
    briefJobIds: patch.briefJobIds === undefined ? base.briefJobIds : patch.briefJobIds,
    notifyJobIds: patch.notifyJobIds === undefined ? base.notifyJobIds : patch.notifyJobIds,
  };
}

function todayError(message: string) {
  return new PersonalTodayError({ message });
}

function clip(text: string, max = PROMPT_MAX_LENGTH): string {
  const single = text.replace(/\s+/g, " ").trim();
  return single.length > max ? `${single.slice(0, max - 1)}…` : single;
}

function delegationPrompt(task: SourceTask): string {
  return [
    task.content,
    task.description.trim().length > 0 ? `\n${task.description.trim()}` : "",
    task.url === null ? "" : `\nTodoist task: ${task.url}`,
    "\nThis is a to-do from my list. Do the work, then summarize what you did and anything I need to decide.",
    "Do not complete, close, or edit the Todoist task itself. I review the result and close it myself.",
  ]
    .filter((part) => part.length > 0)
    .join("\n");
}

const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const sql = yield* SqlClient.SqlClient;
  const config = yield* ServerConfig.ServerConfig;
  const processRunner = yield* ProcessRunner.ProcessRunner;
  const scheduler = yield* Scheduler.Scheduler;
  const threadManagement = yield* ThreadManagementService.ThreadManagementService;
  const launcher = yield* TodayThreadLauncher.TodayThreadLauncher;
  const http = yield* HttpClient.HttpClient;
  const serviceScope = yield* Effect.scope;
  const serverStartedAtMs = yield* Clock.currentTimeMillis;

  // Personal tables are created idempotently instead of through numbered
  // migrations, so upstream migrations keep applying after a rebase.
  yield* sql`
    CREATE TABLE IF NOT EXISTS personal_today_delegations (
      source TEXT NOT NULL,
      task_id TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      delegated_at TEXT NOT NULL,
      PRIMARY KEY (source, task_id)
    )
  `;

  const settingsPath = path.join(config.stateDir, SETTINGS_FILE);
  const initialStore: Store = yield* fs.readFileString(settingsPath).pipe(
    Effect.map((text) =>
      Option.match(decodeStoreFile(text), {
        onNone: () => ({ settings: DEFAULT_PERSONAL_TODAY_SETTINGS, briefMarkers: {} }),
        onSome: (decoded) => ({
          settings: mergeSettings(DEFAULT_PERSONAL_TODAY_SETTINGS, decoded.settings ?? {}),
          briefMarkers: decoded.briefMarkers ?? {},
        }),
      }),
    ),
    Effect.orElseSucceed(() => ({
      settings: DEFAULT_PERSONAL_TODAY_SETTINGS,
      briefMarkers: {},
    })),
  );
  const store = yield* Ref.make<Store>(initialStore);
  const persistStore = Effect.gen(function* () {
    const current = yield* Ref.get(store);
    const contents = yield* encodeStoreFile({
      settings: current.settings,
      briefMarkers: { ...current.briefMarkers },
    });
    yield* writeFileStringAtomically({ filePath: settingsPath, contents: `${contents}\n` });
  }).pipe(
    Effect.provideService(FileSystem.FileSystem, fs),
    Effect.provideService(Path.Path, path),
    Effect.catchCause((cause) => Effect.logWarning("Could not save Today settings", { cause })),
  );

  const changes = yield* PubSub.unbounded<void>();
  const briefEvents = yield* PubSub.unbounded<PersonalTodayBriefArrived>();
  const notifyChanged = PubSub.publish(changes, undefined).pipe(Effect.asVoid);

  // --- Tasks -----------------------------------------------------------------

  const cachedToken = yield* Ref.make<string | null>(null);
  const resolveToken: Effect.Effect<string, PersonalTaskSourceError> = Effect.gen(function* () {
    const cached = yield* Ref.get(cachedToken);
    if (cached !== null) return cached;
    const fromEnv = process.env.TODOIST_API_TOKEN?.trim();
    if (fromEnv) {
      yield* Ref.set(cachedToken, fromEnv);
      return fromEnv;
    }
    const command = (yield* Ref.get(store)).settings.todoistTokenCommand.trim();
    if (command.length === 0) {
      return yield* new PersonalTaskSourceError({
        source: "Todoist",
        operation: "read token",
        detail: "no token command is configured",
      });
    }
    // The command's output is the secret: it is never logged or echoed.
    const output = yield* processRunner
      .run({ command: "/bin/sh", args: ["-c", command], timeout: "15 seconds" })
      .pipe(
        Effect.mapError(
          () =>
            new PersonalTaskSourceError({
              source: "Todoist",
              operation: "read token",
              detail: "the token command could not run",
            }),
        ),
      );
    const token = output.stdout.trim();
    if (output.code !== 0 || token.length === 0) {
      return yield* new PersonalTaskSourceError({
        source: "Todoist",
        operation: "read token",
        detail:
          output.code !== 0
            ? `the token command exited with code ${String(output.code)}`
            : "the token command printed nothing",
      });
    }
    yield* Ref.set(cachedToken, token);
    return token;
  });

  const source: PersonalTaskSource = makeTodoistSource({
    http,
    token: resolveToken,
    invalidateToken: Ref.set(cachedToken, null),
  });

  const tasksState = yield* Ref.make<PersonalTodayTasksState>({
    status: initialStore.settings.todoistEnabled ? "loading" : "disabled",
    source: initialStore.settings.todoistEnabled ? "todoist" : null,
    tasks: [],
    fetchedAt: null,
    error: null,
  });
  const lastTasksFetchAt = yield* Ref.make(0);
  const subscribers = yield* Ref.make(0);
  const taskRefreshLock = yield* Semaphore.make(1);

  const nowIso = DateTime.now.pipe(Effect.map((now) => DateTime.formatIso(now)));

  // Delegated tasks stay visible for review even when they are not due this
  // week. A delegated task that was completed or deleted drops its link.
  const withDelegatedTasks = (listed: ReadonlyArray<SourceTask>) =>
    Effect.gen(function* () {
      const listedIds = new Set(listed.map((task) => task.id));
      const rows = yield* sql<{ readonly task_id: string }>`
        SELECT task_id FROM personal_today_delegations WHERE source = ${source.kind}
      `.pipe(Effect.orElseSucceed(() => []));
      const missing = rows
        .map((row) => row.task_id)
        .filter((taskId) => !listedIds.has(taskId))
        .slice(0, 20);
      const fetched = yield* Effect.forEach(
        missing,
        (taskId) =>
          source.get(taskId).pipe(
            Effect.tap((task) =>
              task === null
                ? sql`
                    DELETE FROM personal_today_delegations
                    WHERE source = ${source.kind} AND task_id = ${taskId}
                  `.pipe(Effect.ignore)
                : Effect.void,
            ),
            // A transient failure keeps the link; the task just skips this refresh.
            Effect.orElseSucceed(() => null),
          ),
        { concurrency: 3 },
      );
      return [...listed, ...fetched.filter((task): task is SourceTask => task !== null)];
    });

  const refreshTasks = Effect.gen(function* () {
    const settings = (yield* Ref.get(store)).settings;
    yield* Ref.set(lastTasksFetchAt, yield* Clock.currentTimeMillis);
    if (!settings.todoistEnabled) {
      yield* Ref.set(tasksState, {
        status: "disabled",
        source: null,
        tasks: [],
        fetchedAt: null,
        error: null,
      });
      return yield* notifyChanged;
    }
    const result = yield* Effect.result(
      source.listUpcoming.pipe(Effect.flatMap((listed) => withDelegatedTasks(listed))),
    );
    const fetchedAt = yield* nowIso;
    if (result._tag === "Success") {
      yield* Ref.set(tasksState, {
        status: "ok",
        source: source.kind,
        tasks: result.success.map((task) => ({ ...task, delegation: null })),
        fetchedAt,
        error: null,
      });
    } else {
      // Keep the last good list visible alongside an honest error.
      yield* Ref.update(tasksState, (previous): PersonalTodayTasksState => ({
        ...previous,
        status: "error",
        source: source.kind,
        error: result.failure.message,
      }));
      yield* Effect.logWarning("Today task refresh failed", { detail: result.failure.message });
    }
    yield* notifyChanged;
  }).pipe(taskRefreshLock.withPermits(1));

  const loadDelegations = sql<{
    readonly source: string;
    readonly task_id: string;
    readonly thread_id: string;
    readonly delegated_at: string;
  }>`SELECT source, task_id, thread_id, delegated_at FROM personal_today_delegations`.pipe(
    Effect.orElseSucceed(() => []),
  );

  const tasksSnapshot = Effect.gen(function* () {
    const state = yield* Ref.get(tasksState);
    const rows = yield* loadDelegations;
    const links = new Map(rows.map((row) => [`${row.source}:${row.task_id}`, row]));
    const tasks: PersonalTodayTask[] = state.tasks.map((task) => {
      const link = links.get(`${task.source}:${task.id}`);
      return {
        ...task,
        delegation:
          link === undefined
            ? null
            : { threadId: ThreadId.make(link.thread_id), delegatedAt: link.delegated_at },
      };
    });
    return { ...state, tasks };
  });

  // --- Hermes cron -----------------------------------------------------------

  const cronState = yield* Ref.make<PersonalTodayCronState>({
    available: false,
    error: null,
    routines: [],
    brief: null,
  });
  const jobsCache = yield* Ref.make<{
    readonly home: string;
    readonly mtimeMs: number;
    readonly jobs: ReadonlyArray<HermesCronJob>;
  } | null>(null);
  const lastCronPollAt = yield* Ref.make(0);
  const cronLock = yield* Semaphore.make(1);

  const hermesHome = (settings: PersonalTodaySettings) =>
    settings.hermesHome ?? process.env.HERMES_HOME ?? path.join(NodeOS.homedir(), ".hermes");

  const mtimeMs = (filePath: string) =>
    fs
      .stat(filePath)
      .pipe(
        Effect.map((info) =>
          Option.match(info.mtime, { onNone: () => 0, onSome: (d) => d.getTime() }),
        ),
      );

  const readJobs = (home: string) =>
    Effect.gen(function* () {
      const jobsPath = path.join(home, "cron", "jobs.json");
      const modified = yield* mtimeMs(jobsPath);
      const cached = yield* Ref.get(jobsCache);
      if (cached !== null && cached.home === home && cached.mtimeMs === modified)
        return cached.jobs;
      const text = yield* fs.readFileString(jobsPath);
      const jobs = yield* Effect.try(() => parseCronJobs(text));
      yield* Ref.set(jobsCache, { home, mtimeMs: modified, jobs });
      return jobs;
    });

  const observeOutputs = (home: string, jobId: string) =>
    Effect.gen(function* () {
      const directory = path.join(home, "cron", "output", jobId);
      const names = yield* fs.readDirectory(directory).pipe(Effect.orElseSucceed(() => []));
      const latestStamp = sortedOutputStamps(names)[0] ?? null;
      const latestModifiedAtMs =
        latestStamp === null
          ? null
          : yield* mtimeMs(path.join(directory, `${latestStamp}.md`)).pipe(
              Effect.orElseSucceed(() => null),
            );
      return { jobId, latestStamp, latestModifiedAtMs } satisfies BriefOutputObservation;
    });

  const readOutput = (home: string, jobId: string, stamp: string) =>
    fs
      .readFileString(path.join(home, "cron", "output", jobId, `${stamp}.md`))
      .pipe(Effect.map(extractCronResponse));

  // Output stamps are in the Hermes time zone; without one configured Hermes
  // uses this host's.
  const hermesTimeZone = (home: string) =>
    fs.readFileString(path.join(home, "config.yaml")).pipe(
      Effect.map(parseHermesTimeZone),
      Effect.orElseSucceed(() => null),
      Effect.map((zone) => zone ?? Intl.DateTimeFormat().resolvedOptions().timeZone),
    );

  const pollCronUnlocked = Effect.gen(function* () {
    yield* Ref.set(lastCronPollAt, yield* Clock.currentTimeMillis);
    const current = yield* Ref.get(store);
    const home = hermesHome(current.settings);
    const jobsResult = yield* Effect.result(readJobs(home));
    if (jobsResult._tag === "Failure") {
      const next: PersonalTodayCronState = {
        available: false,
        error: `No Hermes cron jobs found under ${path.join(home, "cron")}.`,
        routines: [],
        brief: null,
      };
      const previous = yield* Ref.getAndSet(cronState, next);
      if (!sameJson(previous, next)) yield* notifyChanged;
      return [];
    }
    const jobs = jobsResult.success;
    const timeZone = yield* hermesTimeZone(home);
    const jobsById = new Map(jobs.map((job) => [job.id, job]));
    const briefJobIds = resolveBriefJobIds(jobs, current.settings.briefJobIds);
    const notifyJobIds = current.settings.notifyJobIds ?? briefJobIds;
    const watched = [...new Set([...briefJobIds, ...notifyJobIds])].filter((id) =>
      /^[A-Za-z0-9_-]+$/.test(id),
    );
    const observations = yield* Effect.forEach(watched, (jobId) => observeOutputs(home, jobId), {
      concurrency: 4,
    });

    // The brief is the newest output among the brief jobs.
    const briefIds = new Set(briefJobIds);
    const newestBrief = observations
      .filter((observation) => briefIds.has(observation.jobId) && observation.latestStamp !== null)
      .toSorted((left, right) => right.latestStamp!.localeCompare(left.latestStamp!))[0];
    const previousState = yield* Ref.get(cronState);
    let brief: PersonalTodayBrief | null = null;
    if (newestBrief !== undefined) {
      const stamp = newestBrief.latestStamp!;
      const reusable =
        previousState.brief !== null &&
        previousState.brief.jobId === newestBrief.jobId &&
        previousState.brief.runStamp === stamp &&
        previousState.brief.runAt === stampToIso(stamp, timeZone);
      if (reusable) {
        brief = previousState.brief;
      } else {
        const markdown = yield* readOutput(home, newestBrief.jobId, stamp).pipe(
          Effect.orElseSucceed(() => null),
        );
        const job = jobsById.get(newestBrief.jobId);
        brief =
          markdown === null
            ? null
            : {
                jobId: newestBrief.jobId,
                jobName: job?.name ?? newestBrief.jobId,
                runStamp: stamp,
                runAt: stampToIso(stamp, timeZone),
                markdown,
                firstLine: firstMeaningfulLine(markdown),
                deliver: job?.deliver ?? null,
              };
      }
    }

    const notifyIds = new Set(notifyJobIds);
    const plan = planBriefNotifications({
      observations: observations.filter((observation) => notifyIds.has(observation.jobId)),
      markers: current.briefMarkers,
      serverStartedAtMs,
    });
    if (!sameJson(plan.markers, current.briefMarkers)) {
      yield* Ref.update(store, (latest) => ({ ...latest, briefMarkers: plan.markers }));
      yield* persistStore;
    }
    const announced: PersonalTodayBriefArrived[] = [];
    for (const arrival of plan.announce) {
      const firstLine =
        brief !== null && brief.jobId === arrival.jobId && brief.runStamp === arrival.stamp
          ? brief.firstLine
          : yield* readOutput(home, arrival.jobId, arrival.stamp).pipe(
              Effect.map((markdown) => firstMeaningfulLine(markdown)),
              Effect.orElseSucceed(() => ""),
            );
      const event: PersonalTodayBriefArrived = {
        jobId: arrival.jobId,
        jobName: jobsById.get(arrival.jobId)?.name ?? arrival.jobId,
        runStamp: arrival.stamp,
        runAt: stampToIso(arrival.stamp, timeZone),
        firstLine,
      };
      announced.push(event);
      yield* PubSub.publish(briefEvents, event);
    }

    const next: PersonalTodayCronState = {
      available: true,
      error: null,
      // Finished one-shot reminders are history, not routines.
      routines: jobs
        .filter((job) => job.state !== "completed")
        .map((job) => toRoutine(job, briefIds, notifyIds)),
      brief,
    };
    yield* Ref.set(cronState, next);
    if (!sameJson(previousState, next)) yield* notifyChanged;
    return announced;
  });

  const pollCron = pollCronUnlocked.pipe(
    cronLock.withPermits(1),
    Effect.catchCause((cause) =>
      Effect.logWarning("Today cron poll failed", { cause }).pipe(
        Effect.as<ReadonlyArray<PersonalTodayBriefArrived>>([]),
      ),
    ),
  );

  // --- Snapshot and subscriptions -------------------------------------------

  const snapshot = Effect.gen(function* () {
    return {
      tasks: yield* tasksSnapshot,
      cron: yield* Ref.get(cronState),
      settings: (yield* Ref.get(store)).settings,
    } satisfies PersonalTodaySnapshot;
  });

  const forkInService = <A, E>(effect: Effect.Effect<A, E>) =>
    effect.pipe(Effect.ignoreCause({ log: true }), Effect.forkIn(serviceScope), Effect.asVoid);

  const subscribe: PersonalTodayService["Service"]["subscribe"] = () =>
    Stream.unwrap(
      Effect.gen(function* () {
        // Subscribe before the snapshot so a change in between is not lost.
        const subscription = yield* PubSub.subscribe(changes);
        yield* Ref.update(subscribers, (count) => count + 1);
        yield* Effect.addFinalizer(() => Ref.update(subscribers, (count) => count - 1));
        const now = yield* Clock.currentTimeMillis;
        if (now - (yield* Ref.get(lastTasksFetchAt)) > TASK_STALE_MS) {
          yield* forkInService(refreshTasks);
        }
        return Stream.concat(
          Stream.fromEffect(snapshot),
          Stream.fromSubscription(subscription).pipe(Stream.mapEffect(() => snapshot)),
        ).pipe(Stream.changesWith(sameJson));
      }),
    );

  const subscribeBriefs: PersonalTodayService["Service"]["subscribeBriefs"] = () =>
    Stream.unwrap(
      PubSub.subscribe(briefEvents).pipe(
        Effect.map((subscription) => Stream.fromSubscription(subscription)),
      ),
    );

  const refresh: PersonalTodayService["Service"]["refresh"] = () =>
    Effect.gen(function* () {
      yield* Effect.all([refreshTasks, pollCron], { concurrency: 2, discard: true });
      return yield* snapshot;
    });

  // --- Tasks: actions ---------------------------------------------------------

  const requireTasks = Effect.gen(function* () {
    if (!(yield* Ref.get(store)).settings.todoistEnabled) {
      return yield* todayError("Todoist is turned off in Today settings.");
    }
  });

  const mapSourceError = Effect.mapError((error: PersonalTaskSourceError) =>
    todayError(error.message),
  );

  const delegateLock = yield* Semaphore.make(1);

  const findDelegation = (taskId: string) =>
    sql<{ readonly thread_id: string }>`
      SELECT thread_id FROM personal_today_delegations
      WHERE source = ${source.kind} AND task_id = ${taskId}
    `.pipe(
      Effect.map((rows) => (rows[0] === undefined ? null : ThreadId.make(rows[0].thread_id))),
      Effect.mapError(() => todayError("Could not read the delegation record.")),
    );

  const delegate = (input: Extract<PersonalTodayTaskActionInput, { readonly type: "delegate" }>) =>
    Effect.gen(function* () {
      // One task, one delegated thread: a repeat (or double click) returns it.
      const existing = yield* findDelegation(input.taskId);
      if (existing !== null) return existing;
      const task = yield* source.get(input.taskId).pipe(mapSourceError);
      if (task === null) return yield* todayError("That task is no longer open in Todoist.");
      const threadId = yield* launcher
        .launch({
          title: clip(task.content, 80) || "To-do",
          prompt: delegationPrompt(task),
          fallbackModelSelection: input.fallbackModelSelection,
        })
        .pipe(Effect.mapError((error) => todayError(error.message)));
      yield* sql`
        INSERT OR IGNORE INTO personal_today_delegations (source, task_id, thread_id, delegated_at)
        VALUES (${source.kind}, ${input.taskId}, ${threadId}, ${yield* nowIso})
      `.pipe(Effect.mapError(() => todayError("Could not record the delegation.")));
      return threadId;
    }).pipe(delegateLock.withPermits(1));

  const taskAction: PersonalTodayService["Service"]["taskAction"] = (input) =>
    Effect.gen(function* () {
      yield* requireTasks;
      switch (input.type) {
        case "add": {
          const task = yield* source.quickAdd(input.text).pipe(mapSourceError);
          yield* refreshTasks;
          return { taskId: task.id, threadId: null };
        }
        case "complete":
          yield* source.complete(input.taskId).pipe(mapSourceError);
          yield* refreshTasks;
          return { taskId: input.taskId, threadId: null };
        case "reopen":
          yield* source.reopen(input.taskId).pipe(mapSourceError);
          yield* refreshTasks;
          return { taskId: input.taskId, threadId: null };
        case "reschedule":
          yield* source.reschedule(input.taskId, input.dueString).pipe(mapSourceError);
          yield* refreshTasks;
          return { taskId: input.taskId, threadId: null };
        case "delegate": {
          const threadId = yield* delegate(input);
          yield* notifyChanged;
          return { taskId: input.taskId, threadId };
        }
        case "undelegate":
          yield* sql`
            DELETE FROM personal_today_delegations
            WHERE source = ${source.kind} AND task_id = ${input.taskId}
          `.pipe(Effect.mapError(() => todayError("Could not remove the delegation record.")));
          yield* notifyChanged;
          return { taskId: input.taskId, threadId: null };
      }
    });

  // --- Routines ----------------------------------------------------------------

  const hermesBinary = Effect.gen(function* () {
    const fromEnv = process.env.HERMES_BIN?.trim();
    if (fromEnv) return fromEnv;
    const launcherPath = path.join(NodeOS.homedir(), ".local", "bin", "hermes");
    const exists = yield* fs.exists(launcherPath).pipe(Effect.orElseSucceed(() => false));
    return exists ? launcherPath : "hermes";
  });

  const routineAction: PersonalTodayService["Service"]["routineAction"] = (input) =>
    Effect.gen(function* () {
      const settings = (yield* Ref.get(store)).settings;
      const home = hermesHome(settings);
      const jobs = yield* readJobs(home).pipe(
        Effect.mapError(() => todayError("Could not read the Hermes cron jobs.")),
      );
      if (!jobs.some((job) => job.id === input.jobId)) {
        return yield* todayError(`Hermes has no cron job ${input.jobId}.`);
      }
      const binary = yield* hermesBinary;
      const output = yield* processRunner
        .run({
          command: binary,
          args: ["cron", input.action, input.jobId],
          env: { ...process.env, HERMES_HOME: home },
          timeout: "60 seconds",
        })
        .pipe(Effect.mapError(() => todayError(`Could not run \`hermes cron ${input.action}\`.`)));
      if (output.code !== 0) {
        return yield* todayError(
          `\`hermes cron ${input.action}\` failed: ${clip(output.stderr || output.stdout, 200)}`,
        );
      }
      yield* Ref.set(jobsCache, null);
      yield* pollCron;
    }).pipe(Effect.asVoid);

  const JOB_ID_PATTERN = /^[A-Za-z0-9_-]+$/;
  const STAMP_PATTERN = /^\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}$/;

  /** Hermes' run ledger, opened read-only; an absent or locked ledger yields no runs. */
  const readExecutions = (home: string, jobId: string) =>
    Effect.try({
      try: () => {
        const database = new NodeSqlite.DatabaseSync(path.join(home, "cron", "executions.db"), {
          readOnly: true,
        });
        try {
          return database
            .prepare(
              `SELECT status, started_at, finished_at, error FROM executions
               WHERE job_id = ? ORDER BY claimed_at DESC LIMIT 10`,
            )
            .all(jobId)
            .map((row) => ({
              status: typeof row.status === "string" ? row.status : "unknown",
              started_at: typeof row.started_at === "string" ? row.started_at : null,
              finished_at: typeof row.finished_at === "string" ? row.finished_at : null,
              error: typeof row.error === "string" ? row.error : null,
            }));
        } finally {
          database.close();
        }
      },
      catch: () => todayError("Could not read the Hermes run ledger."),
    }).pipe(Effect.orElseSucceed(() => []));

  const routineHistory: PersonalTodayService["Service"]["routineHistory"] = (input) =>
    Effect.gen(function* () {
      if (!JOB_ID_PATTERN.test(input.jobId)) return yield* todayError("Invalid cron job id.");
      const home = hermesHome((yield* Ref.get(store)).settings);
      const directory = path.join(home, "cron", "output", input.jobId);
      const names = yield* fs.readDirectory(directory).pipe(Effect.orElseSucceed(() => []));
      const stamps = sortedOutputStamps(names);
      const rows = yield* readExecutions(home, input.jobId);
      const runs = rows.map((row): PersonalTodayRoutineRun => {
        const started = row.started_at === null ? Number.NaN : Date.parse(row.started_at);
        const finished = row.finished_at === null ? Number.NaN : Date.parse(row.finished_at);
        return {
          status: row.status,
          startedAt: row.started_at,
          finishedAt: row.finished_at,
          durationSeconds:
            Number.isFinite(started) && Number.isFinite(finished)
              ? Math.max(0, Math.round((finished - started) / 1000))
              : null,
          error: row.error === null ? null : clip(row.error, 200),
          outputStamp: matchOutputStamp(row.finished_at, stamps),
        };
      });
      const stamp =
        input.stamp !== undefined && STAMP_PATTERN.test(input.stamp) ? input.stamp : stamps[0];
      const markdown =
        stamp === undefined
          ? null
          : yield* readOutput(home, input.jobId, stamp).pipe(Effect.orElseSucceed(() => null));
      return {
        jobId: input.jobId,
        runs,
        outputStamps: stamps.slice(0, 10),
        output:
          stamp === undefined || markdown === null
            ? null
            : { stamp, runAt: stampToIso(stamp, yield* hermesTimeZone(home)), markdown },
      };
    });

  // --- Pending prompts ----------------------------------------------------------

  const pendingPromptFor = (threadId: ThreadId) =>
    Effect.gen(function* (): Effect.fn.Return<
      PersonalTodayPendingPrompt | null,
      Orchestrator.OrchestratorV2Error
    > {
      const records = yield* threadManagement.getThreadRecords(
        threadId,
        ["runtimeRequests", "turnItems"],
        { turnItemTypes: ["user_input_request", "approval_request"] },
      );
      const pending = records.runtimeRequests
        .filter((request) => request.status === "pending")
        .toSorted(
          (left, right) =>
            DateTime.toEpochMillis(right.createdAt) - DateTime.toEpochMillis(left.createdAt),
        );
      for (const request of pending) {
        const item = records.turnItems.findLast(
          (candidate) =>
            (candidate.type === "user_input_request" || candidate.type === "approval_request") &&
            candidate.requestId === request.id,
        );
        if (item?.type === "user_input_request") {
          const first = item.questions[0];
          if (first === undefined) continue;
          const more = item.questions.length > 1 ? ` (+${item.questions.length - 1} more)` : "";
          return {
            threadId,
            kind: "user_input",
            requestId: request.id,
            text: `${clip(first.question)}${more}`,
          } satisfies PersonalTodayPendingPrompt;
        }
        if (item?.type === "approval_request") {
          return {
            threadId,
            kind: "approval",
            requestId: request.id,
            text: clip(item.prompt ?? item.title ?? `Approve ${item.requestKind}?`),
          } satisfies PersonalTodayPendingPrompt;
        }
      }
      const plans = yield* threadManagement.getThreadRecords(threadId, ["turnItems"], {
        turnItemTypes: ["proposed_plan"],
      });
      const plan = plans.turnItems.findLast((item) => item.type === "proposed_plan");
      if (plan?.type === "proposed_plan") {
        return {
          threadId,
          kind: "plan",
          requestId: null,
          text: clip(firstMeaningfulLine(plan.markdown, PROMPT_MAX_LENGTH) || "Plan ready"),
        } satisfies PersonalTodayPendingPrompt;
      }
      return null;
    });

  const pendingPrompts: PersonalTodayService["Service"]["pendingPrompts"] = (input) =>
    Effect.forEach(
      input.threadIds,
      (threadId) =>
        pendingPromptFor(threadId).pipe(
          // A thread that cannot be read just shows no question text.
          Effect.orElseSucceed(() => null),
        ),
      { concurrency: 4 },
    ).pipe(
      Effect.map((prompts) => ({
        prompts: prompts.filter((prompt): prompt is PersonalTodayPendingPrompt => prompt !== null),
      })),
    );

  // --- Settings -------------------------------------------------------------------

  const updateSettings: PersonalTodayService["Service"]["updateSettings"] = (patch) =>
    Effect.gen(function* () {
      const previous = (yield* Ref.get(store)).settings;
      const next = mergeSettings(previous, patch);
      yield* Ref.update(store, (current) => ({ ...current, settings: next }));
      yield* persistStore;
      if (next.todoistTokenCommand !== previous.todoistTokenCommand) {
        yield* Ref.set(cachedToken, null);
      }
      if (next.hermesHome !== previous.hermesHome) yield* Ref.set(jobsCache, null);
      yield* notifyChanged;
      yield* forkInService(Effect.all([refreshTasks, pollCron], { concurrency: 2 }));
      return next;
    });

  // --- Background polling -----------------------------------------------------------

  const tick = Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    if (now - (yield* Ref.get(lastCronPollAt)) >= CRON_POLL_MS) yield* Effect.asVoid(pollCron);
    if (
      (yield* Ref.get(subscribers)) > 0 &&
      now - (yield* Ref.get(lastTasksFetchAt)) >= TASK_POLL_MS
    ) {
      yield* refreshTasks;
    }
  });
  yield* scheduler.register("personal-today", tick);

  return PersonalTodayService.of({
    subscribe,
    subscribeBriefs,
    refresh,
    taskAction,
    routineAction,
    routineHistory,
    pendingPrompts,
    updateSettings,
    pollCron,
  });
});

export const layer = Layer.effect(PersonalTodayService, make);

/** Production wiring: Hermes threads launch through the orchestration runtime. */
export const liveLayer = layer.pipe(
  Layer.provide(TodayThreadLauncher.layer),
  Layer.provide(ProcessRunner.layer),
);
