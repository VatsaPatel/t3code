import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  RunId,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import { HermesProviderCapabilitiesV2 } from "./Adapters/HermesAdapterV2.ts";
import * as EventSink from "./EventSink.ts";
import * as Orchestrator from "./Orchestrator.ts";
import type { ProviderAdapterV2Shape } from "./ProviderAdapter.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import { makeOrchestratorV2ReplayLayerWithRegistry } from "./testkit/ProviderReplayHarness.ts";

// Hermes forks a whole session but cannot fork from an earlier turn.
const driver = ProviderDriverKind.make("hermes");
const instanceId = ProviderInstanceId.make("hermes");
const modelSelection = { instanceId, model: "default" };
const adapter: ProviderAdapterV2Shape = {
  instanceId,
  driver,
  getCapabilities: () => Effect.succeed(HermesProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
  openSession: () => Effect.die("Execution is paused after dispatch for fork inspection"),
};

const forkStrategy = (input: { readonly runCount: number; readonly forkOrdinal: number }) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const eventSink = yield* EventSink.EventSinkV2;
    const now = yield* DateTime.now;
    const sourceThreadId = ThreadId.make("head-fork-source");
    const targetThreadId = ThreadId.make("head-fork-target");
    const providerThreadId = ProviderThreadId.make("head-fork-native-thread");
    const runIdFor = (ordinal: number) => RunId.make(`head-fork-run-${ordinal}`);

    yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make("create-source"),
      threadId: sourceThreadId,
      projectId: ProjectId.make("head-fork-project"),
      title: "Head fork source",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdBy: "user",
      creationSource: "web",
    });
    yield* eventSink.write({
      events: [
        {
          id: EventId.make("source-provider-thread"),
          type: "provider-thread.updated",
          threadId: sourceThreadId,
          occurredAt: now,
          payload: {
            id: providerThreadId,
            driver,
            providerInstanceId: instanceId,
            providerSessionId: null,
            appThreadId: sourceThreadId,
            ownerNodeId: null,
            nativeThreadRef: { driver, nativeId: "20261005_000000_abcdef", strength: "strong" },
            nativeConversationHeadRef: null,
            status: "idle",
            firstRunOrdinal: 1,
            lastRunOrdinal: input.runCount,
            handoffIds: [],
            forkedFrom: null,
            createdAt: now,
            updatedAt: now,
          },
        },
      ],
    });
    for (let ordinal = 1; ordinal <= input.runCount; ordinal++) {
      const runId = runIdFor(ordinal);
      const messageId = MessageId.make(`source-message-${ordinal}`);
      yield* eventSink.write({
        events: [
          {
            id: EventId.make(`run-${ordinal}`),
            type: "run.created",
            threadId: sourceThreadId,
            runId,
            occurredAt: now,
            payload: {
              id: runId,
              threadId: sourceThreadId,
              ordinal,
              providerInstanceId: instanceId,
              modelSelection,
              providerThreadId,
              userMessageId: messageId,
              rootNodeId: null,
              activeAttemptId: null,
              status: "completed",
              queuePosition: null,
              requestedAt: now,
              startedAt: now,
              completedAt: now,
              checkpointId: null,
              contextHandoffId: null,
            },
          },
          {
            id: EventId.make(`item-${ordinal}`),
            type: "turn-item.updated",
            threadId: sourceThreadId,
            runId,
            occurredAt: now,
            payload: {
              id: TurnItemId.make(`item-${ordinal}`),
              threadId: sourceThreadId,
              runId,
              nodeId: null,
              providerThreadId,
              providerTurnId: null,
              nativeItemRef: null,
              parentItemId: null,
              ordinal,
              status: "completed",
              title: null,
              startedAt: now,
              completedAt: now,
              updatedAt: now,
              type: "user_message",
              createdBy: "user",
              creationSource: "web",
              inputIntent: "turn_start",
              messageId,
              text: `Source message ${ordinal}`,
              attachments: [],
            },
          },
        ],
      });
    }
    yield* orchestrator.dispatch({
      type: "thread.fork",
      commandId: CommandId.make("fork-source"),
      sourceThreadId,
      targetThreadId,
      sourcePoint: { type: "run", runId: runIdFor(input.forkOrdinal) },
      createdBy: "user",
      creationSource: "web",
    });
    yield* orchestrator.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make("continue-fork"),
      threadId: targetThreadId,
      messageId: MessageId.make("continue-fork"),
      text: "Continue the fork",
      attachments: [],
      modelSelection,
      dispatchMode: { type: "start_immediately" },
      createdBy: "user",
      creationSource: "web",
    });
    const target = yield* orchestrator.getThreadProjection(targetThreadId);
    // A native fork resolves once the provider has forked; a portable one
    // resolves at dispatch with a transcript handoff.
    return {
      strategy: target.contextTransfers[0]?.resolution?.strategy ?? null,
      transcriptHandoffs: target.contextHandoffs.length,
    };
  }).pipe(
    Effect.provide(
      makeOrchestratorV2ReplayLayerWithRegistry(
        { name: `head-fork-${input.runCount}-${input.forkOrdinal}` },
        ProviderAdapterRegistry.makeLayer([adapter]),
        { runEffectWorker: false },
      ),
    ),
  );

it.effect("forks a whole-session provider natively at the source's newest run", () =>
  Effect.gen(function* () {
    assert.deepEqual(yield* forkStrategy({ runCount: 2, forkOrdinal: 2 }), {
      strategy: null,
      transcriptHandoffs: 0,
    });
  }),
);

it.effect("falls back to portable context when forking before the source's newest run", () =>
  Effect.gen(function* () {
    assert.deepEqual(yield* forkStrategy({ runCount: 2, forkOrdinal: 1 }), {
      strategy: "portable_context",
      transcriptHandoffs: 1,
    });
  }),
);
