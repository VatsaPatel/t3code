import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  MessageId,
  NodeId,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  RunAttemptId,
  RunId,
  ThreadId,
  type ModelSelection,
  type OrchestrationV2AppThread,
  type OrchestrationV2ProviderThread,
  type RuntimeMode,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/unstable/process";

import * as ServerConfig from "../../config.ts";
import { makeHermesGateway, resolveHermesLaunch } from "../../provider/hermes/HermesGateway.ts";
import * as IdAllocator from "../IdAllocator.ts";
import {
  ProviderAdapterV2RuntimePolicy,
  type ProviderAdapterV2Event,
  type ProviderAdapterV2SessionRuntime,
} from "../ProviderAdapter.ts";
import {
  HERMES_PROVIDER,
  HERMES_SESSION_NOT_OWNED_MESSAGE,
  makeHermesAdapterV2,
} from "./HermesAdapterV2.ts";
import { startFakeHermesGateway, type FakeHermesGateway } from "./HermesAdapterV2.testkit.ts";

const serverConfigLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3-hermes-v2-adapter-",
}).pipe(Layer.provide(NodeServices.layer));
const testLayer = Layer.mergeAll(NodeServices.layer, IdAllocator.layer, serverConfigLayer);

const INSTANCE_ID = ProviderInstanceId.make("hermes");
const THREAD_ID = ThreadId.make("thread-hermes-test");
const SESSION_ID = ProviderSessionId.make("provider-session-hermes-test");
const TEMP_ROOT = process.env.TMPDIR ?? process.cwd();

const modelSelection: ModelSelection = { instanceId: INSTANCE_ID, model: "default" };
const policy = (runtimeMode: RuntimeMode = "full-access") =>
  ProviderAdapterV2RuntimePolicy.make({ runtimeMode, interactionMode: "default", cwd: null });

/** Default gateway: sessions open, prompts stream "Hello world" and complete. */
function scriptDefaults(fake: FakeHermesGateway) {
  let runtime = 0;
  const nextRuntime = () => `rt-${++runtime}`;
  fake.on("client.capabilities", (_request, peer) => peer.result({ server_requests: [] }));
  fake.on("session.create", (_request, peer) =>
    peer.result({ session_id: nextRuntime(), stored_session_id: "stored-new-1", info: {} }),
  );
  fake.on("session.resume", (request, peer) => {
    const storedId = String(request.params.session_id);
    peer.result({ session_id: nextRuntime(), session_key: storedId, resumed: storedId, info: {} });
  });
  fake.on("session.close", (_request, peer) => peer.result({ closed: true }));
  fake.on("config.set", (request, peer) =>
    peer.result({ key: request.params.key, value: request.params.value }),
  );
  fake.on("prompt.submit", (request, peer) => {
    const sessionId = String(request.params.session_id);
    peer.result({ status: "streaming" });
    peer.event("message.start", sessionId);
    peer.event("message.delta", sessionId, { text: "Hello " });
    peer.event("message.delta", sessionId, { text: "world" });
    peer.event("message.complete", sessionId, {
      text: "Hello world",
      status: "complete",
      usage: { context_used: 1_000, context_max: 200_000, input: 900, output: 100 },
    });
  });
}

const makeAppThread = Effect.fnUntraced(function* (threadId: ThreadId) {
  const now = yield* DateTime.now;
  return {
    createdBy: "user",
    creationSource: "web",
    id: threadId,
    projectId: "project:fixture:hermes" as OrchestrationV2AppThread["projectId"],
    title: "Hermes test thread",
    providerInstanceId: INSTANCE_ID,
    modelSelection,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    activeProviderThreadId: null,
    lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
    forkedFrom: null,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
    deletedAt: null,
  } satisfies OrchestrationV2AppThread;
});

const withFakeGateway = <A, E, R>(
  body: (fake: FakeHermesGateway) => Effect.Effect<A, E, R>,
): Effect.Effect<A, E, Exclude<R, import("effect/Scope").Scope>> =>
  Effect.acquireUseRelease(
    Effect.promise(() => startFakeHermesGateway(TEMP_ROOT)),
    (fake) => Effect.scoped(body(fake)),
    (fake) => Effect.promise(() => fake.close()),
  );

