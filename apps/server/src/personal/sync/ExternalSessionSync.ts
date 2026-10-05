/**
 * ExternalSessionSync - keep T3 threads in step with agent sessions that run
 * outside T3 Code: Codex CLI and Claude Code transcripts, and every Hermes
 * session origin (CLI, desktop, Slack, cron, ACP, TUI, web UI, WhatsApp, and
 * delegate children).
 *
 * A cheap poll (directory listing and stat for transcripts, indexed queries on
 * Hermes' read-only `state.db`) finds sessions that are new or changed since
 * they were last synced. A new session becomes a deterministic
 * `import:<instanceId>:<nativeSessionId>` thread, written the same way the
 * onboarding importer writes one, plus a row in `personal_external_sessions`.
 * A grown session appends only its new messages.
 *
 * Invariants:
 * - A native session already bound to another T3 thread (a provider thread
 *   whose native ref names it) is T3's own and is never imported.
 * - Native messages produced while T3 ran a turn on the thread are already
 *   shown by that turn. They are absorbed: the cursor advances, nothing is
 *   appended. Nothing is read while a T3 run is active on the thread.
 * - An existing thread never moves project, and a thread the user deleted is
 *   never recreated (its row stays).
 *
 * @module personal/sync/ExternalSessionSync
 */
import * as NodeCrypto from "node:crypto";
import * as NodeOS from "node:os";

