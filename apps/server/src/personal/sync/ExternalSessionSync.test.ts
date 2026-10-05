import * as NodeSqlite from "node:sqlite";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  EventId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  RunId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2DomainEvent,
  type PersonalSyncSettings,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as ServerConfig from "../../config.ts";
import * as EventSink from "../../orchestration-v2/EventSink.ts";
import * as IdAllocator from "../../orchestration-v2/IdAllocator.ts";
import * as ProjectionStore from "../../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../../orchestration-v2/ProjectStore.ts";
import {
  OrchestrationV2EventSinkLayerLive,
  ProjectServiceLayerLive,
} from "../../orchestration-v2/runtimeLayer.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import * as ProviderSessionRuntime from "../../persistence/ProviderSessionRuntime.ts";
import * as AgentSessionScanner from "../../project/AgentSessionScanner.ts";
import * as ManagedProjectFolders from "../../project/ManagedProjectFolders.ts";
import * as ProjectEnrichmentService from "../../project/ProjectEnrichmentService.ts";
import * as ProjectFaviconResolver from "../../project/ProjectFaviconResolver.ts";
import * as RepositoryIdentityResolver from "../../project/RepositoryIdentityResolver.ts";
import * as Scheduler from "../../scheduling/Scheduler.ts";
import * as ServerSettings from "../../serverSettings.ts";
import * as WorkspacePaths from "../../workspace/WorkspacePaths.ts";
import * as PersonalSettings from "../PersonalSettings.ts";
import * as ExternalSessionStore from "./ExternalSessionStore.ts";
import * as ExternalSessionSync from "./ExternalSessionSync.ts";

const hermes = ProviderInstanceId.make("hermes");
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const threadFor = (sessionId: string) => ThreadId.make(`import:hermes:${sessionId}`);

/** A Hermes home with a state.db holding only the columns the sync reads. */
const makeHermesFixture = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "personal-sync-" });
  const home = path.join(root, "hermes");
  const repo = path.join(root, "repo");
  const personal = path.join(root, "personal-git");
  for (const directory of [
    home,
    path.join(repo, ".git"),
    path.join(repo, "src"),
    path.join(personal, ".git"),
  ]) {
    yield* fileSystem.makeDirectory(directory, { recursive: true });
  }
  const db = new NodeSqlite.DatabaseSync(path.join(home, "state.db"));
  yield* Effect.addFinalizer(() => Effect.sync(() => db.close()));
  db.exec("PRAGMA journal_mode = WAL");
  db.exec(`
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY, source TEXT NOT NULL, parent_session_id TEXT, title TEXT, model TEXT,
      model_config TEXT, started_at REAL NOT NULL, last_activity_at REAL, archived INTEGER NOT NULL DEFAULT 0,
      hidden INTEGER NOT NULL DEFAULT 0, cwd TEXT, origin_json TEXT
    );
    CREATE TABLE messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, role TEXT NOT NULL, content TEXT,
      timestamp REAL NOT NULL, active INTEGER NOT NULL DEFAULT 1, compacted INTEGER NOT NULL DEFAULT 0,
      _compressed_summary INTEGER NOT NULL DEFAULT 0, display_kind TEXT, display_order INTEGER
    );
  `);
  const hourAgo = (yield* Clock.currentTimeMillis) / 1000 - 3600;
  const addSession = (input: {
    id: string;
    source: string;
    cwd?: string;
    title?: string;
    hidden?: boolean;
    modelConfig?: Record<string, unknown>;
    parent?: string;
    origin?: Record<string, unknown>;
  }) =>
    db
      .prepare(
        `INSERT INTO sessions (id, source, parent_session_id, title, model, model_config, started_at,
          last_activity_at, hidden, cwd, origin_json) VALUES (?, ?, ?, ?, 'claude-opus-5.5', ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.id,
        input.source,
        input.parent ?? null,
        input.title ?? null,
        JSON.stringify(input.modelConfig ?? {}),
        hourAgo,
        hourAgo,
        input.hidden ? 1 : 0,
        input.cwd ?? null,
        input.origin === undefined ? null : JSON.stringify(input.origin),
      );
  const addMessage = (
    sessionId: string,
    role: string,
    content: string,
    timestamp: number,
    extra: { active?: number; compacted?: number; summary?: number; kind?: string } = {},
  ) => {
    const result = db
      .prepare(
        `INSERT INTO messages (session_id, role, content, timestamp, active, compacted, _compressed_summary, display_kind)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        sessionId,
        role,
        content,
        timestamp,
        extra.active ?? 1,
        extra.compacted ?? 0,
        extra.summary ?? 0,
        extra.kind ?? null,
      );
    db.prepare("UPDATE messages SET display_order = id WHERE id = ?").run(result.lastInsertRowid);
    db.prepare("UPDATE sessions SET last_activity_at = ? WHERE id = ?").run(timestamp, sessionId);
  };
  return { home, repo, personal, hourAgo, addSession, addMessage };
});
type HermesFixture = Effect.Success<typeof makeHermesFixture>;

