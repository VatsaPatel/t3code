/**
 * HermesAdapterV2 — orchestrator-v2 adapter for Hermes Agent
 * (https://github.com/NousResearch/hermes-agent), driving the Hermes
 * `tui_gateway` stdio JSON-RPC protocol through the instance's shared
 * `HermesGateway` process.
 *
 * Identity: the durable Hermes session id (`state.db` `sessions.id`) is the
 * strong `nativeThreadRef`. Any stored session can be resumed, whatever
 * surface created it (CLI, desktop, Slack, cron, ACP). Hermes rotates the id
 * when it compresses a long conversation; the adapter follows the rotation
 * from `session.resume` and `session.info` and updates the ref in place.
 *
 * Lease etiquette: Hermes grants one surface an exclusive lease on a session
 * from its first prompt until `session.close`. While T3 holds it, Slack and
 * the CLI are refused. The adapter therefore closes its runtime session a
 * short grace period after each turn settles and resumes it lazily on the
 * next turn. A refusal (`4090 SESSION_NOT_OWNED`) fails the turn with a
 * reusable disposition so the user can retry once the other surface is idle.
 *
 * Turn terminal: `message.complete` ends a turn. Prompts are submitted with
 * `queued: true`, so a T3 follow-up that races Hermes' post-turn bookkeeping
 * is queued by Hermes instead of interrupting it (its default busy policy).
 * A turn that never reached `message.complete` ends on its `error` frame or
 * on the settled `session.info`.
 *
 * Config safety: `config.set` is only ever sent with a live `session_id` and
 * only for the session-scoped keys model, reasoning effort, fast, and yolo.
 * Every other key writes the user's `config.yaml`.
 */