const openRuntime = Effect.fnUntraced(function* (
  fake: FakeHermesGateway,
  runtimeMode: RuntimeMode = "full-access",
  threadId: ThreadId = THREAD_ID,
) {
  scriptDefaults(fake);
  const path = yield* Path.Path;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const gateway = yield* makeHermesGateway({
    launch: resolveHermesLaunch(
      path,
      { hermesHome: fake.hermesHome, profile: "", pythonPath: fake.relayPath },
      { ...process.env, HERMES_FAKE_SOCKET: fake.socketPath },
    ),
    spawner,
  });
  const adapter = makeHermesAdapterV2({
    instanceId: INSTANCE_ID,
    gateway,
    idAllocator: yield* IdAllocator.IdAllocatorV2,
    serverConfig: yield* ServerConfig.ServerConfig,
    leaseReleaseDelay: 0,
  });
  const runtime = yield* adapter.openSession({
    threadId,
    providerSessionId: SESSION_ID,
    modelSelection,
    runtimePolicy: policy(runtimeMode),
  });
  const emitted = yield* Queue.unbounded<ProviderAdapterV2Event>();
  yield* runtime.events.pipe(
    Stream.runForEach((event) => Queue.offer(emitted, event)),
    Effect.forkScoped,
  );
  const takeEvent = <T extends ProviderAdapterV2Event>(
    predicate: (event: ProviderAdapterV2Event) => event is T,
  ) =>
    Effect.gen(function* () {
      while (true) {
        const event = yield* Queue.take(emitted);
        if (predicate(event)) return event;
      }
    });
  return { runtime, takeEvent };
});

const startTurn = Effect.fnUntraced(function* (
  runtime: ProviderAdapterV2SessionRuntime,
  providerThread: OrchestrationV2ProviderThread,
  input: {
    readonly text?: string;
    readonly runOrdinal?: number;
    readonly runtimeMode?: RuntimeMode;
    readonly threadId?: ThreadId;
  } = {},
) {
  const threadId = input.threadId ?? THREAD_ID;
  const runOrdinal = input.runOrdinal ?? 1;
  const runId = RunId.make(`run:${threadId}:${runOrdinal}`);
  yield* runtime.startTurn({
    appThread: yield* makeAppThread(threadId),
    threadId,
    runId,
    runOrdinal,
    providerTurnOrdinal: runOrdinal,
    attemptId: RunAttemptId.make(`run-attempt:${runId}:1`),
    rootNodeId: NodeId.make(`node:${runId}:root`),
    providerThread,
    message: {
      messageId: MessageId.make(`message:${threadId}:${runOrdinal}`),
      text: input.text ?? "Hi Hermes",
      attachments: [],
      createdBy: "user",
      creationSource: "web",
    },
    modelSelection,
    runtimePolicy: policy(input.runtimeMode),
  });
});

const isTerminal = (
  event: ProviderAdapterV2Event,
): event is Extract<ProviderAdapterV2Event, { type: "turn.terminal" }> =>
  event.type === "turn.terminal";

const importedThread = Effect.fnUntraced(function* (storedId: string) {
  const now = yield* DateTime.now;
  return {
    id: ProviderThreadId.make(`provider-thread:import:${storedId}`),
    driver: HERMES_PROVIDER,
    providerInstanceId: INSTANCE_ID,
    providerSessionId: null,
    appThreadId: THREAD_ID,
    ownerNodeId: null,
    nativeThreadRef: { driver: HERMES_PROVIDER, nativeId: storedId, strength: "strong" },
    nativeConversationHeadRef: null,
    status: "idle",
    firstRunOrdinal: null,
    lastRunOrdinal: null,
    handoffIds: [],
    forkedFrom: null,
    pendingBackgroundTasks: [],
    contextUsage: null,
    nativeMetadata: null,
    createdAt: now,
    updatedAt: now,
  } satisfies OrchestrationV2ProviderThread;
});