const withFixture = <A, E, R>(body: (fixture: HermesFixture) => Effect.Effect<A, E, R>) =>
  makeHermesFixture.pipe(Effect.flatMap(body), Effect.scoped, Effect.provide(NodeServices.layer));

const workspacePathsLayer = Layer.succeed(WorkspacePaths.WorkspacePaths, {
  normalizeWorkspaceRoot: (workspaceRoot) => Effect.succeed(workspaceRoot.replace(/\/$/, "")),
  resolveRelativePathWithinRoot: ({ workspaceRoot, relativePath }) =>
    Effect.succeed({ absolutePath: `${workspaceRoot}/${relativePath}`, relativePath }),
});

const metadataLayer = Layer.merge(
  Layer.succeed(RepositoryIdentityResolver.RepositoryIdentityResolver, {
    resolve: () => Effect.succeed(null),
  }),
  Layer.succeed(ProjectFaviconResolver.ProjectFaviconResolver, {
    resolvePath: () => Effect.succeed(null),
  }),
);

const noTranscripts = Layer.succeed(AgentSessionScanner.AgentSessionScanner, {
  scan: Effect.die("unused"),
  recentThreads: () => Effect.die("unused") as never,
  listSessionTranscripts: Effect.succeed([]),
  readSessionTranscript: () => Effect.succeed(null),
});

function makeTestLayer(
  fixture: HermesFixture,
  options: {
    readonly sync?: Partial<PersonalSyncSettings>;
    readonly scanner?: Layer.Layer<AgentSessionScanner.AgentSessionScanner>;
  } = {},
) {
  const settings: PersonalSyncSettings = {
    enabled: true,
    codex: false,
    claude: false,
    hermes: true,
    backfillDays: 45,
    pollSeconds: 20,
    homeProjectPath: fixture.personal,
    ...options.sync,
  };
  const dependencies = Layer.mergeAll(
    ExternalSessionStore.layer,
    Layer.succeed(PersonalSettings.PersonalSettings, {
      get: Effect.succeed({ sync: settings }),
      update: () => Effect.die("unused"),
    }),
    options.scanner ?? noTranscripts,
    Layer.mock(ServerSettings.ServerSettingsService)({
      getSettings: Effect.succeed({
        providerInstances: {
          [hermes]: {
            driver: ProviderDriverKind.make("hermes"),
            config: { hermesHome: fixture.home },
          },
        },
      } as never),
    }),
    Layer.succeed(Scheduler.Scheduler, { register: () => Effect.void }),
    Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
      ensureScratchProject: Effect.die("scratch is not used when a home project exists"),
      namedProjectsRoot: "/unused",
    }),
    ProjectServiceLayerLive,
    OrchestrationV2EventSinkLayerLive,
    ProjectionStore.layer,
    ProjectStore.layer,
    IdAllocator.layer,
    ProviderSessionRuntime.layer,
  ).pipe(
    Layer.provideMerge(ProjectEnrichmentService.layer),
    Layer.provideMerge(workspacePathsLayer),
    Layer.provideMerge(metadataLayer),
    Layer.provideMerge(SqlitePersistenceMemory),
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "personal-sync-test-" })),
    Layer.provideMerge(NodeServices.layer),
  );
  return ExternalSessionSync.layer.pipe(Layer.provideMerge(dependencies));
}

const messagesOf = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const records = yield* projections.getThreadRecords(threadId, ["messages", "turnItems"]);
    const ordered = records.turnItems.toSorted((left, right) => left.ordinal - right.ordinal);
    return {
      thread: records.thread,
      texts: ordered.flatMap((item) =>
        item.type === "user_message" || item.type === "assistant_message" ? [item.text] : [],
      ),
      items: ordered,
    };
  });