import { HostProcessEnvironment } from "@t3tools/shared/hostProcess";
import {
  getModelSelectionBooleanOptionValue,
  getModelSelectionStringOptionValue,
} from "@t3tools/shared/model";
import {
  HermesSettings,
  ProviderDriverKind,
  type ChatAttachment,
  type ModelSelection,
  type OrchestrationV2ExecutionNode,
  type OrchestrationV2PlanStep,
  type OrchestrationV2ProviderCapabilities,
  type OrchestrationV2ProviderFailure,
  type OrchestrationV2ProviderRef,
  type OrchestrationV2ProviderSession,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2ProviderTurn,
  type OrchestrationV2ProviderTurnTokenUsage,
  type OrchestrationV2RuntimeRequest,
  type OrchestrationV2TurnItem,
  type OrchestrationV2UserInputQuestion,
  type PlanId,
  type ProviderApprovalDecision,
  type ProviderApprovalOption,
  type ProviderInstanceId,
  type ProviderUserInputAnswers,
  type NodeId,
  type ProviderThreadId,
  type ProviderTurnId,
  type RunId,
  type RuntimeMode,
  type RuntimeRequestId,
  type ThreadId,
  type TurnItemId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Predicate from "effect/Predicate";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/unstable/process";

import { resolveAttachmentPath } from "../../attachmentStore.ts";
import * as ServerConfig from "../../config.ts";
import { mcpToolPresentation } from "../../provider/McpToolPresentation.ts";
import { mergeProviderInstanceEnvironment } from "../../provider/ProviderInstanceEnvironment.ts";
import {
  HermesRpcError,
  makeHermesGateway,
  resolveHermesLaunch,
  type HermesGateway,
  type HermesGatewayConnection,
  type HermesInbound,
  type HermesSessionSink,
} from "../../provider/hermes/HermesGateway.ts";
import {
  HERMES_RPC_ERROR,
  HermesApprovalRequestParams,
  HermesClarifyRequestParams,
  HermesCorrectionResult,
  HermesErrorPayload,
  HermesInterimPayload,
  HermesMessageCompletePayload,
  HermesRequestCancelPayload,
  HermesSessionBranchStoredResult,
  HermesSessionCreateResult,
  HermesSessionHistoryResult,
  HermesSessionInfo,
  HermesSessionResumeResult,
  HermesStatusUpdatePayload,
  HermesSubagentPayload,
  HermesTextPayload,
  HermesTitlePayload,
  HermesTodoItem,
  HermesTodoUpdatedPayload,
  HermesToolCompletePayload,
  HermesToolStartPayload,
  HermesUsagePayload,
  type HermesUsage,
} from "../../provider/hermes/HermesProtocol.ts";
import * as IdAllocator from "../IdAllocator.ts";
import * as ProviderAdapter from "../ProviderAdapter.ts";
import {
  ProviderAdapterDriverCreateError,
  type ProviderAdapterDriver,
  type ProviderAdapterDriverCreateInput,
} from "../ProviderAdapterDriver.ts";
import { makeProviderFailure } from "../ProviderFailure.ts";
import { turnScopedSelectionTransition } from "../ProviderSelectionTransition.ts";

export const HERMES_PROVIDER = ProviderDriverKind.make("hermes");
const DEFAULT_HERMES_SETTINGS = Schema.decodeSync(HermesSettings)({});

/** Model slug meaning "keep the model configured for the Hermes profile/session". */
export const HERMES_DEFAULT_MODEL_SLUG = "default";
/** Separates the Hermes provider slug from the model id in a T3 model slug. */
export const HERMES_MODEL_SLUG_SEPARATOR = "::";
export const HERMES_REASONING_OPTION_ID = "reasoningEffort";
export const HERMES_FAST_OPTION_ID = "fastMode";
/** Reasoning words `config.set reasoning` accepts as session-scoped efforts. */
const HERMES_REASONING_EFFORTS: ReadonlySet<string> = new Set([
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);

export const HERMES_SESSION_NOT_OWNED_MESSAGE =
  "This Hermes conversation is active in another Hermes client (Slack/CLI). Try again when it's idle.";
const HERMES_LEASE_WAIT_MARKER = "Another Hermes process is using this session";

const STREAM_FLUSH_MS = 50;
const SESSION_REQUEST_TIMEOUT_MS = 60_000;
const RESUME_TIMEOUT_MS = 180_000;
const CLOSE_TIMEOUT_MS = 15_000;
const DEFAULT_LEASE_RELEASE_DELAY = Duration.seconds(30);
const MAX_TOOL_OUTPUT_CHARS = 20_000;

export const HermesProviderCapabilitiesV2 = {
  runtimePolicy: { enforcement: "client-boundary" },
  sessions: {
    supportsMultipleProviderThreadsPerSession: false,
    // Model, reasoning, fast, and yolo are per-session `config.set` keys.
    supportsModelSwitchInSession: true,
    supportsProviderSwitchingViaHandoff: true,
    supportsRuntimeModeSwitchInSession: true,
    pendingRequestsSurviveRestart: false,
  },
  threads: {
    canCreateEmptyThread: true,
    canReadThreadSnapshot: true,
    // Hermes cannot rewind a conversation to a turn boundary.
    canRollbackThread: false,
    // `session.branch_stored` copies a whole stored conversation.
    canForkThread: true,
    canForkFromTurn: false,
    canForkFromSubagentThread: false,
    exposesNativeThreadId: true,
  },
  turns: {
    exposesNativeTurnId: false,
    emitsTurnStarted: true,
    emitsTurnCompleted: true,
    supportsInterrupt: true,
    supportsActiveSteering: true,
    supportsSteeringByInterruptRestart: false,
    supportsQueuedMessages: true,
    terminalStatusQuality: "strong",
  },
  streaming: {
    streamsAssistantText: true,
    streamsReasoning: true,
    streamsToolOutput: false,
    streamsPlanText: false,
    emitsMessageCompleted: true,
  },
  tools: {
    exposesToolItemIds: true,
    emitsToolStarted: true,
    emitsToolCompleted: true,
    emitsToolOutput: true,
    supportsMcpTools: true,
    supportsDynamicToolCallbacks: false,
  },
  approvals: {
    supportsCommandApproval: true,
    supportsFileReadApproval: false,
    supportsFileChangeApproval: false,
    supportsApplyPatchApproval: false,
    approvalsHaveNativeRequestIds: true,
    approvalCallbacksAreLiveOnly: true,
    approvalsCanOriginateFromSubagents: false,
  },
  planning: {
    emitsPlanUpdated: true,
    emitsTodoList: true,
    emitsProposedPlan: false,
    supportsStructuredQuestions: true,
    planDeltasHaveItemIds: false,
  },
  subagents: {
    // delegate_task children stream on the parent session; their stored
    // sessions are not T3 threads.
    supportsSubagents: true,
    exposesSubagentThreadIds: false,
    emitsSubagentLifecycle: true,
    canWaitForSubagents: false,
    canCloseSubagents: false,
    canForkSubagentThread: false,
  },
  context: {
    acceptsSystemContext: false,
    acceptsDeveloperContext: false,
    acceptsSyntheticUserContext: true,
    canGenerateSummaries: false,
    canConsumeHandoffSummaries: true,
    supportsDeltaHandoff: true,
    supportsFullThreadHandoff: true,
    maxRecommendedHandoffChars: null,
  },
  checkpointing: {
    appCanCheckpointFilesystem: true,
    supportsNestedCheckpointScopes: false,
    providerCanRollbackConversation: false,
    providerRollbackReturnsSnapshot: false,
    providerCanReadConversationSnapshot: true,
  },
  identity: {
    nativeThreadIds: "strong",
    nativeTurnIds: "weak",
    nativeItemIds: "strong",
    nativeRequestIds: "strong",
  },
} satisfies OrchestrationV2ProviderCapabilities;

export interface HermesAdapterV2Options {
  readonly instanceId: ProviderInstanceId;
  readonly gateway: HermesGateway;
  readonly idAllocator: IdAllocator.IdAllocatorV2["Service"];
  readonly serverConfig: ServerConfig.ServerConfig["Service"];
  /** How long a settled thread keeps its Hermes lease before `session.close`. */
  readonly leaseReleaseDelay?: Duration.Input;
}

function providerRef(
  nativeId: string,
  strength: "strong" | "weak" = "strong",
): OrchestrationV2ProviderRef {
  return { driver: HERMES_PROVIDER, nativeId, strength };
}

/** Split a T3 model slug into the `config.set model` value. */
export function hermesModelSwitchValue(slug: string): string | null {
  if (slug === HERMES_DEFAULT_MODEL_SLUG || slug.trim() === "") return null;
  const separator = slug.indexOf(HERMES_MODEL_SLUG_SEPARATOR);
  if (separator <= 0) return slug;
  const provider = slug.slice(0, separator);
  const model = slug.slice(separator + HERMES_MODEL_SLUG_SEPARATOR.length);
  return model === "" ? null : `${model} --provider ${provider}`;
}

function stripAnsi(text: string): string {
  // oxlint-disable-next-line no-control-regex
  return text.replace(/\u001b\[[0-9;]*[A-Za-z]/g, "");
}

function boundedText(text: string, max = MAX_TOOL_OUTPUT_CHARS): string {
  return text.length > max ? `${text.slice(0, max)}\n…` : text;
}

function recordField(input: unknown, key: string): unknown {
  return Predicate.isObject(input) ? (input as Record<string, unknown>)[key] : undefined;
}

function recordString(input: unknown, key: string): string | undefined {
  const value = recordField(input, key);
  return typeof value === "string" ? value : undefined;
}

function resultText(result: unknown): string | undefined {
  if (result === undefined || result === null) return undefined;
  if (typeof result === "string") return result;
  return JSON.stringify(result);
}

/** Hermes tool results carry no error flag; mirror its own failure heuristic. */
function hermesToolFailed(result: unknown): boolean {
  if (!Predicate.isObject(result)) return false;
  const record = result as Record<string, unknown>;
  if (record["success"] === false || record["ok"] === false) return true;
  const error = record["error"];
  if (typeof error === "string" ? error.trim().length > 0 : error != null && error !== false) {
    return true;
  }
  const exitCode = record["exit_code"];
  return typeof exitCode === "number" && exitCode !== 0;
}

function approvalOptions(choices: ReadonlyArray<string>): ReadonlyArray<ProviderApprovalOption> {
  const options: Array<ProviderApprovalOption> = [];
  for (const choice of choices) {
    if (choice === "once") options.push({ decision: "accept", label: "Allow once" });
    if (choice === "session") {
      options.push({ decision: "acceptForSession", label: "Allow for this session" });
    }
    if (choice === "always") options.push({ decision: "acceptAlways", label: "Always allow" });
    if (choice === "deny") options.push({ decision: "decline", label: "Deny" });
  }
  return options;
}

/** T3 decision → Hermes approval choice; anything unrecognized denies. */
export function hermesApprovalChoice(
  decision: ProviderApprovalDecision | undefined,
  choices: ReadonlyArray<string>,
): "once" | "session" | "always" | "deny" {
  const wanted =
    decision === "accept"
      ? "once"
      : decision === "acceptForSession"
        ? "session"
        : decision === "acceptAlways"
          ? "always"
          : "deny";
  return choices.length === 0 || choices.includes(wanted) ? wanted : "deny";
}

function answerText(value: unknown, multiSelect: boolean): string {
  if (Array.isArray(value)) {
    const items = value.map((item) => String(item));
    return multiSelect ? JSON.stringify(items) : items.join(", ");
  }
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "";
  return typeof value === "number" || typeof value === "boolean"
    ? String(value)
    : JSON.stringify(value);
}

function clarifyQuestion(input: {
  readonly id: string;
  readonly question: string;
  readonly choices: ReadonlyArray<string> | null | undefined;
  readonly multiSelect: boolean;
}): OrchestrationV2UserInputQuestion {
  const choices = (input.choices ?? []).filter((choice) => choice.trim().length > 0);
  const question = input.question.trim() || "Hermes has a question";
  return {
    id: input.id,
    header: "Hermes",
    question,
    // Native choice strings are the reply values; Hermes matches them verbatim.
    options: choices.map((choice) => ({ label: choice, description: choice, value: choice })),
    ...(input.multiSelect ? { multiSelect: true } : {}),
    // The clarify tool always accepts free text in addition to its choices.
    allowCustomAnswer: true,
  };
}

function todoStepStatus(status: string | undefined): OrchestrationV2PlanStep["status"] {
  if (status === "completed" || status === "cancelled" || status === "done") return "completed";
  if (status === "in_progress" || status === "running") return "running";
  return "pending";
}

function subagentStatus(
  eventType: string,
  status: string | null | undefined,
): "pending" | "running" | "completed" | "failed" | "interrupted" {
  switch (status) {
    case "queued":
      return "pending";
    case "completed":
      return "completed";
    case "failed":
    case "error":
    case "timeout":
      return "failed";
    case "interrupted":
      return "interrupted";
    case "running":
      return "running";
  }
  if (eventType === "subagent.complete") return "completed";
  if (eventType === "subagent.spawn_requested") return "pending";
  return "running";
}

function tokenUsageFrom(
  usage: HermesUsage | null | undefined,
  updatedAt: DateTime.Utc,
): OrchestrationV2ProviderTurnTokenUsage | undefined {
  if (usage == null) return undefined;
  const nonNegative = (value: number | null | undefined) =>
    typeof value === "number" && Number.isFinite(value)
      ? Math.max(0, Math.trunc(value))
      : undefined;
  const usedTokens = nonNegative(usage.context_used);
  const maxTokens = nonNegative(usage.context_max);
  if (usedTokens === undefined || maxTokens === undefined || maxTokens === 0) return undefined;
  const inputTokens = nonNegative(usage.input);
  const outputTokens = nonNegative(usage.output);
  const cachedInputTokens = nonNegative(usage.cache_read);
  const reasoningOutputTokens = nonNegative(usage.reasoning);
  return {
    usedTokens,
    maxTokens,
    ...(inputTokens === undefined ? {} : { inputTokens }),
    ...(outputTokens === undefined ? {} : { outputTokens }),
    ...(cachedInputTokens === undefined ? {} : { cachedInputTokens }),
    ...(reasoningOutputTokens === undefined ? {} : { reasoningOutputTokens }),
    updatedAt: DateTime.formatIso(updatedAt),
  };
}

const isHermesRpcError = Schema.is(HermesRpcError);
const decodeCreate = Schema.decodeUnknownOption(HermesSessionCreateResult);
const decodeResume = Schema.decodeUnknownOption(HermesSessionResumeResult);
const decodeBranchStored = Schema.decodeUnknownOption(HermesSessionBranchStoredResult);
const decodeHistory = Schema.decodeUnknownOption(HermesSessionHistoryResult);
const decodeCorrection = Schema.decodeUnknownOption(HermesCorrectionResult);
const decodeText = Schema.decodeUnknownOption(HermesTextPayload);
const decodeInterim = Schema.decodeUnknownOption(HermesInterimPayload);
const decodeComplete = Schema.decodeUnknownOption(HermesMessageCompletePayload);
const decodeToolStart = Schema.decodeUnknownOption(HermesToolStartPayload);
const decodeToolComplete = Schema.decodeUnknownOption(HermesToolCompletePayload);
const decodeTodoUpdated = Schema.decodeUnknownOption(HermesTodoUpdatedPayload);
const decodeTodoItem = Schema.decodeUnknownOption(HermesTodoItem);
const decodeSubagent = Schema.decodeUnknownOption(HermesSubagentPayload);
const decodeStatus = Schema.decodeUnknownOption(HermesStatusUpdatePayload);
const decodeUsage = Schema.decodeUnknownOption(HermesUsagePayload);
const decodeError = Schema.decodeUnknownOption(HermesErrorPayload);
const decodeTitle = Schema.decodeUnknownOption(HermesTitlePayload);
const decodeInfo = Schema.decodeUnknownOption(HermesSessionInfo);
const decodeRequestCancel = Schema.decodeUnknownOption(HermesRequestCancelPayload);
const decodeApproval = Schema.decodeUnknownOption(HermesApprovalRequestParams);
const decodeClarify = Schema.decodeUnknownOption(HermesClarifyRequestParams);

// ── per-session state ─────────────────────────────────────────

interface StreamItem {
  readonly nativeItemId: string;
  readonly kind: "assistant_message" | "reasoning";
  text: string;
  completed: boolean;
  flushScheduled: boolean;
  readonly startedAt: DateTime.Utc;
}

interface ActiveTurn {
  readonly turnInput: ProviderAdapter.ProviderAdapterV2TurnInput;
  readonly providerTurn: OrchestrationV2ProviderTurn;
  readonly itemOrdinals: Map<string, number>;
  nextItemOrdinal: number;
  segment: number;
  openText: StreamItem | null;
  openReasoning: StreamItem | null;
  readonly streamItems: Array<StreamItem>;
  readonly tools: Map<string, { readonly startedAt: DateTime.Utc; readonly name: string }>;
  readonly subagents: Map<string, DateTime.Utc>;
  planId: PlanId | null;
  leaseWait: { readonly nativeItemId: string; readonly startedAt: DateTime.Utc } | null;
  compaction: { readonly nativeItemId: string; readonly startedAt: DateTime.Utc } | null;
  sawMessageStart: boolean;
  interrupted: boolean;
  failure: OrchestrationV2ProviderFailure | null;
  tokenUsage: OrchestrationV2ProviderTurnTokenUsage | null;
}

interface RuntimeBinding {
  readonly id: string;
  readonly connection: HermesGatewayConnection;
}

interface ThreadState {
  providerThread: OrchestrationV2ProviderThread;
  storedId: string;
  runtime: RuntimeBinding | null;
  /** Hermes writes a session row on the first prompt; until then resume cannot find it. */
  persisted: boolean;
  activeTurn: ActiveTurn | null;
  applied: {
    model: string | null;
    reasoning: string | null;
    fast: boolean | null;
    yolo: boolean | null;
  };
}

interface PendingRequest {
  readonly nativeFrameId: string;
  readonly kind: "approval" | "clarify";
  readonly runtimeId: string;
  readonly choices: ReadonlyArray<string>;
  /** Clarify questions: question id → multi-select; `null` key means single-question form. */
  readonly questions: ReadonlyArray<{ readonly id: string; readonly multiSelect: boolean }>;
  readonly batch: boolean;
  runtimeRequest: OrchestrationV2RuntimeRequest;
  readonly node: OrchestrationV2ExecutionNode;
  readonly turnItem: OrchestrationV2TurnItem;
}

function emptyApplied(): ThreadState["applied"] {
  return { model: null, reasoning: null, fast: null, yolo: null };
}

// ── adapter ───────────────────────────────────────────────────

export function makeHermesAdapterV2(
  options: HermesAdapterV2Options,
): ProviderAdapter.ProviderAdapterV2Shape {
  const { idAllocator, gateway } = options;
  const leaseReleaseDelay = options.leaseReleaseDelay ?? DEFAULT_LEASE_RELEASE_DELAY;

  const protocolError = (detail: string, payload?: unknown) =>
    new ProviderAdapter.ProviderAdapterProtocolError({
      driver: HERMES_PROVIDER,
      detail,
      ...(payload === undefined ? {} : { payload }),
    });

  return ProviderAdapter.ProviderAdapterV2.of({
    instanceId: options.instanceId,
    driver: HERMES_PROVIDER,
    getCapabilities: () => Effect.succeed(HermesProviderCapabilitiesV2),
    planSelectionTransition: () => Effect.succeed(turnScopedSelectionTransition()),
    openSession: Effect.fn("HermesAdapterV2.openSession")(function* (
      input: ProviderAdapter.ProviderAdapterV2OpenSessionInput,
    ) {
      const scope = yield* Effect.scope;
      const cwd = input.runtimePolicy.cwd ?? options.serverConfig.cwd;
      const sink: HermesSessionSink = yield* Queue.unbounded<HermesInbound>();
      const events = yield* Queue.unbounded<ProviderAdapter.ProviderAdapterV2Event>();
      const permit = yield* Semaphore.make(1);
      const pending = new Map<string, PendingRequest>();
      let threadState: ThreadState | null = null;
      let releaseFiber: Fiber.Fiber<void> | null = null;
      let currentRuntimeMode: RuntimeMode = input.runtimePolicy.runtimeMode;

      const now = yield* DateTime.now;
      let sessionEntity: OrchestrationV2ProviderSession = {
        id: input.providerSessionId,
        driver: HERMES_PROVIDER,
        providerInstanceId: options.instanceId,
        status: "ready",
        cwd,
        model: input.modelSelection.model,
        capabilities: HermesProviderCapabilitiesV2,
        createdAt: now,
        updatedAt: now,
        lastError: null,
      };

      const emit = (event: ProviderAdapter.ProviderAdapterV2Event) =>
        Queue.offer(events, event).pipe(Effect.asVoid);

      const updateProviderSession = (
        status: OrchestrationV2ProviderSession["status"],
        lastError: string | null = sessionEntity.lastError,
      ) =>
        Effect.gen(function* () {
          if (sessionEntity.status === status && sessionEntity.lastError === lastError) return;
          sessionEntity = { ...sessionEntity, status, lastError, updatedAt: yield* DateTime.now };
          yield* emit({
            type: "provider_session.updated",
            driver: HERMES_PROVIDER,
            providerSession: sessionEntity,
          });
        });

      const updateProviderThread = (
        state: ThreadState,
        patch: Partial<OrchestrationV2ProviderThread>,
      ) =>
        Effect.gen(function* () {
          state.providerThread = {
            ...state.providerThread,
            ...patch,
            updatedAt: yield* DateTime.now,
          };
          yield* emit({
            type: "provider_thread.updated",
            driver: HERMES_PROVIDER,
            providerThread: state.providerThread,
          });
        });

      /** Follow a stored-id rotation (compression or resume tip). */
      const adoptStoredId = (state: ThreadState, storedId: string | null | undefined) =>
        storedId == null || storedId === "" || storedId === state.storedId
          ? Effect.void
          : Effect.suspend(() => {
              state.storedId = storedId;
              return updateProviderThread(state, { nativeThreadRef: providerRef(storedId) });
            });

      const connectionError = (cause: unknown) =>
        new ProviderAdapter.ProviderAdapterOpenSessionError({
          driver: HERMES_PROVIDER,
          providerSessionId: input.providerSessionId,
          cause,
        });

      // ── lease handling ────────────────────────────────────

      const cancelLeaseRelease = Effect.suspend(() => {
        const fiber = releaseFiber;
        releaseFiber = null;
        return fiber === null ? Effect.void : Fiber.interrupt(fiber).pipe(Effect.asVoid);
      });

      /** Detach and close the runtime session; the stored session stays resumable. */
      const closeRuntime = (state: ThreadState) =>
        Effect.gen(function* () {
          const runtime = state.runtime;
          if (runtime === null) return;
          state.runtime = null;
          state.applied = emptyApplied();
          runtime.connection.unbind(runtime.id, sink);
          if (runtime.connection.isAlive()) {
            yield* runtime.connection
              .request("session.close", { session_id: runtime.id }, { timeoutMs: CLOSE_TIMEOUT_MS })
              .pipe(
                Effect.tapError((error) =>
                  Effect.logDebug("Hermes session.close failed", { errorTag: error._tag }),
                ),
                Effect.ignore,
              );
          }
          yield* gateway.touch;
        });

      const scheduleLeaseRelease = (state: ThreadState) =>
        Effect.gen(function* () {
          yield* cancelLeaseRelease;
          releaseFiber = yield* Effect.sleep(leaseReleaseDelay).pipe(
            Effect.andThen(
              permit.withPermits(1)(
                Effect.suspend(() =>
                  threadState === state && state.activeTurn === null && pending.size === 0
                    ? closeRuntime(state)
                    : Effect.void,
                ),
              ),
            ),
            Effect.forkIn(scope),
          );
        });

      // ── runtime sessions ──────────────────────────────────

      const bindRuntime = (state: ThreadState, runtime: RuntimeBinding) => {
        state.runtime = runtime;
        state.applied = emptyApplied();
      };

      const createRuntime = (connection: HermesGatewayConnection) =>
        Effect.gen(function* () {
          const raw = yield* connection.request(
            "session.create",
            { cwd, cwd_explicit: true, cols: 100 },
            { bindSessionTo: sink, timeoutMs: SESSION_REQUEST_TIMEOUT_MS },
          );
          const result = decodeCreate(raw);
          if (Option.isNone(result)) {
            return yield* protocolError("session.create returned an unexpected result", raw);
          }
          return result.value;
        });

      const resumeRuntime = (state: ThreadState, connection: HermesGatewayConnection) =>
        Effect.gen(function* () {
          const raw = yield* connection.request(
            "session.resume",
            { session_id: state.storedId, omit_messages: true },
            { bindSessionTo: sink, timeoutMs: RESUME_TIMEOUT_MS },
          );
          const result = decodeResume(raw);
          if (Option.isNone(result)) {
            return yield* protocolError("session.resume returned an unexpected result", raw);
          }
          bindRuntime(state, { id: result.value.session_id, connection });
          state.persisted = true;
          yield* adoptStoredId(
            state,
            result.value.session_key ?? result.value.resumed ?? result.value.stored_session_id,
          );
          // A request left open from an earlier attachment is re-delivered as if live.
          for (const open of result.value.open_requests ?? []) {
            yield* Queue.offer(sink, {
              kind: "request",
              id: open.id,
              method: open.method,
              sessionId: result.value.session_id,
              params: open.params,
            });
          }
        });

      /** A live runtime session for the thread, resuming it after a lease release or restart. */
      const ensureRuntime = (state: ThreadState) =>
        Effect.gen(function* () {
          yield* cancelLeaseRelease;
          const connection = yield* gateway.connection.pipe(Effect.mapError(connectionError));
          if (state.runtime !== null && state.runtime.connection === connection) {
            return state.runtime;
          }
          state.runtime = null;
          if (!state.persisted) {
            // Never prompted: Hermes has no row to resume, and nothing was lost.
            const created = yield* createRuntime(connection);
            bindRuntime(state, { id: created.session_id, connection });
            yield* adoptStoredId(state, created.stored_session_id);
          } else {
            yield* resumeRuntime(state, connection);
          }
          return state.runtime!;
        });

      const sessionConfigSet = (runtime: RuntimeBinding, key: string, value: string) =>
        runtime.connection
          .request(
            "config.set",
            { session_id: runtime.id, key, value },
            { timeoutMs: SESSION_REQUEST_TIMEOUT_MS },
          )
          .pipe(
            Effect.flatMap((raw) =>
              key === "model" && recordField(raw, "confirm_required") === true
                ? runtime.connection.request(
                    "config.set",
                    { session_id: runtime.id, key, value, confirm_expensive_model: true },
                    { timeoutMs: SESSION_REQUEST_TIMEOUT_MS },
                  )
                : Effect.succeed(raw),
            ),
          );

      /** Apply the T3 selection and runtime mode through session-scoped keys only. */
      const applySelection = (
        state: ThreadState,
        runtime: RuntimeBinding,
        selection: ModelSelection,
        runtimeMode: RuntimeMode,
      ) =>
        Effect.gen(function* () {
          const model = hermesModelSwitchValue(selection.model);
          if (model !== null && model !== state.applied.model) {
            yield* sessionConfigSet(runtime, "model", model);
            state.applied.model = model;
            sessionEntity = { ...sessionEntity, model: selection.model };
          }
          const reasoning = getModelSelectionStringOptionValue(
            selection,
            HERMES_REASONING_OPTION_ID,
          );
          if (
            reasoning !== undefined &&
            HERMES_REASONING_EFFORTS.has(reasoning) &&
            reasoning !== state.applied.reasoning
          ) {
            yield* sessionConfigSet(runtime, "reasoning", reasoning);
            state.applied.reasoning = reasoning;
          }
          const fast = getModelSelectionBooleanOptionValue(selection, HERMES_FAST_OPTION_ID);
          if (fast !== undefined && fast !== state.applied.fast) {
            yield* sessionConfigSet(runtime, "fast", fast ? "fast" : "normal");
            state.applied.fast = fast;
          }
          // Full access auto-approves; other modes defer to the profile's approvals.mode.
          const yolo = runtimeMode === "full-access";
          if (yolo !== state.applied.yolo) {
            yield* sessionConfigSet(runtime, "yolo", yolo ? "on" : "off");
            state.applied.yolo = yolo;
          }
        });

      // ── turn items ────────────────────────────────────────

      const itemOrdinal = (turn: ActiveTurn, nativeItemId: string): number => {
        const existing = turn.itemOrdinals.get(nativeItemId);
        if (existing !== undefined) return existing;
        const ordinal = turn.nextItemOrdinal++;
        turn.itemOrdinals.set(nativeItemId, ordinal);
        return ordinal;
      };

      const baseItemFields = (
        turn: ActiveTurn,
        nativeItemId: string,
        startedAt: DateTime.Utc,
        updatedAt: DateTime.Utc,
      ) => ({
        id: idAllocator.derive.turnItemFromProviderItem({ driver: HERMES_PROVIDER, nativeItemId }),
        threadId: turn.turnInput.threadId,
        runId: turn.turnInput.runId,
        nodeId: idAllocator.derive.nodeFromProviderItem({ driver: HERMES_PROVIDER, nativeItemId }),
        providerThreadId: turn.turnInput.providerThread.id,
        providerTurnId: turn.providerTurn.id,
        nativeItemRef: providerRef(nativeItemId),
        parentItemId: null,
        ordinal: itemOrdinal(turn, nativeItemId),
        startedAt,
        updatedAt,
      });

      const emitItemNode = (
        turn: ActiveTurn,
        nativeItemId: string,
        kind: OrchestrationV2ExecutionNode["kind"],
        status: OrchestrationV2ExecutionNode["status"],
        startedAt: DateTime.Utc,
        completedAt: DateTime.Utc | null,
      ) =>
        emit({
          type: "node.updated",
          driver: HERMES_PROVIDER,
          node: {
            id: idAllocator.derive.nodeFromProviderItem({ driver: HERMES_PROVIDER, nativeItemId }),
            threadId: turn.turnInput.threadId,
            runId: turn.turnInput.runId,
            parentNodeId: turn.turnInput.rootNodeId,
            rootNodeId: turn.turnInput.rootNodeId,
            kind,
            status,
            countsForRun: false,
            providerThreadId: turn.turnInput.providerThread.id,
            providerTurnId: turn.providerTurn.id,
            nativeItemRef: providerRef(nativeItemId),
            runtimeRequestId: null,
            checkpointScopeId: null,
            startedAt,
            completedAt,
          },
        });

      const emitStreamItem = (turn: ActiveTurn, item: StreamItem, streaming: boolean) =>
        Effect.gen(function* () {
          const emittedAt = yield* DateTime.now;
          const status = streaming ? "running" : "completed";
          const completedAt = streaming ? null : emittedAt;
          yield* emitItemNode(
            turn,
            item.nativeItemId,
            item.kind,
            status,
            item.startedAt,
            completedAt,
          );
          const base = baseItemFields(turn, item.nativeItemId, item.startedAt, emittedAt);
          if (item.kind === "reasoning") {
            yield* emit({
              type: "turn_item.updated",
              driver: HERMES_PROVIDER,
              turnItem: {
                ...base,
                status,
                title: null,
                completedAt,
                type: "reasoning",
                text: item.text,
                streaming,
              },
            });
            return;
          }
          const messageId = idAllocator.derive.messageFromProviderItem({
            driver: HERMES_PROVIDER,
            nativeItemId: item.nativeItemId,
          });
          yield* emit({
            type: "turn_item.updated",
            driver: HERMES_PROVIDER,
            turnItem: {
              ...base,
              status,
              title: null,
              completedAt,
              type: "assistant_message",
              messageId,
              text: item.text,
              streaming,
            },
          });
          yield* emit({
            type: "message.updated",
            driver: HERMES_PROVIDER,
            message: {
              id: messageId,
              threadId: turn.turnInput.threadId,
              runId: turn.turnInput.runId,
              nodeId: base.nodeId,
              role: "assistant",
              text: item.text,
              attachments: [],
              streaming,
              createdBy: "agent",
              creationSource: "provider",
              createdAt: item.startedAt,
              updatedAt: emittedAt,
            },
          });
        });

      const completeStreamItem = (turn: ActiveTurn, item: StreamItem) =>
        Effect.suspend(() => {
          if (item.completed) return Effect.void;
          item.completed = true;
          if (turn.openText === item) turn.openText = null;
          if (turn.openReasoning === item) turn.openReasoning = null;
          return item.text.length === 0 ? Effect.void : emitStreamItem(turn, item, false);
        });

      const sealOpenItems = (turn: ActiveTurn) =>
        Effect.gen(function* () {
          if (turn.openReasoning !== null) yield* completeStreamItem(turn, turn.openReasoning);
          if (turn.openText !== null) yield* completeStreamItem(turn, turn.openText);
        });

      const openStreamItem = (turn: ActiveTurn, kind: StreamItem["kind"]) =>
        Effect.gen(function* () {
          const open = kind === "assistant_message" ? turn.openText : turn.openReasoning;
          if (open !== null) return open;
          // Reasoning and text alternate; a new kind closes the other.
          if (kind === "assistant_message" && turn.openReasoning !== null) {
            yield* completeStreamItem(turn, turn.openReasoning);
          }
          if (kind === "reasoning" && turn.openText !== null) {
            yield* completeStreamItem(turn, turn.openText);
          }
          turn.segment += 1;
          const item: StreamItem = {
            nativeItemId: `${turn.providerTurn.id}:${kind === "assistant_message" ? "text" : "reasoning"}:${turn.segment}`,
            kind,
            text: "",
            completed: false,
            flushScheduled: false,
            startedAt: yield* DateTime.now,
          };
          itemOrdinal(turn, item.nativeItemId);
          turn.streamItems.push(item);
          if (kind === "assistant_message") turn.openText = item;
          else turn.openReasoning = item;
          return item;
        });

      const scheduleFlush = (turn: ActiveTurn, item: StreamItem) =>
        Effect.gen(function* () {
          if (item.flushScheduled || item.completed) return;
          item.flushScheduled = true;
          yield* Effect.sleep(Duration.millis(STREAM_FLUSH_MS)).pipe(
            Effect.andThen(
              Effect.suspend(() => {
                item.flushScheduled = false;
                return item.completed ? Effect.void : emitStreamItem(turn, item, true);
              }),
            ),
            permit.withPermits(1),
            Effect.forkIn(scope),
          );
        });

      const appendStream = (turn: ActiveTurn, kind: StreamItem["kind"], text: string) =>
        Effect.gen(function* () {
          if (text.length === 0) return;
          const item = yield* openStreamItem(turn, kind);
          item.text += text;
          yield* scheduleFlush(turn, item);
        });

      const emitToolItem = (
        turn: ActiveTurn,
        input: {
          readonly toolId: string;
          readonly name: string;
          readonly args: Record<string, unknown> | null | undefined;
          readonly completed: boolean;
          readonly result?: unknown;
          readonly inlineDiff?: string | null | undefined;
        },
      ) =>
        Effect.gen(function* () {
          const emittedAt = yield* DateTime.now;
          const known = turn.tools.get(input.toolId);
          const startedAt = known?.startedAt ?? emittedAt;
          if (known === undefined) {
            turn.tools.set(input.toolId, { startedAt, name: input.name });
          }
          const nativeItemId = `tool:${input.toolId}`;
          const failed = input.completed && hermesToolFailed(input.result);
          const status = !input.completed
            ? "running"
            : failed
              ? turn.interrupted
                ? "interrupted"
                : "failed"
              : "completed";
          const completedAt = input.completed ? emittedAt : null;
          yield* emitItemNode(turn, nativeItemId, "tool_call", status, startedAt, completedAt);
          const shared = {
            ...baseItemFields(turn, nativeItemId, startedAt, emittedAt),
            status,
            completedAt,
          } as const;
          const args = input.args ?? {};
          const output = input.completed ? resultText(input.result) : undefined;
          if (input.name === "terminal") {
            const exitCode = recordField(input.result, "exit_code");
            const commandOutput =
              recordString(input.result, "output") ?? recordString(input.result, "error") ?? output;
            yield* emit({
              type: "turn_item.updated",
              driver: HERMES_PROVIDER,
              turnItem: {
                ...shared,
                title: input.name,
                type: "command_execution",
                input: recordString(args, "command") ?? "",
                ...(commandOutput === undefined ? {} : { output: boundedText(commandOutput) }),
                ...(typeof exitCode === "number" && Number.isInteger(exitCode) ? { exitCode } : {}),
              },
            });
            return;
          }
          const fileName = recordString(args, "path") ?? recordString(args, "file_path");
          if (
            (input.name === "write_file" || input.name === "patch" || input.name === "edit_file") &&
            fileName !== undefined &&
            fileName.trim().length > 0
          ) {
            const diffStr =
              input.inlineDiff != null && input.inlineDiff.length > 0
                ? stripAnsi(input.inlineDiff)
                : undefined;
            const newStr = input.name === "write_file" ? recordString(args, "content") : undefined;
            yield* emit({
              type: "turn_item.updated",
              driver: HERMES_PROVIDER,
              turnItem: {
                ...shared,
                title: input.name,
                type: "file_change",
                fileName,
                ...(diffStr === undefined ? {} : { diffStr }),
                ...(newStr === undefined ? {} : { newStr }),
              },
            });
            return;
          }
          yield* emit({
            type: "turn_item.updated",
            driver: HERMES_PROVIDER,
            turnItem: {
              ...shared,
              title: input.name,
              type: "dynamic_tool",
              ...mcpToolPresentation({ toolName: input.name }),
              toolName: input.name,
              input: args,
              ...(output === undefined ? {} : { output: boundedText(output) }),
            },
          });
        });

      const emitTodoList = (turn: ActiveTurn, todos: ReadonlyArray<unknown>) =>
        Effect.gen(function* () {
          const steps: Array<OrchestrationV2PlanStep> = [];
          for (const [index, raw] of todos.entries()) {
            const todo = decodeTodoItem(raw);
            if (Option.isNone(todo)) continue;
            const text = todo.value.content?.trim();
            if (!text) continue;
            steps.push({
              id: String(todo.value.id ?? index + 1),
              text,
              status: todoStepStatus(todo.value.status ?? undefined),
            });
          }
          const updatedAt = yield* DateTime.now;
          const planId =
            turn.planId ??
            (yield* idAllocator.allocate.plan({
              threadId: turn.turnInput.threadId,
              runId: turn.turnInput.runId,
              driver: HERMES_PROVIDER,
            }));
          turn.planId = planId;
          const nativeItemId = `${turn.providerTurn.id}:todo`;
          const nodeId = idAllocator.derive.nodeFromProviderItem({
            driver: HERMES_PROVIDER,
            nativeItemId,
          });
          const done = steps.length > 0 && steps.every((step) => step.status === "completed");
          yield* emitItemNode(turn, nativeItemId, "todo_list", "completed", updatedAt, updatedAt);
          yield* emit({
            type: "plan.updated",
            driver: HERMES_PROVIDER,
            plan: {
              id: planId,
              threadId: turn.turnInput.threadId,
              runId: turn.turnInput.runId,
              nodeId,
              kind: "todo_list",
              status: done ? "completed" : "active",
              steps,
            },
          });
          yield* emit({
            type: "turn_item.updated",
            driver: HERMES_PROVIDER,
            turnItem: {
              ...baseItemFields(turn, nativeItemId, updatedAt, updatedAt),
              status: "completed",
              title: null,
              completedAt: updatedAt,
              type: "todo_list",
              planId,
              steps,
            },
          });
        });

      const emitSubagent = (turn: ActiveTurn, eventType: string, payload: HermesSubagentPayload) =>
        Effect.gen(function* () {
          const nativeTaskId =
            payload.subagent_id ??
            `${payload.delegation_id ?? turn.providerTurn.id}:task:${payload.task_index ?? 0}`;
          const nativeItemId = `subagent:${nativeTaskId}`;
          const emittedAt = yield* DateTime.now;
          const startedAt = turn.subagents.get(nativeItemId) ?? emittedAt;
          turn.subagents.set(nativeItemId, startedAt);
          const status = subagentStatus(eventType, payload.status);
          const finished =
            status === "completed" || status === "failed" || status === "interrupted";
          const progressText = (
            payload.text ??
            payload.tool_preview ??
            (payload.tool_name == null ? undefined : `Using ${payload.tool_name}`)
          )?.trim();
          const progress =
            !finished && progressText ? { progress: progressText.slice(0, 200) } : {};
          const result = finished ? (payload.summary?.slice(0, 10_000) ?? null) : null;
          const subagentId = idAllocator.derive.nodeFromProviderItem({
            driver: HERMES_PROVIDER,
            nativeItemId,
          });
          const title = payload.goal.trim().slice(0, 120) || "Subagent";
          yield* emit({
            type: "subagent.updated",
            driver: HERMES_PROVIDER,
            subagent: {
              id: subagentId,
              threadId: turn.turnInput.threadId,
              runId: turn.turnInput.runId,
              parentNodeId: turn.turnInput.rootNodeId,
              origin: "provider_native",
              createdBy: "agent",
              driver: HERMES_PROVIDER,
              providerInstanceId: options.instanceId,
              providerThreadId: turn.turnInput.providerThread.id,
              childThreadId: null,
              nativeTaskRef: providerRef(nativeTaskId),
              prompt: payload.goal,
              title,
              model: payload.model ?? null,
              status,
              ...progress,
              result,
              startedAt,
              completedAt: finished ? emittedAt : null,
              updatedAt: emittedAt,
            },
          });
          yield* emit({
            type: "turn_item.updated",
            driver: HERMES_PROVIDER,
            turnItem: {
              ...baseItemFields(turn, nativeItemId, startedAt, emittedAt),
              status,
              title,
              completedAt: finished ? emittedAt : null,
              type: "subagent",
              subagentId,
              origin: "provider_native",
              driver: HERMES_PROVIDER,
              providerInstanceId: options.instanceId,
              childThreadId: null,
              prompt: payload.goal,
              ...progress,
              result,
            },
          });
        });

      const emitLeaseWait = (turn: ActiveTurn, text: string, finished: boolean) =>
        Effect.gen(function* () {
          const emittedAt = yield* DateTime.now;
          const wait = turn.leaseWait ?? {
            nativeItemId: `${turn.providerTurn.id}:lease-wait`,
            startedAt: emittedAt,
          };
          turn.leaseWait = finished ? null : wait;
          const status = finished ? "completed" : "running";
          yield* emitItemNode(
            turn,
            wait.nativeItemId,
            "system",
            status,
            wait.startedAt,
            finished ? emittedAt : null,
          );
          yield* emit({
            type: "turn_item.updated",
            driver: HERMES_PROVIDER,
            turnItem: {
              ...baseItemFields(turn, wait.nativeItemId, wait.startedAt, emittedAt),
              status,
              title: "Waiting for another Hermes client",
              completedAt: finished ? emittedAt : null,
              type: "system_notice",
              message: text,
            },
          });
          yield* updateProviderSession(finished ? "running" : "waiting", null);
        });

      const emitCompaction = (turn: ActiveTurn, finished: boolean) =>
        Effect.gen(function* () {
          const emittedAt = yield* DateTime.now;
          const compaction = turn.compaction ?? {
            nativeItemId: `${turn.providerTurn.id}:compaction:${turn.nextItemOrdinal}`,
            startedAt: emittedAt,
          };
          turn.compaction = finished ? null : compaction;
          const status = finished ? "completed" : "running";
          yield* emitItemNode(
            turn,
            compaction.nativeItemId,
            "system",
            status,
            compaction.startedAt,
            finished ? emittedAt : null,
          );
          yield* emit({
            type: "turn_item.updated",
            driver: HERMES_PROVIDER,
            turnItem: {
              ...baseItemFields(turn, compaction.nativeItemId, compaction.startedAt, emittedAt),
              status,
              title: finished ? "Context compacted" : "Compacting context...",
              completedAt: finished ? emittedAt : null,
              type: "compaction",
              driver: HERMES_PROVIDER,
            },
          });
        });

      // ── runtime requests ──────────────────────────────────

      const resolvePending = (
        request: PendingRequest,
        status: "resolved" | "cancelled" | "expired",
      ) =>
        Effect.gen(function* () {
          const resolvedAt = yield* DateTime.now;
          request.runtimeRequest = { ...request.runtimeRequest, status, resolvedAt };
          yield* emit({
            type: "runtime_request.updated",
            driver: HERMES_PROVIDER,
            threadId: request.node.threadId,
            runtimeRequest: request.runtimeRequest,
          });
          yield* emit({
            type: "node.updated",
            driver: HERMES_PROVIDER,
            node: {
              ...request.node,
              status: status === "resolved" ? "completed" : "cancelled",
              completedAt: resolvedAt,
            },
          });
          yield* emit({
            type: "turn_item.updated",
            driver: HERMES_PROVIDER,
            turnItem: {
              ...request.turnItem,
              status: status === "resolved" ? "completed" : "cancelled",
              completedAt: resolvedAt,
              updatedAt: resolvedAt,
            },
          });
        });

      const cancelPendingRequests = Effect.suspend(() => {
        const open = Array.from(pending.values());
        pending.clear();
        return Effect.forEach(open, (request) => resolvePending(request, "cancelled"), {
          discard: true,
        });
      });

      const handleServerRequest = (
        state: ThreadState,
        runtime: RuntimeBinding,
        frame: Extract<HermesInbound, { readonly kind: "request" }>,
      ) =>
        Effect.gen(function* () {
          const turn = state.activeTurn;
          if (frame.method === "approval") {
            const params = decodeApproval(frame.params);
            const choices = Option.isSome(params) ? (params.value.choices ?? []) : [];
            if (currentRuntimeMode === "full-access") {
              yield* runtime.connection
                .respond(frame.id, { result: { choice: "once" } })
                .pipe(Effect.ignore);
              return;
            }
            const command = Option.isSome(params) ? params.value.command?.trim() : undefined;
            const description = Option.isSome(params)
              ? params.value.description?.trim()
              : undefined;
            const prompt = [description, command === undefined ? undefined : `\`${command}\``]
              .filter((part): part is string => part !== undefined && part.length > 0)
              .join("\n\n");
            yield* openRuntimeRequest(state, runtime, frame, {
              kind: "approval",
              choices,
              questions: [],
              batch: false,
              title: Option.isSome(params) ? (params.value.tool_name ?? "Approval") : "Approval",
              item: (base) => ({
                ...base,
                type: "approval_request",
                requestId: base.requestId,
                requestKind: "command",
                prompt: prompt.length > 0 ? prompt : "Hermes needs approval to continue.",
                options: approvalOptions(choices.length > 0 ? choices : ["once", "deny"]),
              }),
              turn,
            });
            return;
          }
          const params = decodeClarify(frame.params);
          if (Option.isNone(params)) {
            yield* runtime.connection
              .respond(frame.id, { result: { answer: "" } })
              .pipe(Effect.ignore);
            return;
          }
          const batch = (params.value.questions ?? []).length > 0;
          const questions: ReadonlyArray<OrchestrationV2UserInputQuestion> = batch
            ? (params.value.questions ?? []).map((question) =>
                clarifyQuestion({
                  id: question.qid,
                  question: question.question,
                  choices: question.choices,
                  multiSelect: question.multi_select === true,
                }),
              )
            : [
                clarifyQuestion({
                  id: "answer",
                  question: params.value.question ?? "",
                  choices: params.value.choices,
                  multiSelect: params.value.multi_select === true,
                }),
              ];
          yield* openRuntimeRequest(state, runtime, frame, {
            kind: "clarify",
            choices: [],
            questions: questions.map((question) => ({
              id: question.id,
              multiSelect: question.multiSelect === true,
            })),
            batch,
            title: "Hermes has a question",
            item: (base) => ({
              ...base,
              type: "user_input_request",
              requestId: base.requestId,
              questions,
            }),
            turn,
          });
        });

      const openRuntimeRequest = (
        state: ThreadState,
        runtime: RuntimeBinding,
        frame: Extract<HermesInbound, { readonly kind: "request" }>,
        spec: {
          readonly kind: PendingRequest["kind"];
          readonly choices: ReadonlyArray<string>;
          readonly questions: PendingRequest["questions"];
          readonly batch: boolean;
          readonly title: string;
          readonly turn: ActiveTurn | null;
          readonly item: (base: ReturnType<typeof requestItemBase>) => OrchestrationV2TurnItem;
        },
      ) =>
        Effect.gen(function* () {
          const turn = spec.turn;
          const createdAt = yield* DateTime.now;
          const requestId = yield* idAllocator.allocate.runtimeRequest({
            driver: HERMES_PROVIDER,
            ...(turn === null ? {} : { providerTurnId: turn.providerTurn.id }),
            nativeRequestId: frame.id,
          });
          const nodeId = idAllocator.derive.approvalNode({ requestId });
          const threadId =
            turn?.turnInput.threadId ?? state.providerThread.appThreadId ?? input.threadId;
          const providerTurnId = turn?.providerTurn.id ?? null;
          const runtimeRequest: OrchestrationV2RuntimeRequest = {
            id: requestId,
            nodeId,
            providerTurnId,
            nativeRequestRef: providerRef(frame.id),
            kind: spec.kind === "approval" ? "command" : "user_input",
            status: "pending",
            responseCapability: { type: "live", providerSessionId: input.providerSessionId },
            createdAt,
            resolvedAt: null,
          };
          const node: OrchestrationV2ExecutionNode = {
            id: nodeId,
            threadId,
            runId: turn?.turnInput.runId ?? null,
            parentNodeId: turn?.turnInput.rootNodeId ?? null,
            rootNodeId: turn?.turnInput.rootNodeId ?? nodeId,
            kind: spec.kind === "approval" ? "approval_request" : "user_input_request",
            status: "waiting",
            countsForRun: false,
            providerThreadId: state.providerThread.id,
            providerTurnId,
            nativeItemRef: providerRef(frame.id),
            runtimeRequestId: requestId,
            checkpointScopeId: null,
            startedAt: createdAt,
            completedAt: null,
          };
          const turnItem = spec.item(
            requestItemBase({
              itemId: idAllocator.derive.approvalTurnItem({ requestId }),
              requestId,
              threadId,
              runId: turn?.turnInput.runId ?? null,
              nodeId,
              providerThreadId: state.providerThread.id,
              providerTurnId,
              nativeId: frame.id,
              ordinal: turn === null ? 0 : itemOrdinal(turn, `request:${frame.id}`),
              title: spec.title,
              createdAt,
            }),
          );
          pending.set(String(requestId), {
            nativeFrameId: frame.id,
            kind: spec.kind,
            runtimeId: runtime.id,
            choices: spec.choices,
            questions: spec.questions,
            batch: spec.batch,
            runtimeRequest,
            node,
            turnItem,
          });
          if (turn !== null) yield* sealOpenItems(turn);
          yield* emit({
            type: "runtime_request.updated",
            driver: HERMES_PROVIDER,
            threadId,
            runtimeRequest,
          });
          yield* emit({ type: "node.updated", driver: HERMES_PROVIDER, node });
          yield* emit({ type: "turn_item.updated", driver: HERMES_PROVIDER, turnItem });
        });

      // ── turn lifecycle ────────────────────────────────────

      const finalizeTurn = (state: ThreadState, status: "completed" | "interrupted" | "failed") =>
        Effect.gen(function* () {
          const turn = state.activeTurn;
          if (turn === null) return;
          state.activeTurn = null;
          const completedAt = yield* DateTime.now;
          for (const item of turn.streamItems) yield* completeStreamItem(turn, item);
          if (turn.leaseWait !== null) yield* emitLeaseWait(turn, "Resumed.", true);
          if (turn.compaction !== null) yield* emitCompaction(turn, true);
          yield* cancelPendingRequests;
          const failure =
            status === "failed"
              ? (turn.failure ?? makeProviderFailure({ message: "Hermes turn failed." }))
              : null;
          const finalStatus = turn.interrupted && status !== "completed" ? "interrupted" : status;
          yield* emit({
            type: "provider_turn.updated",
            driver: HERMES_PROVIDER,
            threadId: turn.turnInput.threadId,
            providerTurn: {
              ...turn.providerTurn,
              status: finalStatus,
              completedAt,
              ...(turn.tokenUsage === null ? {} : { tokenUsage: turn.tokenUsage }),
            },
          });
          yield* updateProviderThread(state, { status: "idle" });
          yield* updateProviderSession(
            failure !== null ? "error" : "ready",
            failure?.message ?? null,
          );
          if (failure !== null && finalStatus === "failed") {
            const failureItemId = `terminal-failure:${turn.providerTurn.id}`;
            yield* emit({
              type: "turn_item.updated",
              driver: HERMES_PROVIDER,
              turnItem: {
                ...baseItemFields(turn, failureItemId, completedAt, completedAt),
                status: "failed",
                title: null,
                completedAt,
                type: "error",
                failure,
              },
            });
            yield* emit({
              type: "turn.terminal",
              driver: HERMES_PROVIDER,
              providerThreadId: state.providerThread.id,
              providerTurnId: turn.providerTurn.id,
              runOrdinal: turn.turnInput.runOrdinal,
              failureItemOrdinal: itemOrdinal(turn, failureItemId),
              status: "failed",
              failure,
              threadDisposition: "reusable",
            });
          } else {
            yield* emit({
              type: "turn.terminal",
              driver: HERMES_PROVIDER,
              providerThreadId: state.providerThread.id,
              providerTurnId: turn.providerTurn.id,
              runOrdinal: turn.turnInput.runOrdinal,
              status: finalStatus === "interrupted" ? "interrupted" : "completed",
              failure: null,
              threadDisposition: "reusable",
            });
          }
          yield* scheduleLeaseRelease(state);
        });

      const failTurn = (state: ThreadState, failure: OrchestrationV2ProviderFailure) =>
        Effect.suspend(() => {
          const turn = state.activeTurn;
          if (turn === null) return Effect.void;
          turn.failure = failure;
          return finalizeTurn(state, "failed");
        });

      const handleMessageComplete = (state: ThreadState, turn: ActiveTurn, payload: unknown) =>
        Effect.gen(function* () {
          const complete = decodeComplete(payload);
          const value = Option.isSome(complete) ? complete.value : undefined;
          const finalText = value?.text ?? "";
          const textItems = turn.streamItems.filter((item) => item.kind === "assistant_message");
          const streamed = textItems.map((item) => item.text).join("");
          if (finalText.length > 0) {
            if (textItems.length === 0) {
              const item = yield* openStreamItem(turn, "assistant_message");
              item.text = finalText;
            } else if (value?.response_transformed === true || !finalText.startsWith(streamed)) {
              // The delivered text replaces what was streamed.
              const last = textItems[textItems.length - 1]!;
              const earlier = streamed.slice(0, streamed.length - last.text.length);
              last.text = finalText.startsWith(earlier)
                ? finalText.slice(earlier.length)
                : finalText;
              last.completed = false;
            } else if (finalText.length > streamed.length) {
              const last = textItems[textItems.length - 1]!;
              last.text += finalText.slice(streamed.length);
              last.completed = false;
            }
          }
          const updatedAt = yield* DateTime.now;
          const usage = tokenUsageFrom(value?.usage, updatedAt);
          if (usage !== undefined) turn.tokenUsage = usage;
          const status = value?.status ?? "complete";
          if (status === "interrupted") {
            turn.interrupted = true;
            yield* finalizeTurn(state, "interrupted");
            return;
          }
          if (status === "error") {
            const surface = value?.error_surface;
            const code = surface?.code ?? null;
            const isUsageLimit = code !== null && /rate|quota|limit|credit|billing/i.test(code);
            turn.failure = makeProviderFailure({
              message: value?.error ?? "Hermes reported an error.",
              code,
              class: isUsageLimit ? "usage_limit" : "provider_error",
              retryable: value?.recoverable ?? surface?.retryable ?? null,
              ...(isUsageLimit && typeof surface?.resets_at === "number"
                ? { resetAt: DateTime.formatIso(DateTime.makeUnsafe(surface.resets_at * 1_000)) }
                : {}),
            });
            yield* finalizeTurn(state, "failed");
            return;
          }
          yield* finalizeTurn(state, "completed");
        });

      const handleEvent = (
        state: ThreadState,
        frame: Extract<HermesInbound, { readonly kind: "event" }>,
      ) =>
        Effect.gen(function* () {
          const turn = state.activeTurn;
          const { payload } = frame;
          switch (frame.type) {
            case "session.info": {
              const info = decodeInfo(payload);
              if (Option.isNone(info)) return;
              yield* adoptStoredId(state, info.value.stored_session_id);
              // A turn that ended without message.complete (an error frame, or
              // a failure inside the turn) settles with running=false.
              if (
                turn !== null &&
                turn.sawMessageStart &&
                info.value.running === false &&
                turn.failure !== null
              ) {
                yield* finalizeTurn(state, "failed");
              }
              return;
            }
            case "session.title": {
              const title = decodeTitle(payload);
              if (Option.isNone(title) || title.value.title.trim() === "") return;
              yield* updateProviderThread(state, {
                nativeMetadata: {
                  ...state.providerThread.nativeMetadata,
                  title: title.value.title.trim(),
                },
              });
              return;
            }
            case "session.reclaimed": {
              const runtime = state.runtime;
              if (runtime !== null) runtime.connection.unbind(runtime.id, sink);
              state.runtime = null;
              yield* failTurn(
                state,
                makeProviderFailure({
                  message: "Hermes reclaimed this session. Send the message again to resume it.",
                  class: "transport_error",
                  retryable: true,
                }),
              );
              return;
            }
            case "request.cancel": {
              const cancel = decodeRequestCancel(payload);
              if (Option.isNone(cancel)) return;
              for (const [key, request] of pending) {
                if (request.nativeFrameId !== cancel.value.id) continue;
                pending.delete(key);
                yield* resolvePending(
                  request,
                  cancel.value.reason === "timeout" ? "expired" : "cancelled",
                );
              }
              return;
            }
          }
          if (turn === null) return;
          switch (frame.type) {
            case "message.start":
              turn.sawMessageStart = true;
              if (turn.leaseWait !== null) yield* emitLeaseWait(turn, "Resumed.", true);
              return;
            case "message.delta": {
              const delta = decodeText(payload);
              if (Option.isSome(delta)) {
                yield* appendStream(turn, "assistant_message", delta.value.text);
              }
              return;
            }
            case "reasoning.delta": {
              const delta = decodeText(payload);
              if (Option.isSome(delta)) yield* appendStream(turn, "reasoning", delta.value.text);
              return;
            }
            case "reasoning.available": {
              const block = decodeText(payload);
              if (Option.isNone(block) || block.value.text.length === 0) return;
              const item = yield* openStreamItem(turn, "reasoning");
              item.text = block.value.text;
              yield* completeStreamItem(turn, item);
              return;
            }
            case "message.interim": {
              const interim = decodeInterim(payload);
              if (Option.isNone(interim)) return;
              if (interim.value.already_streamed !== true && interim.value.text.length > 0) {
                const item = yield* openStreamItem(turn, "assistant_message");
                item.text += interim.value.text;
              }
              // Commentary beside tool calls is its own segment.
              if (turn.openText !== null) yield* completeStreamItem(turn, turn.openText);
              return;
            }
            case "tool.start": {
              const start = decodeToolStart(payload);
              if (Option.isNone(start)) return;
              yield* sealOpenItems(turn);
              // Todo and clarify have dedicated plan and question items.
              if (start.value.name === "todo" || start.value.name === "clarify") return;
              yield* emitToolItem(turn, {
                toolId: start.value.tool_id,
                name: start.value.name,
                args: start.value.args,
                completed: false,
              });
              return;
            }
            case "tool.complete": {
              const complete = decodeToolComplete(payload);
              if (Option.isNone(complete)) return;
              if (complete.value.name === "todo" || complete.value.name === "clarify") return;
              yield* emitToolItem(turn, {
                toolId: complete.value.tool_id,
                name: complete.value.name,
                args: complete.value.args,
                completed: true,
                result: complete.value.result,
                inlineDiff: complete.value.inline_diff,
              });
              return;
            }
            case "todo.updated": {
              const todos = decodeTodoUpdated(payload);
              if (Option.isSome(todos)) yield* emitTodoList(turn, todos.value.todos);
              return;
            }
            case "subagent.spawn_requested":
            case "subagent.start":
            case "subagent.thinking":
            case "subagent.tool":
            case "subagent.progress":
            case "subagent.complete": {
              const subagent = decodeSubagent(payload);
              if (Option.isSome(subagent)) yield* emitSubagent(turn, frame.type, subagent.value);
              return;
            }
            case "status.update": {
              const status = decodeStatus(payload);
              if (Option.isNone(status)) return;
              if (status.value.text.includes(HERMES_LEASE_WAIT_MARKER)) {
                yield* emitLeaseWait(turn, status.value.text, false);
                return;
              }
              if (status.value.kind === "compacting") {
                yield* emitCompaction(turn, false);
                return;
              }
              if (status.value.text.trim() === "ready" && turn.compaction !== null) {
                yield* emitCompaction(turn, true);
              }
              return;
            }
            case "session.usage": {
              const usage = decodeUsage(payload);
              if (Option.isNone(usage)) return;
              const updatedAt = yield* DateTime.now;
              const tokenUsage = tokenUsageFrom(usage.value.usage, updatedAt);
              if (tokenUsage === undefined || tokenUsage.usedTokens === turn.tokenUsage?.usedTokens)
                return;
              turn.tokenUsage = tokenUsage;
              yield* emit({
                type: "provider_turn.updated",
                driver: HERMES_PROVIDER,
                threadId: turn.turnInput.threadId,
                providerTurn: { ...turn.providerTurn, tokenUsage },
              });
              return;
            }
            case "message.complete":
              yield* handleMessageComplete(state, turn, payload);
              return;
            case "error": {
              const error = decodeError(payload);
              const failure = makeProviderFailure({
                message: Option.isSome(error) ? error.value.message : "Hermes reported an error.",
                class: "provider_error",
              });
              turn.failure = failure;
              // Before message.start the turn never ran; nothing else will end it.
              if (!turn.sawMessageStart) yield* finalizeTurn(state, "failed");
              return;
            }
            default:
              return;
          }
        });

      const handleInbound = (frame: HermesInbound) =>
        Effect.gen(function* () {
          const state = threadState;
          const runtime = state?.runtime ?? null;
          if (state === null || runtime === null || frame.sessionId !== runtime.id) return;
          switch (frame.kind) {
            case "lost":
              state.runtime = null;
              yield* failTurn(
                state,
                makeProviderFailure({
                  message:
                    "The Hermes gateway stopped unexpectedly. Send the message again to resume.",
                  class: "transport_error",
                  retryable: true,
                }),
              );
              return;
            case "request":
              yield* handleServerRequest(state, runtime, frame);
              return;
            case "event":
              yield* handleEvent(state, frame);
              return;
          }
        });

      yield* Queue.take(sink).pipe(
        Effect.flatMap((frame) =>
          permit.withPermits(1)(
            handleInbound(frame).pipe(
              Effect.catchCause((cause) =>
                Effect.logWarning("Hermes event handling failed", { cause }),
              ),
            ),
          ),
        ),
        Effect.forever,
        Effect.forkIn(scope),
      );

      // Releasing the T3 session ends the lease without touching the stored session.
      yield* Scope.addFinalizer(
        scope,
        Effect.suspend(() => {
          const state = threadState;
          return cancelLeaseRelease.pipe(
            Effect.andThen(state === null ? Effect.void : closeRuntime(state)),
          );
        }).pipe(Effect.ignore),
      );

      // ── session runtime ───────────────────────────────────

      const newProviderThread = (
        threadId: ProviderAdapter.ProviderAdapterV2EnsureThreadInput["threadId"],
        storedId: string,
        existing: OrchestrationV2ProviderThread | undefined,
        createdAt: DateTime.Utc,
      ): OrchestrationV2ProviderThread =>
        existing !== undefined
          ? {
              ...existing,
              providerSessionId: input.providerSessionId,
              nativeThreadRef: providerRef(storedId),
              status: "idle",
              updatedAt: createdAt,
            }
          : {
              id: idAllocator.derive.providerThread({
                driver: HERMES_PROVIDER,
                nativeThreadId: storedId,
              }),
              driver: HERMES_PROVIDER,
              providerInstanceId: options.instanceId,
              providerSessionId: input.providerSessionId,
              appThreadId: threadId,
              ownerNodeId: null,
              nativeThreadRef: providerRef(storedId),
              nativeConversationHeadRef: null,
              status: "idle",
              firstRunOrdinal: null,
              lastRunOrdinal: null,
              handoffIds: [],
              forkedFrom: null,
              pendingBackgroundTasks: [],
              createdAt,
              updatedAt: createdAt,
            };

      const assertIdle = (operation: string) =>
        threadState?.activeTurn != null
          ? Effect.fail(protocolError(`Cannot ${operation} while a Hermes turn is active`))
          : Effect.void;

      /** Detach whatever thread this session hosted before binding another. */
      const replaceThread = Effect.suspend(() => {
        const previous = threadState;
        threadState = null;
        return previous === null ? Effect.void : closeRuntime(previous);
      });

      const createThread = (threadInput: ProviderAdapter.ProviderAdapterV2EnsureThreadInput) =>
        permit.withPermits(1)(
          Effect.gen(function* () {
            yield* assertIdle("create a thread");
            yield* cancelLeaseRelease;
            yield* replaceThread;
            const connection = yield* gateway.connection.pipe(Effect.mapError(connectionError));
            const created = yield* createRuntime(connection);
            const createdAt = yield* DateTime.now;
            const providerThread = newProviderThread(
              threadInput.threadId,
              created.stored_session_id,
              threadInput.existingProviderThread,
              createdAt,
            );
            const state: ThreadState = {
              providerThread,
              storedId: created.stored_session_id,
              runtime: { id: created.session_id, connection },
              persisted: false,
              activeTurn: null,
              applied: emptyApplied(),
            };
            threadState = state;
            // Publish the durable id right away so session sync never imports
            // this conversation as a second thread.
            yield* emit({
              type: "provider_thread.updated",
              driver: HERMES_PROVIDER,
              providerThread,
            });
            return providerThread;
          }),
        );

      const resumeThread = (providerThread: OrchestrationV2ProviderThread, threadId: ThreadId) =>
        permit.withPermits(1)(
          Effect.gen(function* () {
            yield* assertIdle("resume a thread");
            const storedId = providerThread.nativeThreadRef?.nativeId;
            if (storedId == null) {
              return yield* protocolError("Hermes thread has no stored session id");
            }
            const current = threadState;
            if (
              current !== null &&
              current.providerThread.id === providerThread.id &&
              current.storedId === storedId
            ) {
              yield* ensureRuntime(current);
              return current.providerThread;
            }
            yield* cancelLeaseRelease;
            yield* replaceThread;
            const state: ThreadState = {
              providerThread: {
                ...providerThread,
                appThreadId: providerThread.appThreadId ?? threadId,
                providerSessionId: input.providerSessionId,
              },
              storedId,
              runtime: null,
              persisted: true,
              activeTurn: null,
              applied: emptyApplied(),
            };
            threadState = state;
            yield* ensureRuntime(state).pipe(
              Effect.tapError(() =>
                Effect.sync(() => {
                  if (threadState === state) threadState = null;
                }),
              ),
            );
            // Resuming claims no lease; Hermes leases from the first prompt.
            return state.providerThread;
          }),
        );

      const resolvePrompt = (text: string, attachments: ReadonlyArray<ChatAttachment>) => {
        const images: Array<string> = [];
        const pdfs: Array<string> = [];
        const notes: Array<string> = [];
        for (const attachment of attachments) {
          const path = resolveAttachmentPath({
            attachmentsDir: options.serverConfig.attachmentsDir,
            attachment,
          });
          if (path === null) continue;
          if (attachment.mimeType.startsWith("image/")) images.push(path);
          else if (attachment.mimeType === "application/pdf") pdfs.push(path);
          // Other files stay outside the workspace; Hermes reads them by path
          // under its own tool permissions.
          else notes.push(`[Attachment saved at ${path}]`);
        }
        const message = notes.length === 0 ? text : `${text}\n\n${notes.join("\n")}`;
        return { message, images, pdfs };
      };

      const runtime: ProviderAdapter.ProviderAdapterV2SessionRuntime = {
        instanceId: options.instanceId,
        driver: HERMES_PROVIDER,
        providerSessionId: input.providerSessionId,
        get providerSession() {
          return sessionEntity;
        },
        events: Stream.fromQueue(events),
        ensureThread: (threadInput) =>
          (threadInput.existingProviderThread?.nativeThreadRef?.nativeId != null
            ? resumeThread(threadInput.existingProviderThread, threadInput.threadId)
            : createThread(threadInput)
          ).pipe(
            Effect.mapError(
              (cause) =>
                new ProviderAdapter.ProviderAdapterEnsureThreadError({
                  driver: HERMES_PROVIDER,
                  threadId: threadInput.threadId,
                  cause,
                }),
            ),
          ),
        resumeThread: (threadInput) =>
          resumeThread(
            threadInput.providerThread,
            threadInput.threadId ?? threadInput.providerThread.appThreadId ?? input.threadId,
          ).pipe(
            Effect.mapError(
              (cause) =>
                new ProviderAdapter.ProviderAdapterResumeThreadError({
                  driver: HERMES_PROVIDER,
                  providerSessionId: input.providerSessionId,
                  providerThreadId: threadInput.providerThread.id,
                  cause,
                }),
            ),
          ),
        startTurn: (turnInput) =>
          Effect.gen(function* () {
            const state = threadState;
            if (state === null) return yield* protocolError("Hermes session has no thread");
            if (state.activeTurn !== null) {
              return yield* protocolError("Hermes thread already has an active turn");
            }
            if (
              turnInput.providerThread.id !== state.providerThread.id &&
              turnInput.providerThread.nativeThreadRef?.nativeId !== state.storedId
            ) {
              return yield* protocolError("Hermes turn requested for a different thread");
            }
            // Adopt the orchestrator's row identity (a fork is adopted under
            // its pre-allocated row) while keeping the live stored id.
            state.providerThread = {
              ...turnInput.providerThread,
              nativeThreadRef: providerRef(state.storedId),
            };
            currentRuntimeMode = turnInput.runtimePolicy.runtimeMode;
            const prompt = resolvePrompt(turnInput.message.text, turnInput.message.attachments);
            const startedAt = yield* DateTime.now;
            const syntheticTurnId = `${state.providerThread.id}:attempt:${turnInput.attemptId}`;
            const providerTurn: OrchestrationV2ProviderTurn = {
              id: idAllocator.derive.providerTurn({
                driver: HERMES_PROVIDER,
                nativeTurnId: syntheticTurnId,
              }),
              providerThreadId: turnInput.providerThread.id,
              nodeId: turnInput.rootNodeId,
              runAttemptId: turnInput.attemptId,
              nativeTurnRef: providerRef(syntheticTurnId, "weak"),
              ordinal: turnInput.providerTurnOrdinal,
              status: "running",
              startedAt,
              completedAt: null,
            };
            const turn: ActiveTurn = {
              turnInput,
              providerTurn,
              itemOrdinals: new Map(),
              nextItemOrdinal: 1,
              segment: 0,
              openText: null,
              openReasoning: null,
              streamItems: [],
              tools: new Map(),
              subagents: new Map(),
              planId: null,
              leaseWait: null,
              compaction: null,
              sawMessageStart: false,
              interrupted: false,
              failure: null,
              tokenUsage: null,
            };
            yield* permit.withPermits(1)(
              Effect.gen(function* () {
                state.activeTurn = turn;
                yield* emit({
                  type: "provider_turn.updated",
                  driver: HERMES_PROVIDER,
                  threadId: turnInput.threadId,
                  providerTurn,
                });
                yield* updateProviderThread(state, {
                  status: "active",
                  firstRunOrdinal: state.providerThread.firstRunOrdinal ?? turnInput.runOrdinal,
                  lastRunOrdinal: turnInput.runOrdinal,
                });
                yield* updateProviderSession("running", null);
              }),
            );
            const submit = Effect.gen(function* () {
              const live = yield* ensureRuntime(state);
              yield* applySelection(
                state,
                live,
                turnInput.modelSelection,
                turnInput.runtimePolicy.runtimeMode,
              );
              for (const path of prompt.images) {
                yield* live.connection.request("image.attach", { session_id: live.id, path });
              }
              for (const path of prompt.pdfs) {
                yield* live.connection.request(
                  "pdf.attach",
                  { session_id: live.id, path },
                  { timeoutMs: SESSION_REQUEST_TIMEOUT_MS },
                );
              }
              // queued: a T3 follow-up racing Hermes' post-turn work is queued
              // by Hermes instead of interrupting it.
              yield* live.connection.request(
                "prompt.submit",
                { session_id: live.id, text: prompt.message, queued: true },
                { timeoutMs: SESSION_REQUEST_TIMEOUT_MS },
              );
              state.persisted = true;
            });
            // A runtime lost between turns (gateway restart) is resumed once.
            // Held under the event permit so frames for a freshly resumed
            // runtime wait until it is bound.
            yield* submit.pipe(
              Effect.catchIf(
                (error) =>
                  isHermesRpcError(error) && error.code === HERMES_RPC_ERROR.sessionNotFound,
                () =>
                  Effect.suspend(() => {
                    state.runtime = null;
                    return submit;
                  }),
              ),
              Effect.catch((error) =>
                failTurn(
                  state,
                  isHermesRpcError(error) && error.code === HERMES_RPC_ERROR.activeSessionRefused
                    ? makeProviderFailure({
                        message: HERMES_SESSION_NOT_OWNED_MESSAGE,
                        code: error.reason ?? "SESSION_NOT_OWNED",
                        class: "provider_error",
                        retryable: true,
                      })
                    : makeProviderFailure({
                        cause: error,
                        message: isHermesRpcError(error) ? error.detail : error.message,
                        class: isHermesRpcError(error) ? "provider_error" : "transport_error",
                      }),
                ),
              ),
              permit.withPermits(1),
            );
          }).pipe(
            Effect.mapError(
              (cause) =>
                new ProviderAdapter.ProviderAdapterTurnStartError({
                  driver: HERMES_PROVIDER,
                  threadId: turnInput.threadId,
                  providerThreadId: turnInput.providerThread.id,
                  runId: turnInput.runId,
                  cause,
                }),
            ),
          ),
        steerTurn: (steerInput) =>
          Effect.gen(function* () {
            const state = threadState;
            const turn = state?.activeTurn ?? null;
            const live = state?.runtime ?? null;
            if (
              turn === null ||
              live === null ||
              turn.providerTurn.id !== steerInput.providerTurnId
            ) {
              return yield* protocolError(`Hermes turn ${steerInput.providerTurnId} is not active`);
            }
            const prompt = resolvePrompt(steerInput.message.text, steerInput.message.attachments);
            // Steering is text-only; staged images would ride the next turn.
            const attachedPaths = [...prompt.images, ...prompt.pdfs].map(
              (path) => `[Attachment saved at ${path}]`,
            );
            const text =
              attachedPaths.length === 0
                ? prompt.message
                : `${prompt.message}\n\n${attachedPaths.join("\n")}`;
            const raw = yield* live.connection.request(
              "session.steer",
              { session_id: live.id, text },
              { timeoutMs: SESSION_REQUEST_TIMEOUT_MS },
            );
            const result = decodeCorrection(raw);
            if (Option.isSome(result) && result.value.status === "rejected") {
              return yield* protocolError("Hermes rejected the steer because the turn has ended");
            }
          }).pipe(
            Effect.mapError(
              (cause) =>
                new ProviderAdapter.ProviderAdapterSteerRunError({
                  driver: HERMES_PROVIDER,
                  providerThreadId: steerInput.providerThread.id,
                  providerTurnId: steerInput.providerTurnId,
                  cause,
                }),
            ),
          ),
        interruptTurn: (interruptInput) =>
          Effect.gen(function* () {
            const state = threadState;
            const turn = state?.activeTurn ?? null;
            if (turn === null) return;
            if (turn.providerTurn.id !== interruptInput.providerTurnId) {
              return yield* protocolError(
                `Hermes turn ${interruptInput.providerTurnId} is not active`,
              );
            }
            turn.interrupted = true;
            const live = state!.runtime;
            if (live === null) {
              yield* permit.withPermits(1)(finalizeTurn(state!, "interrupted"));
              return;
            }
            const raw = yield* live.connection.request(
              "session.interrupt",
              { session_id: live.id },
              { timeoutMs: SESSION_REQUEST_TIMEOUT_MS },
            );
            // Nothing was running (the turn was still waiting to start): no
            // message.complete will follow.
            if (recordString(raw, "status") === "not_interrupted" && !turn.sawMessageStart) {
              yield* permit.withPermits(1)(finalizeTurn(state!, "interrupted"));
            }
          }).pipe(
            Effect.mapError(
              (cause) =>
                new ProviderAdapter.ProviderAdapterInterruptError({
                  driver: HERMES_PROVIDER,
                  providerThreadId: interruptInput.providerThread.id,
                  providerTurnId: interruptInput.providerTurnId,
                  cause,
                }),
            ),
          ),
        respondToRuntimeRequest: (requestInput) =>
          permit
            .withPermits(1)(
              Effect.gen(function* () {
                const request = pending.get(String(requestInput.requestId));
                const live = threadState?.runtime ?? null;
                if (request === undefined) {
                  return yield* protocolError(
                    `No pending Hermes request ${requestInput.requestId}`,
                  );
                }
                if (live === null || live.id !== request.runtimeId) {
                  pending.delete(String(requestInput.requestId));
                  yield* resolvePending(request, "expired");
                  return yield* protocolError("The Hermes session that asked this has ended");
                }
                const result =
                  request.kind === "approval"
                    ? { choice: hermesApprovalChoice(requestInput.decision, request.choices) }
                    : clarifyResult(request, requestInput.answers);
                yield* live.connection.respond(request.nativeFrameId, { result });
                pending.delete(String(requestInput.requestId));
                yield* resolvePending(request, "resolved");
              }),
            )
            .pipe(
              Effect.mapError(
                (cause) =>
                  new ProviderAdapter.ProviderAdapterRuntimeRequestResponseError({
                    driver: HERMES_PROVIDER,
                    requestId: requestInput.requestId,
                    cause,
                  }),
              ),
            ),
        readThreadSnapshot: (snapshotInput) =>
          permit
            .withPermits(1)(
              Effect.gen(function* () {
                const state = threadState;
                const wanted = snapshotInput.providerThread.nativeThreadRef?.nativeId;
                if (state === null || wanted == null || wanted !== state.storedId) {
                  return yield* protocolError(
                    "Hermes snapshot requested for a thread this session does not host",
                  );
                }
                const live = yield* ensureRuntime(state);
                const raw = yield* live.connection.request(
                  "session.history",
                  { session_id: live.id },
                  { timeoutMs: RESUME_TIMEOUT_MS },
                );
                const history = decodeHistory(raw);
                const threadId = state.providerThread.appThreadId ?? input.threadId;
                const messages = (Option.isSome(history) ? history.value.messages : []).flatMap(
                  (message, index) => {
                    if (message.role !== "user" && message.role !== "assistant") return [];
                    const text = message.text ?? "";
                    if (text.length === 0) return [];
                    const at = Option.getOrElse(
                      DateTime.make(
                        typeof message.timestamp === "number"
                          ? message.timestamp * 1_000
                          : Number.NaN,
                      ),
                      () => state.providerThread.createdAt,
                    );
                    return [
                      {
                        id: idAllocator.derive.messageFromProviderItem({
                          driver: HERMES_PROVIDER,
                          nativeItemId: `${state.storedId}:history:${message.row_id ?? index}`,
                        }),
                        threadId,
                        runId: null,
                        nodeId: null,
                        role: message.role === "user" ? ("user" as const) : ("assistant" as const),
                        text,
                        attachments: [],
                        streaming: false,
                        createdBy: message.role === "user" ? ("user" as const) : ("agent" as const),
                        creationSource: "provider" as const,
                        createdAt: at,
                        updatedAt: at,
                      },
                    ];
                  },
                );
                return {
                  providerThread: state.providerThread,
                  providerTurns: [],
                  messages,
                  runtimeRequests: [],
                };
              }),
            )
            .pipe(
              Effect.mapError(
                (cause) =>
                  new ProviderAdapter.ProviderAdapterReadThreadSnapshotError({
                    driver: HERMES_PROVIDER,
                    providerThreadId: snapshotInput.providerThread.id,
                    cause,
                  }),
              ),
            ),
        rollbackThread: (rollbackInput) =>
          Effect.fail(
            new ProviderAdapter.ProviderAdapterRollbackThreadError({
              driver: HERMES_PROVIDER,
              providerThreadId: rollbackInput.providerThread.id,
              checkpointId: rollbackInput.target.checkpointId,
              cause: "Hermes cannot rewind a conversation.",
            }),
          ),
        forkThread: (forkInput) =>
          permit
            .withPermits(1)(
              Effect.gen(function* () {
                yield* assertIdle("fork");
                const source = forkInput.sourceProviderThread;
                const parentId = source.nativeThreadRef?.nativeId;
                if (parentId == null) {
                  return yield* protocolError("Hermes fork source has no stored session id");
                }
                // Hermes branches whole conversations. A turn target is accepted
                // only when it is the source's latest turn (a head fork).
                if (forkInput.providerTurnId !== undefined) {
                  const sourceTurns = (forkInput.sourceProviderTurns ?? []).filter(
                    (turn) => turn.providerThreadId === source.id,
                  );
                  const latest = sourceTurns.reduce<OrchestrationV2ProviderTurn | undefined>(
                    (best, turn) =>
                      best === undefined || turn.ordinal > best.ordinal ? turn : best,
                    undefined,
                  );
                  if (latest !== undefined && latest.id !== forkInput.providerTurnId) {
                    return yield* protocolError(
                      "Hermes can only fork a whole conversation, not an earlier turn",
                    );
                  }
                }
                yield* cancelLeaseRelease;
                yield* replaceThread;
                const connection = yield* gateway.connection.pipe(Effect.mapError(connectionError));
                const forkCwd = forkInput.runtimePolicy?.cwd ?? cwd;
                const raw = yield* connection.request(
                  "session.branch_stored",
                  { parent_session_id: parentId, cols: 100, ...(forkCwd ? { cwd: forkCwd } : {}) },
                  { bindSessionTo: sink, timeoutMs: RESUME_TIMEOUT_MS },
                );
                const branched = decodeBranchStored(raw);
                if (Option.isNone(branched)) {
                  return yield* protocolError(
                    "session.branch_stored returned an unexpected result",
                    raw,
                  );
                }
                const childId = branched.value.stored_session_id;
                if (childId === parentId) {
                  return yield* protocolError("Hermes did not create a distinct branch session");
                }
                const createdAt = yield* DateTime.now;
                const providerThread: OrchestrationV2ProviderThread = {
                  ...source,
                  id: idAllocator.derive.providerThread({
                    driver: HERMES_PROVIDER,
                    nativeThreadId: childId,
                  }),
                  providerInstanceId: options.instanceId,
                  providerSessionId: input.providerSessionId,
                  appThreadId: forkInput.targetThreadId,
                  ownerNodeId: forkInput.ownerNodeId ?? null,
                  nativeThreadRef: providerRef(childId),
                  nativeConversationHeadRef: null,
                  status: "idle",
                  firstRunOrdinal: null,
                  lastRunOrdinal: null,
                  handoffIds: [],
                  pendingBackgroundTasks: [],
                  contextUsage: null,
                  forkedFrom: {
                    providerThreadId: source.id,
                    ...(forkInput.providerTurnId === undefined
                      ? {}
                      : { providerTurnId: forkInput.providerTurnId }),
                  },
                  createdAt,
                  updatedAt: createdAt,
                };
                const state: ThreadState = {
                  providerThread,
                  storedId: childId,
                  runtime: { id: branched.value.session_id, connection },
                  // branch_stored persists the child row immediately.
                  persisted: true,
                  activeTurn: null,
                  applied: emptyApplied(),
                };
                threadState = state;
                return providerThread;
              }),
            )
            .pipe(
              Effect.mapError(
                (cause) =>
                  new ProviderAdapter.ProviderAdapterForkThreadError({
                    driver: HERMES_PROVIDER,
                    providerThreadId: forkInput.sourceProviderThread.id,
                    cause,
                  }),
              ),
            ),
      };
      return runtime;
    }),
  });
}

function requestItemBase(input: {
  readonly itemId: TurnItemId;
  readonly requestId: RuntimeRequestId;
  readonly threadId: ThreadId;
  readonly runId: RunId | null;
  readonly nodeId: NodeId;
  readonly providerThreadId: ProviderThreadId | null;
  readonly providerTurnId: ProviderTurnId | null;
  readonly nativeId: string;
  readonly ordinal: number;
  readonly title: string;
  readonly createdAt: DateTime.Utc;
}) {
  return {
    id: input.itemId,
    requestId: input.requestId,
    threadId: input.threadId,
    runId: input.runId,
    nodeId: input.nodeId,
    providerThreadId: input.providerThreadId,
    providerTurnId: input.providerTurnId,
    nativeItemRef: providerRef(input.nativeId),
    parentItemId: null,
    ordinal: input.ordinal,
    status: "waiting" as const,
    title: input.title,
    startedAt: input.createdAt,
    completedAt: null,
    updatedAt: input.createdAt,
  };
}

function clarifyResult(
  request: PendingRequest,
  answers: ProviderUserInputAnswers | undefined,
): Record<string, unknown> {
  if (!request.batch) {
    const question = request.questions[0];
    return {
      answer: answerText(
        question === undefined ? undefined : answers?.[question.id],
        question?.multiSelect ?? false,
      ),
    };
  }
  return {
    answers: Object.fromEntries(
      request.questions.map((question) => [
        question.id,
        answerText(answers?.[question.id], question.multiSelect),
      ]),
    ),
  };
}

// ── driver ────────────────────────────────────────────────────

export type HermesAdapterV2DriverEnv =
  | ChildProcessSpawner.ChildProcessSpawner
  | Path.Path
  | IdAllocator.IdAllocatorV2
  | ServerConfig.ServerConfig;

/** Build the adapter around an instance gateway (the driver shares it with the probe). */
export const makeHermesAdapterV2WithGateway = Effect.fnUntraced(function* (input: {
  readonly instanceId: ProviderInstanceId;
  readonly gateway: HermesGateway;
}) {
  const idAllocator = yield* IdAllocator.IdAllocatorV2;
  const serverConfig = yield* ServerConfig.ServerConfig;
  return makeHermesAdapterV2({
    instanceId: input.instanceId,
    gateway: input.gateway,
    idAllocator,
    serverConfig,
  });
});

export const HermesAdapterV2Driver: ProviderAdapterDriver<
  HermesSettings,
  HermesAdapterV2DriverEnv
> = {
  driverKind: HERMES_PROVIDER,
  configSchema: HermesSettings,
  defaultConfig: (): HermesSettings => DEFAULT_HERMES_SETTINGS,
  create: Effect.fn("HermesAdapterV2Driver.create")(
    function* (input: ProviderAdapterDriverCreateInput<HermesSettings>) {
      const hostEnvironment = yield* HostProcessEnvironment;
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const path = yield* Path.Path;
      const gateway = yield* makeHermesGateway({
        launch: resolveHermesLaunch(
          path,
          input.config,
          mergeProviderInstanceEnvironment(input.environment, hostEnvironment),
        ),
        spawner,
      });
      return yield* makeHermesAdapterV2WithGateway({ instanceId: input.instanceId, gateway });
    },
    (effect, input) =>
      effect.pipe(
        Effect.mapError(
          (cause) =>
            new ProviderAdapterDriverCreateError({
              driver: HERMES_PROVIDER,
              instanceId: input.instanceId,
              detail: "Failed to create Hermes adapter.",
              cause,
            }),
        ),
      ),
  ),
};