import {
  DEFAULT_MODEL,
  DEFAULT_MODEL_BY_PROVIDER,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  type AgentSessionScanError,
  EventId,
  MessageId,
  PersonalSyncError,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  TurnItemId,
  providerInstanceConfigEnabledFlag,
  type OrchestrationV2AppThread,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2Run,
  type OrchestrationV2TurnItem,
  type PersonalExternalSession,
  type PersonalSyncSettings,
  type PersonalSyncSource,
  type PersonalSyncSourceStatus,
  type PersonalSyncStatus,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as EventSink from "../../orchestration-v2/EventSink.ts";
import * as IdAllocator from "../../orchestration-v2/IdAllocator.ts";
import * as ProjectionStore from "../../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../../orchestration-v2/ProjectStore.ts";
import * as ServerConfig from "../../config.ts";
import * as ManagedProjectFolders from "../../project/ManagedProjectFolders.ts";
import * as ProjectService from "../../project/ProjectService.ts";
import { expandHomePath } from "../../pathExpansion.ts";
import * as ProviderSessionRuntime from "../../persistence/ProviderSessionRuntime.ts";
import * as AgentSessionScanner from "../../project/AgentSessionScanner.ts";
import * as Scheduler from "../../scheduling/Scheduler.ts";
import * as ServerSettings from "../../serverSettings.ts";
import * as PersonalSettings from "../PersonalSettings.ts";
import * as ExternalSessionStore from "./ExternalSessionStore.ts";
import {
  openHermesStateReader,
  type HermesSessionRow,
  type HermesStateReader,
} from "./HermesStateReader.ts";
import { makeSyncProjectResolver } from "./SyncProjectResolver.ts";
import { readTranscriptOrigin } from "./TranscriptOrigin.ts";

const EVENT_PREFIX = "personal-sync:v1";
const isPersonalSyncError = Schema.is(PersonalSyncError);
const HERMES_DRIVER = ProviderDriverKind.make("hermes");
const DEFAULT_HERMES_INSTANCE = ProviderInstanceId.make("hermes");
/** Hermes listings hide these sources; so does T3. */
const HERMES_EXCLUDED_SOURCES = new Set(["oneshot", "tool", "kanban"]);
const MAX_SYNCED_MESSAGES = 300;
/** New threads per source per pass, so a large first backfill spreads over several polls. */
const MAX_CREATIONS_PER_PASS = 50;
/**
 * A session T3 just started is bound to its thread moments after the native
 * store records it. Waiting this long before importing a brand-new session
 * keeps that race from creating a duplicate.
 */
const MIN_SESSION_AGE_MS = 30_000;
const LARGE_TRANSCRIPT_BYTES = 16 * 1024 * 1024;
const LARGE_TRANSCRIPT_REREAD_MS = 5 * 60_000;
/** Imported sessions idle longer than this land settled, like onboarding imports. */
const SETTLED_AFTER_MS = 24 * 60 * 60 * 1000;
/** Native writes of a T3 turn land around the run's own timestamps. */
const RUN_ECHO_LEAD_MS = 2_000;
const RUN_ECHO_TRAIL_MS = 5_000;
const ACTIVE_RUN_STATUSES = new Set<OrchestrationV2Run["status"]>([
  "preparing",
  "queued",
  "starting",
  "running",
  "waiting",
]);
const CLAUDE_SESSION_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TRANSCRIPT_SESSION_ID_PATTERN =
  /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;
const CRON_SESSION_PATTERN = /^cron_(.+)_\d{8}_\d{6}$/;
const SOURCES: ReadonlyArray<PersonalSyncSource> = ["codex", "claude", "hermes"];

interface NativeMessage {
  /** Stable per native message; keys the event ids so retries are idempotent. */
  readonly key: string;
  readonly role: "user" | "assistant";
  readonly text: string;
  readonly atMs: number;
}

interface NativeSession {
  readonly driver: ProviderDriverKind;
  readonly providerInstanceId: ProviderInstanceId;
  readonly nativeSessionId: string;
  readonly productName: string;
  readonly title: string | null;
  readonly model: string | null;
  readonly cwd: string | null;
  readonly origin: string;
  readonly originDetail: string | null;
  readonly parent: {
    readonly nativeSessionId: string;
    readonly relationship: "subagent" | "fork";
  } | null;
  readonly startedAtMs: number;
  readonly activityAtMs: number;
  readonly archived: boolean;
  readonly nativeSourcePath: string | null;
  readonly resumeCursor: unknown;
  readonly loadRecent: Effect.Effect<{
    readonly messages: ReadonlyArray<NativeMessage>;
    readonly total: number;
  }>;
  readonly loadAfter: (cursorMs: number) => Effect.Effect<ReadonlyArray<NativeMessage>>;
}

type SyncOutcome = "created" | "appended" | "absorbed" | "unchanged" | "skipped" | "deferred";

interface SourceState {
  readonly lastRunAt: string | null;
  readonly lastSuccessAt: string | null;
  readonly nextRunAtMs: number;
  readonly discoveredCount: number;
  readonly lastError: string | null;
  readonly errorStreak: number;
  readonly idleStreak: number;
}

const initialSourceState: SourceState = {
  lastRunAt: null,
  lastSuccessAt: null,
  nextRunAtMs: 0,
  discoveredCount: 0,
  lastError: null,
  errorStreak: 0,
  idleStreak: 0,
};

const isoOf = (ms: number) => DateTime.formatIso(DateTime.makeUnsafe(ms));
const shortHash = (value: string) =>
  NodeCrypto.createHash("sha1").update(value).digest("hex").slice(0, 12);
const bindingKey = (driver: string, nativeId: string) => `${driver}\u0000${nativeId}`;
const threadIdFor = (instanceId: ProviderInstanceId, nativeId: string) =>
  ThreadId.make(`import:${instanceId}:${nativeId}`);
const titleFrom = (
  title: string | null,
  messages: ReadonlyArray<NativeMessage>,
  fallback: string,
) => {
  const trimmed = title?.trim();
  if (trimmed) return trimmed.slice(0, 200);
  const firstLine = messages
    .find((message) => message.role === "user")
    ?.text.trim()
    .split("\n")[0]
    ?.slice(0, 100)
    .trim();
  return firstLine && firstLine.length > 0 ? firstLine : fallback;
};
const asRecord = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const nonEmpty = (value: unknown) =>
  typeof value === "string" && value.trim() !== "" ? value.trim() : null;

/** Message and turn-item events for one native message, keyed by its stable native key. */
function messageEvents(threadId: ThreadId, message: NativeMessage) {
  const at = DateTime.makeUnsafe(message.atMs);
  const messageId = MessageId.make(`${threadId}:sync:${message.key}`);
  const turnItemId = TurnItemId.make(`${EVENT_PREFIX}:turn-item:${threadId}:${message.key}`);
  const common = {
    id: turnItemId,
    threadId,
    runId: null,
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: 0,
    status: "completed" as const,
    title: null,
    startedAt: at,
    completedAt: at,
    updatedAt: at,
  };
  const turnItem: OrchestrationV2TurnItem =
    message.role === "user"
      ? {
          ...common,
          createdBy: "user",
          creationSource: "server",
          type: "user_message",
          messageId,
          inputIntent: "turn_start",
          text: message.text,
          attachments: [],
        }
      : { ...common, type: "assistant_message", messageId, text: message.text, streaming: false };
  const events: ReadonlyArray<OrchestrationV2DomainEvent> = [
    {
      id: EventId.make(`${EVENT_PREFIX}:message:${threadId}:${message.key}`),
      type: "message.updated",
      threadId,
      occurredAt: at,
      payload: {
        createdBy: message.role === "user" ? "user" : "agent",
        creationSource: "server",
        id: messageId,
        threadId,
        runId: null,
        nodeId: null,
        role: message.role,
        text: message.text,
        attachments: [],
        streaming: false,
        createdAt: at,
        updatedAt: at,
      },
    },
    {
      id: EventId.make(`${EVENT_PREFIX}:turn-item:${threadId}:${message.key}`),
      type: "turn-item.updated",
      threadId,
      occurredAt: at,
      payload: turnItem,
    },
  ];
  return { events, turnItemId };
}

function hermesHomeFor(config: Record<string, unknown>): string {
  const base = nonEmpty(config.hermesHome);
  const profile = nonEmpty(config.profile) ?? "default";
  const root = base === null ? `${NodeOS.homedir()}/.hermes` : expandHomePath(base);
  return profile === "default" ? root : `${root}/profiles/${profile}`;
}

export class ExternalSessionSync extends Context.Service<
  ExternalSessionSync,
  {
    readonly status: Effect.Effect<PersonalSyncStatus, PersonalSyncError>;
    /** Run every enabled source now, after any pass already in flight. */
    readonly runNow: Effect.Effect<PersonalSyncStatus, PersonalSyncError>;
    /** The link row for a synced thread, or null for threads that did not come from sync. */
    readonly getExternalSession: (
      threadId: ThreadId,
    ) => Effect.Effect<PersonalExternalSession | null, PersonalSyncError>;
    readonly listExternalSessions: Effect.Effect<
      ReadonlyArray<PersonalExternalSession>,
      PersonalSyncError
    >;
  }
>()("t3/personal/sync/ExternalSessionSync") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const eventSink = yield* EventSink.EventSinkV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const idAllocator = yield* IdAllocator.IdAllocatorV2;
  const runtimes = yield* ProviderSessionRuntime.ProviderSessionRuntimeRepository;
  const scanner = yield* AgentSessionScanner.AgentSessionScanner;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const personalSettings = yield* PersonalSettings.PersonalSettings;
  const store = yield* ExternalSessionStore.ExternalSessionStore;
  const scheduler = yield* Scheduler.Scheduler;
  const resolverContext = yield* Effect.context<
    | ServerConfig.ServerConfig
    | ProjectStore.ProjectStoreV2
    | ProjectService.ProjectService
    | ManagedProjectFolders.ManagedProjectFolders
    | FileSystem.FileSystem
    | Path.Path
  >();

  const passLock = yield* Semaphore.make(1);
  const running = yield* Ref.make(false);
  const sourceStates = yield* Ref.make(
    new Map<PersonalSyncSource, SourceState>(SOURCES.map((source) => [source, initialSourceState])),
  );
  /** Sessions that were looked at and not imported, by the activity they had then. */
  const skippedAt = new Map<string, number>();
  /** When a large synced transcript was last read, by file. */
  const largeTranscriptReads = new Map<string, number>();
  /** Hermes readers stay open between polls; a failing one is closed and reopened. */
  const hermesReaders = new Map<string, HermesStateReader>();
  /** Start of the last complete Hermes pass per store, for incremental listing. */
  const hermesWatermarks = new Map<string, number>();
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      for (const reader of hermesReaders.values()) reader.close();
      hermesReaders.clear();
    }),
  );

  // ---------------------------------------------------------------------------
  // Pass context
  // ---------------------------------------------------------------------------

  interface PassContext {
    readonly nowMs: number;
    readonly passStartIso: string;
    readonly settings: PersonalSyncSettings;
    readonly bindings: Map<string, ThreadId>;
    readonly rows: Map<ThreadId, ExternalSessionStore.ExternalSessionRow>;
    readonly resolveProject: (cwd: string | null) => Effect.Effect<ProjectId, PersonalSyncError>;
    creationsLeft: number;
    /** Listed once per pass and shared by the Codex and Claude sources. */
    readonly transcripts: Effect.Effect<
      ReadonlyArray<AgentSessionScanner.AgentSessionTranscript>,
      AgentSessionScanError
    >;
  }

  /** Native ids T3's provider threads point at, including deleted threads. */
  const readBindings = sql<{
    readonly thread_id: string;
    readonly provider: string;
    readonly native_id: string;
  }>`
    SELECT thread_id, provider, json_extract(payload_json, '$.nativeThreadRef.nativeId') AS native_id
    FROM orchestration_v2_projection_provider_threads
    WHERE thread_id IS NOT NULL
      AND json_extract(payload_json, '$.nativeThreadRef.nativeId') IS NOT NULL
  `.pipe(
    Effect.map(
      (rows) =>
        new Map(
          rows.map((row) => [
            bindingKey(row.provider, row.native_id),
            ThreadId.make(row.thread_id),
          ]),
        ),
    ),
  );

  const makePassContext = Effect.gen(function* () {
    const settings = (yield* personalSettings.get).sync;
    const now = yield* DateTime.now;
    const bindings = yield* readBindings;
    const rows = new Map((yield* store.list()).map((row) => [row.threadId, row] as const));
    // Projects resolve lazily: a pass with nothing new never lists projects.
    let resolver: Effect.Success<ReturnType<typeof makeSyncProjectResolver>> | null = null;
    const resolveProject = (cwd: string | null) =>
      Effect.gen(function* () {
        if (resolver === null) {
          resolver = yield* makeSyncProjectResolver({ homeProjectPath: settings.homeProjectPath });
        }
        return yield* resolver.resolve(cwd);
      }).pipe(
        Effect.provideContext(resolverContext),
        Effect.mapError(
          (cause) =>
            new PersonalSyncError({ message: "Could not choose a project for a session.", cause }),
        ),
      );
    const context: PassContext = {
      nowMs: DateTime.toEpochMillis(now),
      passStartIso: DateTime.formatIso(now),
      settings,
      bindings,
      rows,
      resolveProject,
      creationsLeft: MAX_CREATIONS_PER_PASS,
      transcripts: yield* Effect.cached(scanner.listSessionTranscripts),
    };
    return context;
  });

  // ---------------------------------------------------------------------------
  // Writing
  // ---------------------------------------------------------------------------

  /** Drop events an earlier, interrupted attempt already committed. */
  const withoutCommitted = (events: ReadonlyArray<OrchestrationV2DomainEvent>) =>
    Effect.gen(function* () {
      if (events.length === 0) return events;
      const committed = new Set<string>();
      for (let index = 0; index < events.length; index += 400) {
        const ids = events.slice(index, index + 400).map((event) => event.id);
        const rows = yield* sql<{ readonly event_id: string }>`
          SELECT event_id FROM orchestration_events WHERE event_id IN ${sql.in(ids)}
        `;
        for (const row of rows) committed.add(row.event_id);
      }
      return committed.size === 0 ? events : events.filter((event) => !committed.has(event.id));
    });

  /**
   * Position appended items after everything already on the thread. Without
   * this, runless items sort before every T3 run's items.
   */
  const placeAfterExisting = (threadId: ThreadId, turnItemIds: ReadonlyArray<TurnItemId>) =>
    Effect.forEach(
      turnItemIds,
      (turnItemId) => sql`
        INSERT INTO orchestration_v2_turn_item_positions (thread_id, turn_item_id, ordinal)
        SELECT ${threadId}, ${turnItemId}, COALESCE(MAX(ordinal), 0) + 1
        FROM orchestration_v2_turn_item_positions
        WHERE thread_id = ${threadId}
        ON CONFLICT(thread_id, turn_item_id) DO NOTHING
      `,
      { discard: true },
    );

  // ---------------------------------------------------------------------------
  // Core: one native session
  // ---------------------------------------------------------------------------

  const createThread = Effect.fn("ExternalSessionSync.createThread")(function* (
    context: PassContext,
    native: NativeSession,
    threadId: ThreadId,
    parent: {
      readonly threadId: ThreadId;
      readonly relationship: "subagent" | "fork";
    } | null,
  ) {
    const { messages, total } = yield* native.loadRecent;
    if (messages.length === 0) return "skipped" as const;
    let projectId: ProjectId;
    let rootThreadId = threadId;
    if (parent !== null) {
      const parentRecords = yield* Effect.option(projections.getThreadRecords(parent.threadId, []));
      // A child never outlives a parent the user deleted.
      if (Option.isNone(parentRecords) || parentRecords.value.thread.deletedAt !== null) {
        return "skipped" as const;
      }
      projectId = parentRecords.value.thread.projectId;
      rootThreadId = parentRecords.value.thread.lineage.rootThreadId;
    } else {
      projectId = yield* context.resolveProject(native.cwd);
    }
    const truncated = total > messages.length;
    const firstAtMs = messages[0]?.atMs ?? native.startedAtMs;
    const history: ReadonlyArray<NativeMessage> = truncated
      ? [
          {
            key: "earlier-history",
            role: "assistant",
            text: `Earlier history is available in ${native.productName}.`,
            atMs: firstAtMs - 1,
          },
          ...messages,
        ]
      : messages;
    const lastAtMs = Math.max(...messages.map((message) => message.atMs));
    const createdAt = DateTime.makeUnsafe(
      Math.min(native.startedAtMs, history[0]?.atMs ?? firstAtMs),
    );
    const updatedAtMs = Math.max(lastAtMs, Math.min(native.activityAtMs, context.nowMs));
    const updatedAt = DateTime.makeUnsafe(updatedAtMs);
    const settled = context.nowMs - updatedAtMs > SETTLED_AFTER_MS;
    const title = titleFrom(native.title, messages, `${native.productName} session`);
    const model =
      native.model ??
      DEFAULT_MODEL_BY_PROVIDER[native.driver] ??
      (native.driver === HERMES_DRIVER ? "default" : DEFAULT_MODEL);
    const providerThreadId = idAllocator.derive.providerThread({
      driver: native.driver,
      nativeThreadId: native.nativeSessionId,
    });
    const isSubagent = parent?.relationship === "subagent";
    const appThread: OrchestrationV2AppThread = {
      createdBy: "system",
      // A provider-native subagent cannot take messages on its own; its parent drives it.
      creationSource: isSubagent ? "provider" : "server",
      id: threadId,
      projectId,
      title,
      providerInstanceId: native.providerInstanceId,
      modelSelection: { instanceId: native.providerInstanceId, model },
      runtimeMode: DEFAULT_RUNTIME_MODE,
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      branch: null,
      worktreePath: null,
      linkedPullRequest: null,
      branchPullRequest: null,
      activeProviderThreadId: providerThreadId,
      historyOrigin: "v1_import",
      lineage: {
        parentThreadId: parent?.threadId ?? null,
        relationshipToParent: parent?.relationship ?? null,
        rootThreadId,
      },
      forkedFrom: null,
      createdAt,
      updatedAt,
      archivedAt: native.archived ? updatedAt : null,
      settledOverride: settled ? "settled" : null,
      settledAt: settled ? updatedAt : null,
      unsettledAt: null,
      snoozedUntil: null,
      snoozedAt: null,
      pinnedAt: null,
      pinOrderKey: null,
      activeOrderKey: null,
      lastVisitedAt: null,
      deletedAt: null,
    };
    const providerThread: OrchestrationV2ProviderThread = {
      id: providerThreadId,
      driver: native.driver,
      providerInstanceId: native.providerInstanceId,
      providerSessionId: null,
      appThreadId: threadId,
      ownerNodeId: null,
      nativeThreadRef: {
        driver: native.driver,
        nativeId: native.nativeSessionId,
        strength: "strong",
      },
      nativeConversationHeadRef: null,
      status: "idle",
      firstRunOrdinal: null,
      lastRunOrdinal: null,
      handoffIds: [],
      forkedFrom: null,
      pendingBackgroundTasks: [],
      createdAt,
      updatedAt,
    };
    yield* runtimes.upsert(
      {
        threadId,
        providerName: native.driver,
        providerInstanceId: native.providerInstanceId,
        adapterKey: native.driver,
        runtimeMode: DEFAULT_RUNTIME_MODE,
        status: "stopped",
        lastSeenAt: DateTime.formatIso(updatedAt),
        resumeCursor: native.resumeCursor,
        runtimePayload: native.cwd === null ? null : { cwd: native.cwd },
      },
      { onConflict: "ignore" },
    );
    const events = yield* withoutCommitted([
      {
        id: EventId.make(`${EVENT_PREFIX}:thread:${threadId}:created`),
        type: "thread.created",
        threadId,
        providerInstanceId: native.providerInstanceId,
        occurredAt: createdAt,
        payload: appThread,
      },
      ...history.flatMap((message) => messageEvents(threadId, message).events),
      {
        id: EventId.make(`${EVENT_PREFIX}:provider-thread:${providerThreadId}`),
        type: "provider-thread.updated",
        threadId,
        driver: native.driver,
        providerInstanceId: native.providerInstanceId,
        occurredAt: updatedAt,
        payload: providerThread,
      },
    ]);
    yield* eventSink.write({ events });
    yield* store.upsert({
      threadId,
      providerInstanceId: native.providerInstanceId,
      driver: native.driver,
      nativeSessionId: native.nativeSessionId,
      origin: native.origin,
      originDetail: native.originDetail,
      cwd: native.cwd,
      nativeMessageCount: total,
      nativeUpdatedAt: isoOf(lastAtMs),
      lastSyncedAt: context.passStartIso,
      parentNativeSessionId: native.parent?.nativeSessionId ?? null,
      nativeTitle: title,
      nativeSourcePath: native.nativeSourcePath,
    });
    return "created" as const;
  });

  const syncExisting = Effect.fn("ExternalSessionSync.syncExisting")(function* (
    context: PassContext,
    native: NativeSession,
    row: ExternalSessionStore.ExternalSessionRow,
  ) {
    const records = yield* Effect.option(projections.getThreadRecords(row.threadId, ["runs"]));
    const metadata = {
      ...row,
      origin: native.origin,
      originDetail: native.originDetail ?? row.originDetail,
      cwd: native.cwd ?? row.cwd,
      nativeSourcePath: native.nativeSourcePath ?? row.nativeSourcePath,
    };
    // A thread the user deleted stays deleted; only the cursor timestamp moves.
    if (Option.isNone(records) || records.value.thread.deletedAt !== null) {
      yield* store.upsert({ ...metadata, lastSyncedAt: context.passStartIso });
      return "unchanged" as const;
    }
    const { thread, runs } = records.value;
    if (runs.some((run) => ACTIVE_RUN_STATUSES.has(run.status))) return "deferred" as const;

    const cursorMs = Date.parse(row.nativeUpdatedAt);
    const delta = yield* native.loadAfter(Number.isFinite(cursorMs) ? cursorMs : 0);
    const runWindows = runs.map((run) => ({
      from: DateTime.toEpochMillis(run.requestedAt) - RUN_ECHO_LEAD_MS,
      to:
        (run.completedAt === null ? context.nowMs : DateTime.toEpochMillis(run.completedAt)) +
        RUN_ECHO_TRAIL_MS,
    }));
    // T3's own turns also land in the native store; they are already shown.
    const toAppend = delta.filter(
      (message) =>
        !runWindows.some((window) => message.atMs >= window.from && message.atMs <= window.to),
    );
    const nextCursorMs = Math.max(
      Number.isFinite(cursorMs) ? cursorMs : 0,
      ...delta.map((message) => message.atMs),
    );

    // Adopt a native rename only while the T3 title is still the last native one.
    const nativeTitle = native.title?.trim() ? native.title.trim().slice(0, 200) : null;
    const adoptTitle =
      nativeTitle !== null && nativeTitle !== row.nativeTitle && thread.title === row.nativeTitle;
    const unsettle =
      toAppend.length > 0 && (thread.settledOverride === "settled" || thread.settledAt !== null);

    const appended = toAppend.map((message) => messageEvents(row.threadId, message));
    const lastAppendedMs = Math.max(...toAppend.map((message) => message.atMs));
    const threadEvent: ReadonlyArray<OrchestrationV2DomainEvent> =
      adoptTitle || unsettle
        ? [
            {
              id: EventId.make(
                `${EVENT_PREFIX}:thread:${row.threadId}:${unsettle ? "unsettled" : "title"}:${nextCursorMs}:${shortHash(nativeTitle ?? "")}`,
              ),
              type: unsettle ? "thread.unsettled" : "thread.metadata-updated",
              threadId: row.threadId,
              occurredAt: DateTime.makeUnsafe(toAppend.length > 0 ? lastAppendedMs : context.nowMs),
              payload: {
                ...thread,
                ...(adoptTitle && nativeTitle !== null ? { title: nativeTitle } : {}),
                ...(unsettle
                  ? {
                      settledOverride: null,
                      settledAt: null,
                      unsettledAt: DateTime.makeUnsafe(context.nowMs),
                    }
                  : {}),
                updatedAt: DateTime.makeUnsafe(
                  toAppend.length > 0
                    ? Math.max(lastAppendedMs, DateTime.toEpochMillis(thread.updatedAt))
                    : DateTime.toEpochMillis(thread.updatedAt),
                ),
              },
            },
          ]
        : [];
    const events = yield* withoutCommitted([
      ...appended.flatMap((entry) => entry.events),
      ...threadEvent,
    ]);
    if (events.length > 0) {
      yield* placeAfterExisting(
        row.threadId,
        appended.map((entry) => entry.turnItemId),
      );
      yield* eventSink.write({ events });
    }
    yield* store.upsert({
      ...metadata,
      nativeMessageCount: row.nativeMessageCount + delta.length,
      nativeUpdatedAt: isoOf(nextCursorMs),
      lastSyncedAt: context.passStartIso,
      nativeTitle: nativeTitle ?? row.nativeTitle,
    });
    if (toAppend.length > 0) return "appended" as const;
    return delta.length > 0 ? ("absorbed" as const) : ("unchanged" as const);
  });

  /**
   * Sync one session. `lookupParent` produces the parent session when it has
   * not been synced yet, so children always land under their parent.
   */
  const syncSession = (
    context: PassContext,
    native: NativeSession,
    lookupParent: (nativeSessionId: string) => Effect.Effect<NativeSession | null>,
    depth = 0,
  ): Effect.Effect<SyncOutcome, PersonalSyncError> =>
    Effect.gen(function* () {
      const threadId = threadIdFor(native.providerInstanceId, native.nativeSessionId);
      const row = context.rows.get(threadId);
      if (row !== undefined) {
        const outcome = yield* syncExisting(context, native, row);
        const updated = yield* store.get(threadId);
        if (updated !== null) context.rows.set(threadId, updated);
        return outcome;
      }
      const skipKey = bindingKey(native.providerInstanceId, native.nativeSessionId);
      if (skippedAt.get(skipKey) === native.activityAtMs) return "skipped" as const;
      const skip = () => {
        skippedAt.set(skipKey, native.activityAtMs);
        return "skipped" as const;
      };

      // The invariant: a session another T3 thread owns is T3's own.
      const boundThread = context.bindings.get(bindingKey(native.driver, native.nativeSessionId));
      if (boundThread !== undefined && boundThread !== threadId) return skip();

      // A thread written by an earlier attempt (or by onboarding import) is
      // adopted as-is: its history stands, and syncing continues from now.
      const existing = yield* Effect.option(projections.getThreadRecords(threadId, []));
      if (Option.isSome(existing)) {
        const latest = yield* native.loadRecent;
        const lastAtMs = Math.max(
          native.startedAtMs,
          ...latest.messages.map((message) => message.atMs),
        );
        yield* store.upsert({
          threadId,
          providerInstanceId: native.providerInstanceId,
          driver: native.driver,
          nativeSessionId: native.nativeSessionId,
          origin: native.origin,
          originDetail: native.originDetail,
          cwd: native.cwd,
          nativeMessageCount: latest.total,
          nativeUpdatedAt: isoOf(lastAtMs),
          lastSyncedAt: context.passStartIso,
          parentNativeSessionId: native.parent?.nativeSessionId ?? null,
          nativeTitle: existing.value.thread.title,
          nativeSourcePath: native.nativeSourcePath,
        });
        const adopted = yield* store.get(threadId);
        if (adopted !== null) context.rows.set(threadId, adopted);
        return "absorbed" as const;
      }

      if (context.nowMs - native.startedAtMs < MIN_SESSION_AGE_MS) return "deferred" as const;
      if (context.creationsLeft <= 0) return "deferred" as const;

      let parent: { threadId: ThreadId; relationship: "subagent" | "fork" } | null = null;
      if (native.parent !== null) {
        const parentKey = bindingKey(native.driver, native.parent.nativeSessionId);
        const parentThreadId = threadIdFor(
          native.providerInstanceId,
          native.parent.nativeSessionId,
        );
        let resolved: ThreadId | null =
          context.bindings.get(parentKey) ??
          (context.rows.has(parentThreadId) ? parentThreadId : null);
        if (resolved === null && depth < 4) {
          const parentSession = yield* lookupParent(native.parent.nativeSessionId);
          if (parentSession !== null) {
            const outcome = yield* syncSession(context, parentSession, lookupParent, depth + 1);
            if (outcome === "deferred") return "deferred" as const;
            if (context.rows.has(parentThreadId)) resolved = parentThreadId;
          }
        }
        if (resolved !== null) {
          parent = { threadId: resolved, relationship: native.parent.relationship };
        } else if (native.parent.relationship === "subagent") {
          // A delegate child of a session T3 does not show stays hidden too.
          return skip();
        }
      }

      const outcome = yield* createThread(context, native, threadId, parent);
      if (outcome === "skipped") return skip();
      context.creationsLeft -= 1;
      const created = yield* store.get(threadId);
      if (created !== null) context.rows.set(threadId, created);
      return outcome;
    }).pipe(
      Effect.mapError((cause) =>
        isPersonalSyncError(cause)
          ? cause
          : new PersonalSyncError({ message: "Could not sync a native session.", cause }),
      ),
    );

  // ---------------------------------------------------------------------------
  // Hermes
  // ---------------------------------------------------------------------------

  const hermesInstances = Effect.gen(function* () {
    const settings = yield* serverSettings.getSettings;
    const configured = Object.entries(settings.providerInstances).filter(
      ([, instance]) => instance.driver === HERMES_DRIVER,
    );
    const instances =
      configured.length === 0
        ? [{ instanceId: DEFAULT_HERMES_INSTANCE, home: hermesHomeFor({}) }]
        : configured
            // Reading history does not need the gateway, so only an explicit
            // "off" hides an instance; the provider itself defaults to off.
            .filter(
              ([, instance]) =>
                instance.enabled !== false &&
                providerInstanceConfigEnabledFlag(instance.config) !== false,
            )
            .map(([instanceId, instance]) => ({
              instanceId: ProviderInstanceId.make(instanceId),
              home: hermesHomeFor(asRecord(instance.config)),
            }));
    const seen = new Set<string>();
    return instances.filter((instance) => {
      const home = path.resolve(instance.home);
      if (seen.has(home)) return false;
      seen.add(home);
      return true;
    });
  });

  const readCronJobNames = (home: string) =>
    fileSystem.readFileString(path.join(home, "cron", "jobs.json")).pipe(
      Effect.map((text) => {
        const names = new Map<string, string>();
        let parsed: unknown;
        try {
          parsed = JSON.parse(text);
        } catch {
          return names;
        }
        const jobs = Array.isArray(parsed) ? parsed : asRecord(parsed).jobs;
        if (!Array.isArray(jobs)) return names;
        for (const job of jobs) {
          const id = nonEmpty(asRecord(job).id);
          const name = nonEmpty(asRecord(job).name);
          if (id !== null && name !== null) names.set(id, name);
        }
        return names;
      }),
      Effect.orElseSucceed(() => new Map<string, string>()),
    );

  const syncHermesInstance = Effect.fn("ExternalSessionSync.syncHermesInstance")(function* (
    context: PassContext,
    instance: { readonly instanceId: ProviderInstanceId; readonly home: string },
  ) {
    const stateDbPath = path.join(instance.home, "state.db");
    if (!(yield* fileSystem.exists(stateDbPath).pipe(Effect.orElseSucceed(() => false)))) {
      return { examined: 0, changed: 0, pending: false };
    }
    let reader = hermesReaders.get(stateDbPath);
    if (reader === undefined) {
      reader = yield* Effect.try({
        try: () => openHermesStateReader(stateDbPath),
        catch: (cause) =>
          new PersonalSyncError({ message: `Could not open ${stateDbPath} read-only.`, cause }),
      });
      hermesReaders.set(stateDbPath, reader);
    }
    const db = reader;
    const query = <A>(run: () => A) =>
      Effect.try({
        try: run,
        catch: (cause) =>
          new PersonalSyncError({ message: `Could not read ${stateDbPath}.`, cause }),
      });

    const cutoffSeconds = (context.nowMs - context.settings.backfillDays * 86_400_000) / 1000;
    const watermark = hermesWatermarks.get(stateDbPath);
    const sinceSeconds = Math.max(cutoffSeconds, watermark === undefined ? 0 : watermark - 60);
    const sessions = yield* query(() => db.listSessionsActiveSince(sinceSeconds));
    const jobNames = sessions.some((session) => session.source === "cron")
      ? yield* readCronJobNames(instance.home)
      : new Map<string, string>();

    const toMessages = (rows: ReturnType<HermesStateReader["messagesAfter"]>) =>
      rows.map((message): NativeMessage => ({
        key: `h${message.id}`,
        role: message.role,
        text: message.text,
        // Rounded up so the cursor excludes the message it came from.
        atMs: Math.ceil(message.timestamp * 1000),
      }));
    const toNative = (session: HermesSessionRow): NativeSession => {
      const delegateParent = session.delegateFrom ?? null;
      const branchParent = session.branchedFrom ?? null;
      const cronJob = CRON_SESSION_PATTERN.exec(session.id)?.[1];
      return {
        driver: HERMES_DRIVER,
        providerInstanceId: instance.instanceId,
        nativeSessionId: session.id,
        productName: "Hermes",
        title: session.title,
        model: session.model,
        cwd: session.cwd,
        origin: delegateParent !== null ? "subagent" : session.source,
        originDetail:
          session.source === "cron"
            ? cronJob === undefined
              ? null
              : (jobNames.get(cronJob) ?? cronJob)
            : (session.originChatName ?? session.originChatId),
        parent:
          delegateParent !== null
            ? { nativeSessionId: delegateParent, relationship: "subagent" }
            : branchParent !== null
              ? { nativeSessionId: branchParent, relationship: "fork" }
              : null,
        startedAtMs: session.startedAt * 1000,
        activityAtMs: session.activityAt * 1000,
        archived: session.archived,
        nativeSourcePath: null,
        resumeCursor: { sessionId: session.id },
        loadRecent: query(() => db.recentMessages(session.id, MAX_SYNCED_MESSAGES)).pipe(
          Effect.map((result) => ({ messages: toMessages(result.messages), total: result.total })),
          Effect.orDie,
        ),
        loadAfter: (cursorMs) =>
          query(() =>
            db.messagesAfter(session.id, cursorMs / 1000 - 0.001, MAX_SYNCED_MESSAGES),
          ).pipe(
            Effect.map((rows) => toMessages(rows).filter((message) => message.atMs > cursorMs)),
            Effect.orDie,
          ),
      };
    };
    const eligible = (session: HermesSessionRow) =>
      !session.hidden && !HERMES_EXCLUDED_SOURCES.has(session.source);
    const lookupParent = (nativeSessionId: string) =>
      query(() => db.getSession(nativeSessionId)).pipe(
        Effect.map((session) => (session !== null && eligible(session) ? toNative(session) : null)),
        Effect.orElseSucceed(() => null),
      );

    let changed = 0;
    let pending = false;
    for (const session of sessions) {
      const threadId = threadIdFor(instance.instanceId, session.id);
      const row = context.rows.get(threadId);
      if (
        row !== undefined &&
        session.activityAt * 1000 <= Date.parse(row.lastSyncedAt) &&
        (session.title === null || session.title.trim().slice(0, 200) === row.nativeTitle)
      ) {
        continue;
      }
      if (row === undefined && !eligible(session)) continue;
      const outcome = yield* syncSession(context, toNative(session), lookupParent).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Could not sync a Hermes session", {
            sessionId: session.id,
            cause,
          }).pipe(Effect.as("deferred" as const)),
        ),
      );
      if (outcome === "deferred") pending = true;
      if (outcome === "created" || outcome === "appended" || outcome === "absorbed") changed += 1;
    }
    // Deferred sessions keep the next pass looking at the whole window.
    if (pending) hermesWatermarks.delete(stateDbPath);
    else hermesWatermarks.set(stateDbPath, context.nowMs / 1000);
    return { examined: sessions.length, changed, pending };
  });

  const syncHermes = (context: PassContext) =>
    Effect.gen(function* () {
      let examined = 0;
      let changed = 0;
      for (const instance of yield* hermesInstances) {
        const result = yield* syncHermesInstance(context, instance).pipe(
          Effect.tapError(() =>
            Effect.sync(() => {
              const stateDbPath = path.join(instance.home, "state.db");
              hermesReaders.get(stateDbPath)?.close();
              hermesReaders.delete(stateDbPath);
            }),
          ),
        );
        examined += result.examined;
        changed += result.changed;
      }
      return { examined, changed };
    });

  // ---------------------------------------------------------------------------
  // Codex and Claude
  // ---------------------------------------------------------------------------

  const syncTranscripts = Effect.fn("ExternalSessionSync.syncTranscripts")(function* (
    context: PassContext,
    source: "codex" | "claude",
  ) {
    const scannerSource = source === "codex" ? "codex" : "claudeAgent";
    const driver = ProviderDriverKind.make(scannerSource);
    const transcripts = (yield* context.transcripts).filter(
      (transcript) => transcript.source === scannerSource,
    );
    const byFileSessionId = new Map<string, AgentSessionScanner.AgentSessionTranscript>();
    for (const transcript of transcripts) {
      const fileSessionId = TRANSCRIPT_SESSION_ID_PATTERN.exec(transcript.filePath)?.[1];
      if (fileSessionId !== undefined && !byFileSessionId.has(fileSessionId)) {
        byFileSessionId.set(fileSessionId, transcript);
      }
    }
    const cutoffMs = context.nowMs - context.settings.backfillDays * 86_400_000;

    const readNative = (
      transcript: AgentSessionScanner.AgentSessionTranscript,
    ): Effect.Effect<NativeSession | null> =>
      Effect.gen(function* () {
        const origin = yield* readTranscriptOrigin(transcript.filePath, scannerSource).pipe(
          Effect.provideService(FileSystem.FileSystem, fileSystem),
        );
        if (!origin.interactive) return null;
        const parsed = yield* scanner.readSessionTranscript(transcript);
        if (parsed === null) return null;
        const { thread, cwd } = parsed;
        if (source === "claude" && !CLAUDE_SESSION_ID_PATTERN.test(thread.providerSessionId)) {
          return null;
        }
        const messages = thread.messages.map((message): NativeMessage => ({
          key: `${Date.parse(message.createdAt)}-${shortHash(`${message.role}\u0000${message.text}`)}`,
          role: message.role,
          text: message.text,
          atMs: Date.parse(message.createdAt),
        }));
        return {
          driver,
          providerInstanceId: transcript.providerInstanceId,
          nativeSessionId: thread.providerSessionId,
          productName: source === "codex" ? "Codex" : "Claude Code",
          title: thread.title,
          model: thread.model,
          cwd,
          origin: "cli",
          originDetail: null,
          parent:
            origin.parentSessionId === null
              ? null
              : { nativeSessionId: origin.parentSessionId, relationship: "subagent" },
          startedAtMs: Date.parse(thread.createdAt),
          activityAtMs: transcript.mtimeMs,
          archived: false,
          nativeSourcePath: transcript.filePath,
          resumeCursor:
            source === "codex"
              ? { threadId: thread.providerSessionId }
              : {
                  threadId: threadIdFor(transcript.providerInstanceId, thread.providerSessionId),
                  resume: thread.providerSessionId,
                },
          loadRecent: Effect.succeed({ messages, total: messages.length }),
          loadAfter: (cursorMs) =>
            Effect.succeed(messages.filter((message) => message.atMs > cursorMs)),
        } satisfies NativeSession;
      });
    const lookupParent = (nativeSessionId: string) => {
      const transcript = byFileSessionId.get(nativeSessionId);
      return transcript === undefined ? Effect.succeed(null) : readNative(transcript);
    };

    let examined = 0;
    let changed = 0;
    for (const transcript of transcripts) {
      const fileSessionId = TRANSCRIPT_SESSION_ID_PATTERN.exec(transcript.filePath)?.[1] ?? null;
      const hintedRow =
        fileSessionId === null
          ? undefined
          : context.rows.get(threadIdFor(transcript.providerInstanceId, fileSessionId));
      if (hintedRow !== undefined) {
        if (transcript.mtimeMs <= Date.parse(hintedRow.lastSyncedAt)) continue;
        // A transcript is re-read whole; a large one being written to is read
        // at most every few minutes instead of on every poll.
        const lastReadAt = largeTranscriptReads.get(transcript.filePath) ?? 0;
        if (transcript.size > LARGE_TRANSCRIPT_BYTES) {
          if (context.nowMs - lastReadAt < LARGE_TRANSCRIPT_REREAD_MS) continue;
          largeTranscriptReads.set(transcript.filePath, context.nowMs);
        }
      } else {
        if (transcript.mtimeMs < cutoffMs) continue;
        const skipKey = `file\u0000${transcript.filePath}`;
        if (skippedAt.get(skipKey) === transcript.mtimeMs + transcript.size) continue;
        // Cheap rejection before reading: T3's own sessions are named by their id.
        if (fileSessionId !== null && context.bindings.has(bindingKey(driver, fileSessionId))) {
          skippedAt.set(skipKey, transcript.mtimeMs + transcript.size);
          continue;
        }
        examined += 1;
        const native = yield* readNative(transcript);
        if (native === null) {
          skippedAt.set(skipKey, transcript.mtimeMs + transcript.size);
          continue;
        }
        const outcome = yield* syncSession(context, native, lookupParent).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("Could not sync an agent transcript", {
              filePath: transcript.filePath,
              cause,
            }).pipe(Effect.as("deferred" as const)),
          ),
        );
        if (outcome === "skipped") skippedAt.set(skipKey, transcript.mtimeMs + transcript.size);
        if (outcome === "created" || outcome === "absorbed") changed += 1;
        continue;
      }
      examined += 1;
      const native = yield* readNative(transcript);
      if (native === null) continue;
      const outcome = yield* syncSession(context, native, lookupParent).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Could not sync an agent transcript", {
            filePath: transcript.filePath,
            cause,
          }).pipe(Effect.as("deferred" as const)),
        ),
      );
      if (outcome === "appended" || outcome === "absorbed") changed += 1;
    }
    return { examined, changed };
  });

  // ---------------------------------------------------------------------------
  // Scheduling and status
  // ---------------------------------------------------------------------------

  const toSyncError = (cause: unknown) =>
    isPersonalSyncError(cause)
      ? cause
      : new PersonalSyncError({ message: "The sync source failed.", cause });

  const sourceEnabled = (settings: PersonalSyncSettings, source: PersonalSyncSource) =>
    settings.enabled && settings[source];

  const runSource = (context: PassContext, source: PersonalSyncSource) =>
    (source === "hermes"
      ? syncHermes(context).pipe(Effect.mapError(toSyncError))
      : syncTranscripts(context, source).pipe(Effect.mapError(toSyncError))
    ).pipe(
      Effect.exit,
      Effect.flatMap((exit) =>
        Ref.update(sourceStates, (states) => {
          const previous = states.get(source) ?? initialSourceState;
          const baseMs = context.settings.pollSeconds * 1000;
          const next: SourceState =
            exit._tag === "Success"
              ? {
                  lastRunAt: context.passStartIso,
                  lastSuccessAt: context.passStartIso,
                  discoveredCount: exit.value.examined,
                  lastError: null,
                  errorStreak: 0,
                  idleStreak: exit.value.changed === 0 ? previous.idleStreak + 1 : 0,
                  // Idle sources slow down to at most three times the base interval.
                  nextRunAtMs:
                    context.nowMs +
                    baseMs *
                      Math.min(
                        3,
                        1 +
                          Math.floor((exit.value.changed === 0 ? previous.idleStreak + 1 : 0) / 3),
                      ),
                }
              : {
                  ...previous,
                  lastRunAt: context.passStartIso,
                  lastError:
                    Cause.prettyErrors(exit.cause)
                      .map((error) => error.message)
                      .join("; ") || "Sync failed.",
                  errorStreak: previous.errorStreak + 1,
                  // Failing sources back off exponentially, capped at ten minutes.
                  nextRunAtMs:
                    context.nowMs + Math.min(baseMs * 2 ** (previous.errorStreak + 1), 600_000),
                };
          return new Map(states).set(source, next);
        }),
      ),
    );

  const runPass = (force: boolean) =>
    Effect.gen(function* () {
      // The scheduler ticks every few seconds; decide before reading anything.
      const settings = (yield* personalSettings.get).sync;
      const nowMs = DateTime.toEpochMillis(yield* DateTime.now);
      const states = yield* Ref.get(sourceStates);
      const due = SOURCES.filter(
        (source) =>
          sourceEnabled(settings, source) &&
          (force || (states.get(source)?.nextRunAtMs ?? 0) <= nowMs),
      );
      if (due.length === 0) return;
      const context = yield* makePassContext;
      yield* Ref.set(running, true);
      yield* Effect.forEach(due, (source) => runSource(context, source), { discard: true }).pipe(
        Effect.ensuring(Ref.set(running, false)),
      );
    }).pipe(passLock.withPermits(1));

  const status: ExternalSessionSync["Service"]["status"] = Effect.gen(function* () {
    const settings = (yield* personalSettings.get).sync;
    const states = yield* Ref.get(sourceStates);
    const counts = new Map(
      (yield* sql<{ readonly driver: string; readonly total: number }>`
        SELECT driver, COUNT(*) AS total FROM personal_external_sessions GROUP BY driver
      `).map((row) => [row.driver, row.total] as const),
    );
    const sources = SOURCES.map((source): PersonalSyncSourceStatus => {
      const state = states.get(source) ?? initialSourceState;
      const driver = source === "claude" ? "claudeAgent" : source;
      return {
        source,
        enabled: sourceEnabled(settings, source),
        lastRunAt: state.lastRunAt,
        lastSuccessAt: state.lastSuccessAt,
        nextRunAt:
          sourceEnabled(settings, source) && state.nextRunAtMs > 0
            ? isoOf(state.nextRunAtMs)
            : null,
        discoveredCount: state.discoveredCount,
        syncedCount: counts.get(driver) ?? 0,
        lastError: state.lastError,
      };
    });
    return { enabled: settings.enabled, running: yield* Ref.get(running), sources };
  }).pipe(
    Effect.mapError(
      (cause) => new PersonalSyncError({ message: "Could not read the sync status.", cause }),
    ),
  );

  const runNow: ExternalSessionSync["Service"]["runNow"] = runPass(true).pipe(
    Effect.mapError((cause) => new PersonalSyncError({ message: "The sync pass failed.", cause })),
    Effect.andThen(status),
  );

  const stripRow = ({
    nativeTitle: _nativeTitle,
    nativeSourcePath: _nativeSourcePath,
    ...session
  }: ExternalSessionStore.ExternalSessionRow): PersonalExternalSession => session;

  const getExternalSession: ExternalSessionSync["Service"]["getExternalSession"] = (threadId) =>
    store.get(threadId).pipe(
      Effect.map((row) => (row === null ? null : stripRow(row))),
      Effect.mapError(
        (cause) => new PersonalSyncError({ message: "Could not read the synced session.", cause }),
      ),
    );

  const listExternalSessions: ExternalSessionSync["Service"]["listExternalSessions"] = store
    .list()
    .pipe(
      Effect.map((rows) => rows.map(stripRow)),
      Effect.mapError(
        (cause) => new PersonalSyncError({ message: "Could not list synced sessions.", cause }),
      ),
    );

  yield* scheduler.register("personal-external-session-sync", runPass(false));

  return ExternalSessionSync.of({ status, runNow, getExternalSession, listExternalSessions });
});

export const layer = Layer.effect(ExternalSessionSync, make);