const threadExists = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    return (yield* Effect.exit(projections.getThreadRecords(threadId, [])))._tag === "Success";
  });

describe("ExternalSessionSync (Hermes)", () => {
  it.live("creates threads with lineage and projects, skipping hidden sources", () =>
    withFixture((fixture) => {
      const t = fixture.hourAgo;
      fixture.addSession({
        id: "desk",
        source: "desktop",
        title: "Plan the trip",
        cwd: `${fixture.repo}/src`,
      });
      fixture.addMessage("desk", "user", "Old question", t + 1, { active: 0, compacted: 1 });
      fixture.addMessage("desk", "assistant", "Old answer", t + 2, { active: 0, compacted: 1 });
      fixture.addMessage("desk", "assistant", "Summary of earlier turns", t + 3, { summary: 1 });
      fixture.addMessage("desk", "user", "Plan the trip", t + 4);
      fixture.addMessage("desk", "tool", '{"ok":true}', t + 5);
      fixture.addMessage("desk", "assistant", "internal", t + 6, { kind: "internal_notification" });
      fixture.addMessage("desk", "assistant", "Here is the plan", t + 7);
      fixture.addSession({
        id: "child",
        source: "subagent",
        title: "Subagent: research",
        parent: "desk",
        modelConfig: { _delegate_from: "desk" },
      });
      fixture.addMessage("child", "user", "Research flights", t + 8);
      fixture.addMessage("child", "assistant", "Found three", t + 9);
      fixture.addSession({
        id: "branch",
        source: "desktop",
        title: "Plan the trip (branch)",
        modelConfig: { _branched_from: "desk" },
      });
      fixture.addMessage("branch", "user", "What about trains?", t + 10);
      fixture.addSession({
        id: "slack",
        source: "slack",
        title: "Check ClassPass",
        origin: { platform: "slack", chat_name: "personal-git", chat_id: "C1" },
      });
      fixture.addMessage("slack", "user", "Check ClassPass", t + 11);
      fixture.addSession({ id: "once", source: "oneshot", title: "One shot" });
      fixture.addMessage("once", "user", "hello", t + 12);
      fixture.addSession({ id: "secret", source: "desktop", title: "Hidden", hidden: true });
      fixture.addMessage("secret", "user", "hidden", t + 13);

      return Effect.gen(function* () {
        const sync = yield* ExternalSessionSync.ExternalSessionSync;
        const projectStore = yield* ProjectStore.ProjectStoreV2;
        const status = yield* sync.runNow;
        assert.strictEqual(
          status.sources.find((source) => source.source === "hermes")?.syncedCount,
          4,
        );

        const projects = yield* projectStore.listShells();
        const projectAt = (root: string) =>
          projects.find((project) => project.workspaceRoot === root)?.id;
        const repoProject = projectAt(fixture.repo);
        const personalProject = projectAt(fixture.personal);
        assert.isDefined(repoProject);
        assert.isDefined(personalProject);

        const desk = yield* messagesOf(threadFor("desk"));
        assert.deepStrictEqual(desk.texts, [
          "Old question",
          "Old answer",
          "Plan the trip",
          "Here is the plan",
        ]);
        assert.strictEqual(desk.thread.projectId, repoProject);
        assert.strictEqual(desk.thread.title, "Plan the trip");

        const child = yield* messagesOf(threadFor("child"));
        assert.deepStrictEqual(child.thread.lineage, {
          parentThreadId: threadFor("desk"),
          relationshipToParent: "subagent",
          rootThreadId: threadFor("desk"),
        });
        assert.strictEqual(child.thread.projectId, repoProject);

        const branch = yield* messagesOf(threadFor("branch"));
        assert.strictEqual(branch.thread.lineage.relationshipToParent, "fork");
        assert.strictEqual(branch.thread.lineage.parentThreadId, threadFor("desk"));

        const slack = yield* messagesOf(threadFor("slack"));
        assert.strictEqual(slack.thread.projectId, personalProject);
        const slackRow = yield* sync.getExternalSession(threadFor("slack"));
        assert.strictEqual(slackRow?.origin, "slack");
        assert.strictEqual(slackRow?.originDetail, "personal-git");
        assert.strictEqual(
          (yield* sync.getExternalSession(threadFor("child")))?.origin,
          "subagent",
        );

        assert.isFalse(yield* threadExists(threadFor("once")));
        assert.isFalse(yield* threadExists(threadFor("secret")));
      }).pipe(Effect.provide(makeTestLayer(fixture)));
    }),
  );

  it.live("appends only new native messages when no T3 run happened", () =>
    withFixture((fixture) => {
      const t = fixture.hourAgo;
      fixture.addSession({ id: "desk", source: "desktop", title: "Grow me" });
      fixture.addMessage("desk", "user", "First", t + 1);
      fixture.addMessage("desk", "assistant", "Reply", t + 2);

      return Effect.gen(function* () {
        const sync = yield* ExternalSessionSync.ExternalSessionSync;
        yield* sync.runNow;
        const before = yield* messagesOf(threadFor("desk"));

        // Native activity after the last pass is what marks the session changed.
        const later = (yield* Clock.currentTimeMillis) / 1000 + 1;
        fixture.addMessage("desk", "user", "Continued in Hermes", later);
        fixture.addMessage("desk", "assistant", "Sure", later + 1);
        yield* sync.runNow;
        // A second pass with no native change must not duplicate anything.
        yield* sync.runNow;

        const after = yield* messagesOf(threadFor("desk"));
        assert.deepStrictEqual(after.texts, ["First", "Reply", "Continued in Hermes", "Sure"]);
        assert.isTrue(
          DateTime.toEpochMillis(after.thread.updatedAt) >
            DateTime.toEpochMillis(before.thread.updatedAt),
        );
        const row = yield* sync.getExternalSession(threadFor("desk"));
        assert.strictEqual(
          row?.nativeUpdatedAt,
          DateTime.formatIso(DateTime.makeUnsafe(Math.ceil((later + 1) * 1000))),
        );
      }).pipe(Effect.provide(makeTestLayer(fixture)));
    }),
  );

  it.live("absorbs native messages written by a T3 run and appends later ones after it", () =>
    withFixture((fixture) => {
      const t = fixture.hourAgo;
      fixture.addSession({ id: "desk", source: "desktop", title: "Echo" });
      fixture.addMessage("desk", "user", "First", t + 1);
      fixture.addMessage("desk", "assistant", "Reply", t + 2);
      const threadId = threadFor("desk");

      return Effect.gen(function* () {
        const sync = yield* ExternalSessionSync.ExternalSessionSync;
        const eventSink = yield* EventSink.EventSinkV2;
        yield* sync.runNow;

        // T3 ran a turn on the thread; Hermes recorded the same exchange.
        const runId = RunId.make("run:echo");
        const runAt = (yield* Clock.currentTimeMillis) / 1000 + 1;
        const requestedAt = DateTime.makeUnsafe(runAt * 1000);
        const completedAt = DateTime.makeUnsafe((runAt + 10) * 1000);
        const t3MessageId = MessageId.make("message:echo");
        const runEvents: ReadonlyArray<OrchestrationV2DomainEvent> = [
          {
            id: EventId.make("echo:run"),
            type: "run.created",
            threadId,
            occurredAt: requestedAt,
            payload: {
              id: runId,
              threadId,
              ordinal: 1,
              providerInstanceId: hermes,
              modelSelection: { instanceId: hermes, model: "default" },
              providerThreadId: null as ProviderThreadId | null,
              userMessageId: t3MessageId,
              rootNodeId: null,
              activeAttemptId: null,
              status: "completed",
              requestedAt,
              startedAt: requestedAt,
              completedAt,
              checkpointId: null,
              contextHandoffId: null,
            },
          },
          {
            id: EventId.make("echo:turn-item"),
            type: "turn-item.updated",
            threadId,
            occurredAt: requestedAt,
            payload: {
              id: TurnItemId.make("turn-item:echo"),
              threadId,
              runId,
              nodeId: null,
              providerThreadId: null,
              providerTurnId: null,
              nativeItemRef: null,
              parentItemId: null,
              ordinal: 0,
              status: "completed",
              title: null,
              startedAt: requestedAt,
              completedAt: requestedAt,
              updatedAt: requestedAt,
              createdBy: "user",
              creationSource: "web",
              type: "user_message",
              messageId: t3MessageId,
              inputIntent: "turn_start",
              text: "Asked from T3",
              attachments: [],
            },
          },
        ];
        yield* eventSink.write({ events: runEvents });
        fixture.addMessage("desk", "user", "Asked from T3", runAt + 0.5);
        fixture.addMessage("desk", "assistant", "Answered in T3", runAt + 8);

        yield* sync.runNow;
        const absorbed = yield* messagesOf(threadId);
        assert.deepStrictEqual(absorbed.texts, ["First", "Reply", "Asked from T3"]);
        const row = yield* sync.getExternalSession(threadId);
        assert.strictEqual(
          row?.nativeUpdatedAt,
          DateTime.formatIso(DateTime.makeUnsafe(Math.ceil((runAt + 8) * 1000))),
        );

        // Continued outside T3 afterwards: appended, and placed after the T3 run.
        fixture.addMessage("desk", "user", "Back in Hermes", runAt + 300);
        yield* sync.runNow;
        const after = yield* messagesOf(threadId);
        assert.deepStrictEqual(after.texts, ["First", "Reply", "Asked from T3", "Back in Hermes"]);
        const t3Item = after.items.find((item) => item.runId === runId);
        const appended = after.items.find(
          (item) => item.type === "user_message" && item.text === "Back in Hermes",
        );
        assert.isTrue((appended?.ordinal ?? 0) > (t3Item?.ordinal ?? Infinity));
      }).pipe(Effect.provide(makeTestLayer(fixture)));
    }),
  );

  it.live("never imports a native session bound to an existing T3 thread", () =>
    withFixture((fixture) => {
      const t = fixture.hourAgo;
      fixture.addSession({ id: "started-by-t3", source: "tui", title: "From T3" });
      fixture.addMessage("started-by-t3", "user", "Hello from T3", t + 1);
      fixture.addSession({ id: "external", source: "cli", title: "From the CLI" });
      fixture.addMessage("external", "user", "Hello from the CLI", t + 2);
      const ownThread = ThreadId.make("thread:t3-own");
      const driver = ProviderDriverKind.make("hermes");

      return Effect.gen(function* () {
        const eventSink = yield* EventSink.EventSinkV2;
        const now = DateTime.makeUnsafe(t * 1000);
        yield* eventSink.write({
          events: [
            {
              id: EventId.make("own:thread"),
              type: "thread.created",
              threadId: ownThread,
              occurredAt: now,
              payload: {
                id: ownThread,
                projectId: ProjectId.make("project:own"),
                title: "From T3",
                providerInstanceId: hermes,
                modelSelection: { instanceId: hermes, model: "default" },
                createdBy: "user",
                creationSource: "web",
                runtimeMode: "full-access",
                interactionMode: "default",
                branch: null,
                worktreePath: null,
                activeProviderThreadId: ProviderThreadId.make("provider-thread:own"),
                lineage: {
                  parentThreadId: null,
                  relationshipToParent: null,
                  rootThreadId: ownThread,
                },
                forkedFrom: null,
                createdAt: now,
                updatedAt: now,
                archivedAt: null,
                settledOverride: null,
                settledAt: null,
                lastVisitedAt: null,
                deletedAt: null,
              },
            },
            {
              id: EventId.make("own:provider-thread"),
              type: "provider-thread.updated",
              threadId: ownThread,
              occurredAt: now,
              payload: {
                id: ProviderThreadId.make("provider-thread:own"),
                driver,
                providerInstanceId: hermes,
                providerSessionId: null,
                appThreadId: ownThread,
                ownerNodeId: null,
                nativeThreadRef: { driver, nativeId: "started-by-t3", strength: "strong" },
                nativeConversationHeadRef: null,
                status: "idle",
                firstRunOrdinal: null,
                lastRunOrdinal: null,
                handoffIds: [],
                forkedFrom: null,
                createdAt: now,
                updatedAt: now,
              },
            },
          ],
        });

        const sync = yield* ExternalSessionSync.ExternalSessionSync;
        yield* sync.runNow;
        yield* sync.runNow;

        assert.isFalse(yield* threadExists(threadFor("started-by-t3")));
        assert.isTrue(yield* threadExists(threadFor("external")));
        assert.deepStrictEqual(
          (yield* sync.listExternalSessions).map((row) => row.nativeSessionId),
          ["external"],
        );
      }).pipe(Effect.provide(makeTestLayer(fixture)));
    }),
  );
});

