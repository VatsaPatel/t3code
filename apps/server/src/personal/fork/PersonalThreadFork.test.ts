import { assert, it } from "@effect/vitest";
import {
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  ThreadId,
  type OrchestrationV2Command,
  type OrchestrationV2DomainEvent,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as EventSink from "../../orchestration-v2/EventSink.ts";
import * as IdAllocator from "../../orchestration-v2/IdAllocator.ts";
import * as Orchestrator from "../../orchestration-v2/Orchestrator.ts";
import * as ProviderAdapterRegistry from "../../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ProviderSessionManager from "../../orchestration-v2/ProviderSessionManager.ts";
import * as RuntimePolicy from "../../orchestration-v2/RuntimePolicy.ts";
import * as PersonalThreadFork from "./PersonalThreadFork.ts";

const instanceId = ProviderInstanceId.make("hermes");
const sourceThreadId = ThreadId.make("import:hermes:20260901_slack");
const targetThreadId = ThreadId.make("fork-target");
const sourceProviderThreadId = ProviderThreadId.make("provider-thread-source");
const at = "2026-09-01T10:00:00.000Z";

const sourceProviderThread = {
  id: sourceProviderThreadId,
  driver: "hermes",
  providerInstanceId: instanceId,
  providerSessionId: null,
  appThreadId: sourceThreadId,
  nativeThreadRef: { driver: "hermes", nativeId: "20260901_slack", strength: "strong" },
  forkedFrom: null,
};

function sourceRecords(runs: ReadonlyArray<{ readonly status: string }>) {
  return {
    thread: {
      id: sourceThreadId,
      title: "Slack chat",
      activeProviderThreadId: sourceProviderThreadId,
      modelSelection: { instanceId, model: "default" },
      lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: sourceThreadId },
    },
    runs,
    providerThreads: [sourceProviderThread],
    messages: [
      { id: "m1", role: "user", text: "Plan my week", createdAt: at },
      { id: "m2", role: "assistant", text: "Here is the plan", createdAt: at },
      { id: "m3", role: "assistant", text: "   ", createdAt: at },
    ],
  };
}

function makeLayer(input: {
  readonly runs: ReadonlyArray<{ readonly status: string }>;
  readonly writes: Array<ReadonlyArray<OrchestrationV2DomainEvent>>;
  readonly dispatched: Array<OrchestrationV2Command>;
  readonly closed: Array<ProviderSessionId>;
}) {
  const childProviderThread = {
    ...sourceProviderThread,
    id: ProviderThreadId.make("provider-thread-child"),
    providerSessionId: ProviderSessionId.make("session-for-fork"),
    appThreadId: targetThreadId,
    nativeThreadRef: { driver: "hermes", nativeId: "20260905_branch", strength: "strong" },
  };
  return PersonalThreadFork.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(Orchestrator.OrchestratorV2)({
          getThreadRecords: () => Effect.succeed(sourceRecords(input.runs) as never),
          dispatch: (command) => {
            input.dispatched.push(command as OrchestrationV2Command);
            return Effect.succeed({} as never);
          },
        }),
        Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({
          get: () =>
            Effect.succeed({
              instanceId,
              driver: "hermes",
              getCapabilities: () =>
                Effect.succeed({
                  threads: { canForkThread: true },
                  sessions: { supportsMultipleProviderThreadsPerSession: false },
                } as never),
            } as never),
        }),
        Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({
          open: () =>
            Effect.succeed({
              forkThread: () => Effect.succeed(childProviderThread as never),
            } as never),
          close: (providerSessionId) => {
            input.closed.push(providerSessionId);
            return Effect.void;
          },
        }),
        Layer.mock(RuntimePolicy.RuntimePolicyV2)({
          resolve: () => Effect.succeed({} as never),
        }),
        Layer.mock(IdAllocator.IdAllocatorV2)({
          allocate: {
            providerSession: () => Effect.succeed(ProviderSessionId.make("session-for-fork")),
          } as never,
        }),
        Layer.mock(EventSink.EventSinkV2)({
          write: ({ events }) => {
            input.writes.push(events);
            return Effect.succeed({} as never);
          },
        }),
      ),
    ),
  );
}

const actor = { createdBy: "user", creationSource: "web" } as const;

it.effect("forks a synced thread through the provider's native fork", () => {
  const writes: Array<ReadonlyArray<OrchestrationV2DomainEvent>> = [];
  const dispatched: Array<OrchestrationV2Command> = [];
  const closed: Array<ProviderSessionId> = [];
  return Effect.gen(function* () {
    const service = yield* PersonalThreadFork.PersonalThreadFork;
    const result = yield* service.fork({ sourceThreadId, targetThreadId }, actor);

    assert.deepStrictEqual(result, { threadId: targetThreadId, mode: "native" });
    assert.strictEqual(dispatched.length, 0);
    assert.deepStrictEqual(closed, [ProviderSessionId.make("session-for-fork")]);
    const events = writes.flat();
    const created = events.find((event) => event.type === "thread.created");
    assert.strictEqual(created?.type, "thread.created");
    if (created?.type === "thread.created") {
      assert.strictEqual(created.payload.lineage.parentThreadId, sourceThreadId);
      assert.strictEqual(created.payload.lineage.relationshipToParent, "fork");
      assert.strictEqual(created.payload.activeProviderThreadId, "provider-thread-child");
    }
    const providerThread = events.find((event) => event.type === "provider-thread.updated");
    if (providerThread?.type !== "provider-thread.updated") {
      return assert.fail("missing provider thread for the child");
    }
    // The child continues the provider's new native session, never the parent's.
    assert.strictEqual(providerThread.payload.nativeThreadRef?.nativeId, "20260905_branch");
    assert.strictEqual(providerThread.payload.appThreadId, targetThreadId);
    assert.strictEqual(providerThread.payload.providerSessionId, null);
    // Empty rows are not copied into the readable history.
    assert.strictEqual(events.filter((event) => event.type === "message.updated").length, 2);
  }).pipe(Effect.provide(makeLayer({ runs: [], writes, dispatched, closed })));
});

it.effect("defers threads with T3 runs to the orchestrator and refuses busy threads", () => {
  const writes: Array<ReadonlyArray<OrchestrationV2DomainEvent>> = [];
  const dispatched: Array<OrchestrationV2Command> = [];
  const closed: Array<ProviderSessionId> = [];
  return Effect.gen(function* () {
    const service = yield* PersonalThreadFork.PersonalThreadFork;
    const result = yield* service.fork({ sourceThreadId, targetThreadId }, actor);
    assert.deepStrictEqual(result, { threadId: targetThreadId, mode: "orchestrated" });
    assert.strictEqual(dispatched[0]?.type, "thread.fork");
    assert.strictEqual(writes.length, 0);
  }).pipe(
    Effect.provide(makeLayer({ runs: [{ status: "completed" }], writes, dispatched, closed })),
    Effect.andThen(
      Effect.gen(function* () {
        const service = yield* PersonalThreadFork.PersonalThreadFork;
        const error = yield* Effect.flip(service.fork({ sourceThreadId, targetThreadId }, actor));
        assert.strictEqual(error.reason, "busy");
      }).pipe(
        Effect.provide(makeLayer({ runs: [{ status: "running" }], writes, dispatched, closed })),
      ),
    ),
  );
});