describe("HermesAdapterV2", () => {
  it.live("records the stored session id as a strong native ref and streams the reply", () =>
    withFakeGateway((fake) =>
      Effect.gen(function* () {
        const { runtime, takeEvent } = yield* openRuntime(fake);
        const providerThread = yield* runtime.ensureThread({
          threadId: THREAD_ID,
          modelSelection,
          runtimePolicy: policy(),
        });
        assert.deepEqual(providerThread.nativeThreadRef, {
          driver: HERMES_PROVIDER,
          nativeId: "stored-new-1",
          strength: "strong",
        });
        const published = yield* takeEvent(
          (event): event is Extract<ProviderAdapterV2Event, { type: "provider_thread.updated" }> =>
            event.type === "provider_thread.updated",
        );
        assert.equal(published.providerThread.nativeThreadRef?.nativeId, "stored-new-1");

        yield* startTurn(runtime, providerThread);
        const finalMessage = yield* takeEvent(
          (event): event is Extract<ProviderAdapterV2Event, { type: "message.updated" }> =>
            event.type === "message.updated" && !event.message.streaming,
        );
        assert.equal(finalMessage.message.text, "Hello world");
        const terminal = yield* takeEvent(isTerminal);
        assert.equal(terminal.status, "completed");

        const submit = yield* Effect.promise(() => fake.nextRequest("prompt.submit"));
        assert.deepEqual(submit.params, { session_id: "rt-1", text: "Hi Hermes", queued: true });
        // Full access maps to Hermes' session-scoped yolo, never a config.yaml key.
        const configSet = yield* Effect.promise(() => fake.nextRequest("config.set"));
        assert.deepEqual(configSet.params, { session_id: "rt-1", key: "yolo", value: "on" });
      }),
    ).pipe(Effect.provide(testLayer)),
  );

  it.live("resumes an imported session by stored id and adopts a rotated tip id", () =>
    withFakeGateway((fake) =>
      Effect.gen(function* () {
        const { runtime } = yield* openRuntime(fake);
        fake.on("session.resume", (_request, peer) =>
          peer.result({
            session_id: "rt-resumed",
            session_key: "imported-1-tip",
            resumed: "imported-1-tip",
            info: {},
          }),
        );
        const resumed = yield* runtime.resumeThread({
          providerThread: yield* importedThread("imported-1"),
          threadId: THREAD_ID,
          modelSelection,
          runtimePolicy: policy(),
        });
        const resume = yield* Effect.promise(() => fake.nextRequest("session.resume"));
        assert.deepEqual(resume.params, { session_id: "imported-1", omit_messages: true });
        assert.equal(resumed.nativeThreadRef?.nativeId, "imported-1-tip");
        assert.equal(resumed.id, ProviderThreadId.make("provider-thread:import:imported-1"));
      }),
    ).pipe(Effect.provide(testLayer)),
  );

  it.live("round-trips an approval with the native choice", () =>
    withFakeGateway((fake) =>
      Effect.gen(function* () {
        const { runtime, takeEvent } = yield* openRuntime(fake, "approval-required");
        const providerThread = yield* runtime.ensureThread({
          threadId: THREAD_ID,
          modelSelection,
          runtimePolicy: policy("approval-required"),
        });
        fake.on("prompt.submit", (request, peer) => {
          const sessionId = String(request.params.session_id);
          peer.result({ status: "streaming" });
          peer.event("message.start", sessionId);
          void peer
            .serverRequest("approval", {
              session_id: sessionId,
              request_id: "approval-1",
              command: "rm -rf build",
              description: "recursive delete",
              choices: ["once", "session", "always", "deny"],
            })
            .then((reply) => {
              peer.event("message.complete", sessionId, {
                text: `choice:${String(reply.result?.choice)}`,
                status: "complete",
              });
            });
        });
        yield* startTurn(runtime, providerThread, { runtimeMode: "approval-required" });
        const requestItem = yield* takeEvent(
          (event): event is Extract<ProviderAdapterV2Event, { type: "turn_item.updated" }> =>
            event.type === "turn_item.updated" && event.turnItem.type === "approval_request",
        );
        assert.equal(requestItem.turnItem.type, "approval_request");
        if (requestItem.turnItem.type !== "approval_request") return;
        assert.deepEqual(
          requestItem.turnItem.options?.map((option) => option.decision),
          ["accept", "acceptForSession", "acceptAlways", "decline"],
        );
        yield* runtime.respondToRuntimeRequest({
          requestId: requestItem.turnItem.requestId,
          decision: "acceptForSession",
        });
        const finalMessage = yield* takeEvent(
          (event): event is Extract<ProviderAdapterV2Event, { type: "message.updated" }> =>
            event.type === "message.updated" && !event.message.streaming,
        );
        assert.equal(finalMessage.message.text, "choice:session");
        assert.equal((yield* takeEvent(isTerminal)).status, "completed");
      }),
    ).pipe(Effect.provide(testLayer)),
  );

  it.live("fails the turn reusably when another Hermes client owns the session", () =>
    withFakeGateway((fake) =>
      Effect.gen(function* () {
        const { runtime, takeEvent } = yield* openRuntime(fake);
        const providerThread = yield* runtime.resumeThread({
          providerThread: yield* importedThread("slack-session"),
          threadId: THREAD_ID,
          modelSelection,
          runtimePolicy: policy(),
        });
        fake.on("prompt.submit", (_request, peer) =>
          peer.error(4090, "This chat is open in another Hermes window/terminal.", {
            reason: "SESSION_NOT_OWNED",
          }),
        );
        yield* startTurn(runtime, providerThread);
        const terminal = yield* takeEvent(isTerminal);
        assert.equal(terminal.status, "failed");
        assert.equal(terminal.threadDisposition, "reusable");
        assert.equal(terminal.failure?.message, HERMES_SESSION_NOT_OWNED_MESSAGE);
      }),
    ).pipe(Effect.provide(testLayer)),
  );

  it.live("forks a stored conversation natively into a distinct session", () =>
    withFakeGateway((fake) =>
      Effect.gen(function* () {
        const target = ThreadId.make("thread-hermes-fork");
        const { runtime, takeEvent } = yield* openRuntime(fake, "full-access", target);
        fake.on("session.branch_stored", (request, peer) =>
          peer.result({
            session_id: "rt-branch",
            stored_session_id: `branch-of-${String(request.params.parent_session_id)}`,
            message_count: 4,
            messages_omitted: true,
            info: {},
          }),
        );
        const source = yield* importedThread("parent-1");
        const forked = yield* runtime.forkThread({
          sourceProviderThread: source,
          targetThreadId: target,
          modelSelection,
          runtimePolicy: policy(),
        });
        const branch = yield* Effect.promise(() => fake.nextRequest("session.branch_stored"));
        assert.equal(branch.params.parent_session_id, "parent-1");
        assert.equal(forked.nativeThreadRef?.nativeId, "branch-of-parent-1");
        assert.notEqual(forked.id, source.id);
        assert.equal(forked.appThreadId, target);
        assert.deepEqual(forked.forkedFrom, { providerThreadId: source.id });

        // The child takes its own turns on its own runtime session.
        yield* startTurn(runtime, forked, { threadId: target });
        assert.equal((yield* takeEvent(isTerminal)).status, "completed");
        const submit = yield* Effect.promise(() => fake.nextRequest("prompt.submit"));
        assert.equal(submit.params.session_id, "rt-branch");
      }),
    ).pipe(Effect.provide(testLayer)),
  );

  it.live("releases the Hermes lease after a turn settles and resumes on the next turn", () =>
    withFakeGateway((fake) =>
      Effect.gen(function* () {
        const { runtime, takeEvent } = yield* openRuntime(fake);
        const providerThread = yield* runtime.ensureThread({
          threadId: THREAD_ID,
          modelSelection,
          runtimePolicy: policy(),
        });
        yield* startTurn(runtime, providerThread);
        assert.equal((yield* takeEvent(isTerminal)).status, "completed");
        const close = yield* Effect.promise(() => fake.nextRequest("session.close"));
        assert.deepEqual(close.params, { session_id: "rt-1" });

        yield* startTurn(runtime, providerThread, { runOrdinal: 2 });
        assert.equal((yield* takeEvent(isTerminal)).status, "completed");
        const resume = yield* Effect.promise(() => fake.nextRequest("session.resume"));
        assert.equal(resume.params.session_id, "stored-new-1");
        const submits = fake.requests().filter((request) => request.method === "prompt.submit");
        assert.deepEqual(
          submits.map((request) => request.params.session_id),
          ["rt-1", "rt-2"],
        );
      }),
    ).pipe(Effect.provide(testLayer)),
  );
});