/** Scanner over fixed transcript files, parsed with the real transcript parser. */
const transcriptScanner = (files: ReadonlyArray<string>) =>
  Layer.effect(
    AgentSessionScanner.AgentSessionScanner,
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const codex = ProviderInstanceId.make("codex");
      return AgentSessionScanner.AgentSessionScanner.of({
        scan: Effect.die("unused"),
        recentThreads: () => Effect.die("unused") as never,
        listSessionTranscripts: Effect.forEach(files, (filePath) =>
          fileSystem.stat(filePath).pipe(
            Effect.map((info) => ({
              source: "codex" as const,
              providerInstanceId: codex,
              filePath,
              mtimeMs: Option.getOrElse(
                Option.map(info.mtime, (date) => date.getTime()),
                () => 0,
              ),
              size: Number(info.size),
            })),
          ),
        ).pipe(Effect.orDie),
        readSessionTranscript: (transcript) =>
          fileSystem.readFileString(transcript.filePath).pipe(
            Effect.map((contents) => {
              const thread = AgentSessionScanner.parseAgentSessionTranscript({
                source: "codex",
                providerInstanceId: transcript.providerInstanceId,
                fallbackSessionId: "unused",
                lastActiveAtMs: transcript.mtimeMs,
                contents,
              });
              const cwd = /"cwd":"([^"]+)"/.exec(contents)?.[1];
              return thread === null || cwd === undefined ? null : { thread, cwd };
            }),
            Effect.orDie,
          ),
      });
    }),
  ).pipe(Layer.provide(NodeServices.layer));

