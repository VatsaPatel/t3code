import {
  CommandId,
  EventId,
  MessageId,
  type OrchestrationV2Actor,
  type OrchestrationV2AppThread,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2CreationSource,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2Run,
  PersonalThreadForkError,
  type PersonalThreadForkInput,
  type PersonalThreadForkResult,
  TurnItemId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { EventSinkV2 } from "../../orchestration-v2/EventSink.ts";
import { IdAllocatorV2 } from "../../orchestration-v2/IdAllocator.ts";
import { OrchestratorV2 } from "../../orchestration-v2/Orchestrator.ts";
import { ProviderAdapterRegistryV2 } from "../../orchestration-v2/ProviderAdapterRegistry.ts";
import { ProviderSessionManagerV2 } from "../../orchestration-v2/ProviderSessionManager.ts";
import { RuntimePolicyV2 } from "../../orchestration-v2/RuntimePolicy.ts";
import { isForkableSourceRunStatus } from "../../orchestration-v2/ThreadForkService.ts";

const EVENT_PREFIX = "personal-fork:v1";

const BUSY_RUN_STATUSES: ReadonlySet<OrchestrationV2Run["status"]> = new Set([
  "preparing",
  "starting",
  "running",
]);

export interface PersonalThreadForkActor {
  readonly createdBy: OrchestrationV2Actor;
  readonly creationSource: OrchestrationV2CreationSource;
}

/**
 * Builds the child's visible history. The provider child already carries the
 * full native context; these rows only let the user read what was forked.
 */
export function copiedHistoryEvents(input: {
  readonly targetThreadId: OrchestrationV2AppThread["id"];
  readonly messages: ReadonlyArray<OrchestrationV2ConversationMessage>;
}): ReadonlyArray<OrchestrationV2DomainEvent> {
  return input.messages
    .filter((message) => message.role === "user" || message.role === "assistant")
    .filter((message) => message.text.trim() !== "")
    .flatMap((source, index) => {
      const suffix = String(index).padStart(6, "0");
      const messageId = MessageId.make(`${input.targetThreadId}:fork:${suffix}`);
      const message: OrchestrationV2ConversationMessage = {
        ...source,
        id: messageId,
        threadId: input.targetThreadId,
        runId: null,
        nodeId: null,
        attachments: [],
        streaming: false,
      };
      const common = {
        id: TurnItemId.make(`${EVENT_PREFIX}:turn-item:${input.targetThreadId}:${suffix}`),
        threadId: input.targetThreadId,
        runId: null,
        nodeId: null,
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: null,
        parentItemId: null,
        ordinal: index + 1,
        status: "completed" as const,
        title: null,
        startedAt: source.createdAt,
        completedAt: source.createdAt,
        updatedAt: source.createdAt,
      };
      return [
        {
          id: EventId.make(`${EVENT_PREFIX}:message:${input.targetThreadId}:${suffix}`),
          type: "message.updated",
          threadId: input.targetThreadId,
          occurredAt: source.createdAt,
          payload: message,
        },
        {
          id: EventId.make(`${EVENT_PREFIX}:turn-item:${input.targetThreadId}:${suffix}`),
          type: "turn-item.updated",
          threadId: input.targetThreadId,
          occurredAt: source.createdAt,
          payload:
            source.role === "user"
              ? {
                  ...common,
                  createdBy: "user",
                  creationSource: "server",
                  type: "user_message",
                  messageId,
                  inputIntent: "turn_start",
                  text: source.text,
                  attachments: [],
                }
              : {
                  ...common,
                  type: "assistant_message",
                  messageId,
                  text: source.text,
                  streaming: false,
                },
        },
      ] satisfies ReadonlyArray<OrchestrationV2DomainEvent>;
    });
}

const make = Effect.gen(function* () {
  const orchestrator = yield* OrchestratorV2;
  const adapters = yield* ProviderAdapterRegistryV2;
  const sessions = yield* ProviderSessionManagerV2;
  const runtimePolicy = yield* RuntimePolicyV2;
  const idAllocator = yield* IdAllocatorV2;
  const eventSink = yield* EventSinkV2;

  const fork = Effect.fn("PersonalThreadFork.fork")(function* (
    input: PersonalThreadForkInput,
    actor: PersonalThreadForkActor,
  ) {
    const fail = (reason: PersonalThreadForkError["reason"], detail: string) =>
      new PersonalThreadForkError({ sourceThreadId: input.sourceThreadId, reason, detail });

    const source = yield* orchestrator
      .getThreadRecords(input.sourceThreadId, ["runs", "providerThreads", "messages"])
      .pipe(Effect.mapError(() => fail("not-found", "The thread to fork was not found.")));

    if (source.runs.some((run) => BUSY_RUN_STATUSES.has(run.status))) {
      return yield* fail("busy", "Wait for the current turn to finish before forking this thread.");
    }

    // Threads with T3 runs already fork natively through the orchestrator.
    if (source.runs.some((run) => isForkableSourceRunStatus(run.status))) {
      yield* orchestrator
        .dispatch({
          type: "thread.fork",
          commandId: CommandId.make(`personal-fork:${input.targetThreadId}`),
          createdBy: actor.createdBy,
          creationSource: actor.creationSource,
          sourceThreadId: input.sourceThreadId,
          targetThreadId: input.targetThreadId,
          sourcePoint: { type: "latest_stable" },
          ...(input.title === undefined ? {} : { title: input.title }),
        })
        .pipe(Effect.mapError((cause) => fail("provider-failed", String(cause))));
      return {
        threadId: input.targetThreadId,
        mode: "orchestrated",
      } satisfies PersonalThreadForkResult;
    }

    const sourceProviderThread = source.providerThreads.find(
      (candidate) => candidate.id === source.thread.activeProviderThreadId,
    );
    const nativeId = sourceProviderThread?.nativeThreadRef?.nativeId;
    if (
      sourceProviderThread === undefined ||
      nativeId == null ||
      sourceProviderThread.nativeThreadRef?.strength !== "strong"
    ) {
      return yield* fail(
        "no-native-session",
        "This thread has no provider session to fork natively.",
      );
    }

    const instanceId = sourceProviderThread.providerInstanceId;
    const adapter = yield* adapters
      .get(instanceId)
      .pipe(
        Effect.mapError(() =>
          fail("unsupported", `The ${instanceId} provider is not available in this environment.`),
        ),
      );
    const capabilities = yield* adapter
      .getCapabilities()
      .pipe(Effect.mapError((cause) => fail("provider-failed", String(cause))));
    if (!capabilities.threads.canForkThread) {
      return yield* fail("unsupported", `${adapter.driver} cannot fork conversations natively.`);
    }

    const modelSelection =
      source.thread.modelSelection.instanceId === instanceId
        ? source.thread.modelSelection
        : { ...source.thread.modelSelection, instanceId };
    const policy = yield* runtimePolicy
      .resolve({ thread: source.thread, modelSelection })
      .pipe(Effect.mapError((cause) => fail("provider-failed", String(cause))));
    const sharedSession = capabilities.sessions.supportsMultipleProviderThreadsPerSession;
    const providerSessionId = sharedSession
      ? idAllocator.derive.providerSession({ providerInstanceId: instanceId })
      : yield* idAllocator.allocate
          .providerSession({ providerInstanceId: instanceId, threadId: input.targetThreadId })
          .pipe(Effect.mapError((cause) => fail("provider-failed", String(cause))));

    const forked = yield* Effect.gen(function* () {
      const session = yield* sessions.open({
        threadId: input.targetThreadId,
        providerSessionId,
        modelSelection,
        runtimePolicy: policy,
        initialNativeThreadId: nativeId,
      });
      return yield* session.forkThread({
        sourceProviderThread,
        targetThreadId: input.targetThreadId,
        modelSelection,
        runtimePolicy: policy,
      });
    }).pipe(
      Effect.ensuring(
        sharedSession ? Effect.void : sessions.close(providerSessionId).pipe(Effect.ignore),
      ),
      Effect.mapError((cause) => fail("provider-failed", String(cause))),
    );

    const now = yield* DateTime.now;
    const childProviderThread: OrchestrationV2ProviderThread = {
      ...forked,
      appThreadId: input.targetThreadId,
      providerSessionId: sharedSession ? forked.providerSessionId : null,
      status: "idle",
      forkedFrom: forked.forkedFrom ?? { providerThreadId: sourceProviderThread.id },
    };
    const targetThread: OrchestrationV2AppThread = {
      ...source.thread,
      id: input.targetThreadId,
      createdBy: actor.createdBy,
      creationSource: actor.creationSource,
      title: input.title ?? `${source.thread.title} fork`,
      modelSelection,
      providerInstanceId: instanceId,
      activeProviderThreadId: childProviderThread.id,
      lineage: {
        parentThreadId: source.thread.id,
        relationshipToParent: "fork",
        rootThreadId: source.thread.lineage.rootThreadId,
      },
      forkedFrom: { type: "provider_thread", providerThreadId: sourceProviderThread.id },
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      unsettledAt: null,
      snoozedUntil: null,
      snoozedAt: null,
      pinnedAt: null,
      pinOrderKey: null,
      activeOrderKey: null,
      lastVisitedAt: null,
      deletedAt: null,
    };

    yield* eventSink
      .write({
        events: [
          {
            id: EventId.make(`${EVENT_PREFIX}:thread:${input.targetThreadId}:created`),
            type: "thread.created",
            threadId: input.targetThreadId,
            providerInstanceId: instanceId,
            occurredAt: now,
            payload: targetThread,
          },
          ...copiedHistoryEvents({
            targetThreadId: input.targetThreadId,
            messages: source.messages,
          }),
          {
            id: EventId.make(`${EVENT_PREFIX}:provider-thread:${childProviderThread.id}`),
            type: "provider-thread.updated",
            threadId: input.targetThreadId,
            driver: childProviderThread.driver,
            providerInstanceId: instanceId,
            occurredAt: now,
            payload: childProviderThread,
          },
        ],
      })
      .pipe(Effect.mapError((cause) => fail("provider-failed", String(cause))));

    return { threadId: input.targetThreadId, mode: "native" } satisfies PersonalThreadForkResult;
  });

  return { fork };
});

export class PersonalThreadFork extends Context.Service<
  PersonalThreadFork,
  Effect.Success<typeof make>
>()("t3/personal/fork/PersonalThreadFork") {}

export const layer = Layer.effect(PersonalThreadFork, make);