describe("ExternalSessionSync (Codex transcripts)", () => {
  it.live(
    "imports interactive Codex sessions, skips T3's own, and appends when the file grows",
    () =>
      withFixture((fixture) =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const nowMs = yield* Clock.currentTimeMillis;
          const iso = (ms: number) => DateTime.formatIso(DateTime.makeUnsafe(ms));
          const record = (value: unknown) => `${encodeJson(value)}\n`;
          const sessionFile = (id: string) =>
            `${fixture.home}/rollout-2026-10-05T00-00-00-${id}.jsonl`;
          const meta = (id: string, originator: string) =>
            record({
              type: "session_meta",
              timestamp: iso(nowMs - 3_600_000),
              payload: { id, cwd: fixture.repo, originator, source: "cli" },
            });
          const user = (text: string, ms: number) =>
            record({
              type: "event_msg",
              timestamp: iso(ms),
              payload: { type: "user_message", message: text },
            });
          const assistant = (text: string, ms: number) =>
            record({
              type: "response_item",
              timestamp: iso(ms),
              payload: {
                type: "message",
                role: "assistant",
                content: [{ type: "output_text", text }],
              },
            });
          const external = "0199aaaa-1111-7222-8333-444455556666";
          const own = "0199bbbb-1111-7222-8333-444455556666";
          yield* fileSystem.writeFileString(
            sessionFile(external),
            meta(external, "codex_cli_rs") +
              user("Fix the parser", nowMs - 3_500_000) +
              assistant("Fixed it", nowMs - 3_400_000),
          );
          yield* fileSystem.writeFileString(
            sessionFile(own),
            meta(own, "T3 Code") + user("Started from T3", nowMs - 3_500_000),
          );
          const layer = makeTestLayer(fixture, {
            sync: { codex: true, hermes: false },
            scanner: transcriptScanner([sessionFile(external), sessionFile(own)]),
          });

          yield* Effect.gen(function* () {
            const sync = yield* ExternalSessionSync.ExternalSessionSync;
            yield* sync.runNow;
            const threadId = ThreadId.make(`import:codex:${external}`);
            const imported = yield* messagesOf(threadId);
            assert.deepStrictEqual(imported.texts, ["Fix the parser", "Fixed it"]);
            assert.isFalse(yield* threadExists(ThreadId.make(`import:codex:${own}`)));
            const runtimes = yield* ProviderSessionRuntime.ProviderSessionRuntimeRepository;
            const runtime = yield* runtimes.getByThreadId({ threadId });
            assert.deepStrictEqual(Option.getOrNull(runtime)?.resumeCursor, { threadId: external });

            const later = (yield* Clock.currentTimeMillis) + 1_000;
            yield* fileSystem.writeFileString(
              sessionFile(external),
              user("One more thing", later) + assistant("Done", later + 1),
              { flag: "a" },
            );
            yield* sync.runNow;
            assert.deepStrictEqual((yield* messagesOf(threadId)).texts, [
              "Fix the parser",
              "Fixed it",
              "One more thing",
              "Done",
            ]);
          }).pipe(Effect.provide(layer));
        }),
      ),
  );
});
