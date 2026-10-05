import * as Schema from "effect/Schema";
import * as Rpc from "effect/unstable/rpc/Rpc";

import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  EnvironmentAuthorizationError,
} from "./auth.ts";
import { IsoDateTime, RuntimeRequestId, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ModelSelection } from "./modelSelection.ts";

// Personal fork: the Today hub. Tasks come from a pluggable source (Todoist
// today), briefs and routines are read from the Hermes cron store. All of it
// is host state, so a client reads it from the environment that owns it.

export const PersonalTodayTaskSourceKind = Schema.Literals(["todoist"]);
export type PersonalTodayTaskSourceKind = typeof PersonalTodayTaskSourceKind.Type;

export const PersonalTodayTaskDue = Schema.Struct({
  /** Local calendar date `YYYY-MM-DD` as the source reports it. */
  date: Schema.String,
  /** Present when the task has a time of day. */
  datetime: Schema.NullOr(Schema.String),
  /** The source's human label, such as "tomorrow 9am" or "every day". */
  label: Schema.NullOr(Schema.String),
  isRecurring: Schema.Boolean,
});
export type PersonalTodayTaskDue = typeof PersonalTodayTaskDue.Type;

/** A task delegated to an agent thread on this environment. The task stays open for review. */
export const PersonalTodayTaskDelegation = Schema.Struct({
  threadId: ThreadId,
  delegatedAt: IsoDateTime,
});
export type PersonalTodayTaskDelegation = typeof PersonalTodayTaskDelegation.Type;

export const PersonalTodayTask = Schema.Struct({
  id: TrimmedNonEmptyString,
  source: PersonalTodayTaskSourceKind,
  content: Schema.String,
  description: Schema.String,
  url: Schema.NullOr(Schema.String),
  projectName: Schema.NullOr(Schema.String),
  /** 1 (normal) to 4 (urgent), Todoist's API order. */
  priority: Schema.Int,
  due: Schema.NullOr(PersonalTodayTaskDue),
  labels: Schema.Array(Schema.String),
  delegation: Schema.NullOr(PersonalTodayTaskDelegation),
});
export type PersonalTodayTask = typeof PersonalTodayTask.Type;

export const PersonalTodayTasksState = Schema.Struct({
  /** `disabled`: no source configured. `error`: last refresh failed; `tasks` is the last good list. */
  status: Schema.Literals(["ok", "disabled", "error", "loading"]),
  source: Schema.NullOr(PersonalTodayTaskSourceKind),
  tasks: Schema.Array(PersonalTodayTask),
  fetchedAt: Schema.NullOr(IsoDateTime),
  error: Schema.NullOr(Schema.String),
});
export type PersonalTodayTasksState = typeof PersonalTodayTasksState.Type;

export const PersonalTodayRoutine = Schema.Struct({
  id: TrimmedNonEmptyString,
  name: Schema.String,
  enabled: Schema.Boolean,
  /** Hermes job state: scheduled, paused, completed, ... */
  state: Schema.String,
  scheduleDisplay: Schema.String,
  /** Set for fixed-interval jobs, so a timeline can repeat them. */
  intervalMinutes: Schema.NullOr(Schema.Number),
  promptPreview: Schema.String,
  nextRunAt: Schema.NullOr(Schema.String),
  lastRunAt: Schema.NullOr(Schema.String),
  lastStatus: Schema.NullOr(Schema.String),
  lastError: Schema.NullOr(Schema.String),
  deliver: Schema.NullOr(Schema.String),
  isBrief: Schema.Boolean,
  notifies: Schema.Boolean,
});
export type PersonalTodayRoutine = typeof PersonalTodayRoutine.Type;

export const PersonalTodayBrief = Schema.Struct({
  jobId: TrimmedNonEmptyString,
  jobName: Schema.String,
  /** Output file stamp `YYYY-MM-DD_HH-MM-SS` in the Hermes time zone. */
  runStamp: Schema.String,
  /** The same moment as an ISO instant, for display in the client's time zone. */
  runAt: Schema.NullOr(Schema.String),
  /** The model response part of the cron output, as markdown. */
  markdown: Schema.String,
  firstLine: Schema.String,
  deliver: Schema.NullOr(Schema.String),
});
export type PersonalTodayBrief = typeof PersonalTodayBrief.Type;

export const PersonalTodayCronState = Schema.Struct({
  available: Schema.Boolean,
  error: Schema.NullOr(Schema.String),
  routines: Schema.Array(PersonalTodayRoutine),
  brief: Schema.NullOr(PersonalTodayBrief),
});
export type PersonalTodayCronState = typeof PersonalTodayCronState.Type;

export const PersonalTodaySettings = Schema.Struct({
  todoistEnabled: Schema.Boolean,
  /** Shell command printing the Todoist token. `TODOIST_API_TOKEN` wins when set. */
  todoistTokenCommand: Schema.String,
  /** Hermes home override; null resolves `HERMES_HOME` or `~/.hermes`. */
  hermesHome: Schema.NullOr(Schema.String),
  /** Cron job ids shown as the brief; null picks enabled jobs named like "brief". */
  briefJobIds: Schema.NullOr(Schema.Array(TrimmedNonEmptyString)),
  /** Cron job ids that notify when output lands; null follows the brief jobs. */
  notifyJobIds: Schema.NullOr(Schema.Array(TrimmedNonEmptyString)),
});
export type PersonalTodaySettings = typeof PersonalTodaySettings.Type;

export const PersonalTodaySettingsPatch = Schema.Struct({
  todoistEnabled: Schema.optional(Schema.Boolean),
  todoistTokenCommand: Schema.optional(Schema.String),
  hermesHome: Schema.optional(Schema.NullOr(Schema.String)),
  briefJobIds: Schema.optional(Schema.NullOr(Schema.Array(TrimmedNonEmptyString))),
  notifyJobIds: Schema.optional(Schema.NullOr(Schema.Array(TrimmedNonEmptyString))),
});
export type PersonalTodaySettingsPatch = typeof PersonalTodaySettingsPatch.Type;

export const PersonalTodaySnapshot = Schema.Struct({
  tasks: PersonalTodayTasksState,
  cron: PersonalTodayCronState,
  settings: PersonalTodaySettings,
});
export type PersonalTodaySnapshot = typeof PersonalTodaySnapshot.Type;

export const PersonalTodayBriefArrived = Schema.Struct({
  jobId: TrimmedNonEmptyString,
  jobName: Schema.String,
  runStamp: Schema.String,
  runAt: Schema.NullOr(Schema.String),
  firstLine: Schema.String,
});
export type PersonalTodayBriefArrived = typeof PersonalTodayBriefArrived.Type;

export const PersonalTodayTaskActionInput = Schema.Union([
  Schema.Struct({ type: Schema.Literal("add"), text: TrimmedNonEmptyString }),
  Schema.Struct({ type: Schema.Literal("complete"), taskId: TrimmedNonEmptyString }),
  Schema.Struct({ type: Schema.Literal("reopen"), taskId: TrimmedNonEmptyString }),
  Schema.Struct({
    type: Schema.Literal("reschedule"),
    taskId: TrimmedNonEmptyString,
    dueString: TrimmedNonEmptyString,
  }),
  Schema.Struct({
    type: Schema.Literal("delegate"),
    taskId: TrimmedNonEmptyString,
    /** Used when this environment has no Hermes provider instance. */
    fallbackModelSelection: Schema.optional(ModelSelection),
  }),
  Schema.Struct({ type: Schema.Literal("undelegate"), taskId: TrimmedNonEmptyString }),
]);
export type PersonalTodayTaskActionInput = typeof PersonalTodayTaskActionInput.Type;

export const PersonalTodayTaskActionResult = Schema.Struct({
  taskId: Schema.NullOr(Schema.String),
  /** Set by `delegate`: the thread working on the task. */
  threadId: Schema.NullOr(ThreadId),
});
export type PersonalTodayTaskActionResult = typeof PersonalTodayTaskActionResult.Type;

export const PersonalTodayRoutineActionInput = Schema.Struct({
  jobId: TrimmedNonEmptyString,
  action: Schema.Literals(["run", "pause", "resume"]),
});
export type PersonalTodayRoutineActionInput = typeof PersonalTodayRoutineActionInput.Type;

export const PersonalTodayRoutineHistoryInput = Schema.Struct({
  jobId: TrimmedNonEmptyString,
  /** Output to return; omitted returns the newest one. */
  stamp: Schema.optional(Schema.String),
});
export type PersonalTodayRoutineHistoryInput = typeof PersonalTodayRoutineHistoryInput.Type;

export const PersonalTodayRoutineRun = Schema.Struct({
  status: Schema.String,
  startedAt: Schema.NullOr(Schema.String),
  finishedAt: Schema.NullOr(Schema.String),
  durationSeconds: Schema.NullOr(Schema.Number),
  error: Schema.NullOr(Schema.String),
  /** The output file this run wrote, when one matches. */
  outputStamp: Schema.NullOr(Schema.String),
});
export type PersonalTodayRoutineRun = typeof PersonalTodayRoutineRun.Type;

export const PersonalTodayRoutineHistory = Schema.Struct({
  jobId: TrimmedNonEmptyString,
  runs: Schema.Array(PersonalTodayRoutineRun),
  outputStamps: Schema.Array(Schema.String),
  output: Schema.NullOr(
    Schema.Struct({
      stamp: Schema.String,
      runAt: Schema.NullOr(Schema.String),
      markdown: Schema.String,
    }),
  ),
});
export type PersonalTodayRoutineHistory = typeof PersonalTodayRoutineHistory.Type;

export const PersonalTodayPendingPromptsInput = Schema.Struct({
  threadIds: Schema.Array(ThreadId).check(Schema.isMaxLength(50)),
});
export type PersonalTodayPendingPromptsInput = typeof PersonalTodayPendingPromptsInput.Type;

/** The text of what a thread is waiting on, for threads that need the user. */
export const PersonalTodayPendingPrompt = Schema.Struct({
  threadId: ThreadId,
  kind: Schema.Literals(["approval", "user_input", "plan"]),
  requestId: Schema.NullOr(RuntimeRequestId),
  text: Schema.String,
});
export type PersonalTodayPendingPrompt = typeof PersonalTodayPendingPrompt.Type;

export const PersonalTodayPendingPromptsResult = Schema.Struct({
  prompts: Schema.Array(PersonalTodayPendingPrompt),
});
export type PersonalTodayPendingPromptsResult = typeof PersonalTodayPendingPromptsResult.Type;

export class PersonalTodayError extends Schema.TaggedError<PersonalTodayError>()(
  "PersonalTodayError",
  {
    message: Schema.String,
  },
) {}

export const PERSONAL_TODAY_WS_METHODS = {
  subscribe: "personalToday.subscribe",
  subscribeBriefs: "personalToday.subscribeBriefs",
  refresh: "personalToday.refresh",
  taskAction: "personalToday.taskAction",
  routineAction: "personalToday.routineAction",
  routineHistory: "personalToday.routineHistory",
  pendingPrompts: "personalToday.pendingPrompts",
  updateSettings: "personalToday.updateSettings",
} as const;

const PersonalTodayRpcError = Schema.Union([PersonalTodayError, EnvironmentAuthorizationError]);

/** Snapshot on subscribe, then a fresh snapshot after each change. Keeps task polling alive. */
const PersonalTodaySubscribeRpc = Rpc.make(PERSONAL_TODAY_WS_METHODS.subscribe, {
  payload: Schema.Struct({}),
  success: PersonalTodaySnapshot,
  error: PersonalTodayRpcError,
  stream: true,
});

/** One event per brief output that lands after the server started. */
const PersonalTodaySubscribeBriefsRpc = Rpc.make(PERSONAL_TODAY_WS_METHODS.subscribeBriefs, {
  payload: Schema.Struct({}),
  success: PersonalTodayBriefArrived,
  error: PersonalTodayRpcError,
  stream: true,
});

const PersonalTodayRefreshRpc = Rpc.make(PERSONAL_TODAY_WS_METHODS.refresh, {
  payload: Schema.Struct({}),
  success: PersonalTodaySnapshot,
  error: PersonalTodayRpcError,
});

const PersonalTodayTaskActionRpc = Rpc.make(PERSONAL_TODAY_WS_METHODS.taskAction, {
  payload: PersonalTodayTaskActionInput,
  success: PersonalTodayTaskActionResult,
  error: PersonalTodayRpcError,
});

const PersonalTodayRoutineActionRpc = Rpc.make(PERSONAL_TODAY_WS_METHODS.routineAction, {
  payload: PersonalTodayRoutineActionInput,
  success: Schema.Struct({}),
  error: PersonalTodayRpcError,
});

const PersonalTodayRoutineHistoryRpc = Rpc.make(PERSONAL_TODAY_WS_METHODS.routineHistory, {
  payload: PersonalTodayRoutineHistoryInput,
  success: PersonalTodayRoutineHistory,
  error: PersonalTodayRpcError,
});

const PersonalTodayPendingPromptsRpc = Rpc.make(PERSONAL_TODAY_WS_METHODS.pendingPrompts, {
  payload: PersonalTodayPendingPromptsInput,
  success: PersonalTodayPendingPromptsResult,
  error: PersonalTodayRpcError,
});

const PersonalTodayUpdateSettingsRpc = Rpc.make(PERSONAL_TODAY_WS_METHODS.updateSettings, {
  payload: PersonalTodaySettingsPatch,
  success: PersonalTodaySettings,
  error: PersonalTodayRpcError,
});

/** Spread into `WsRpcGroup`. */
export const PersonalTodayRpcs = [
  PersonalTodaySubscribeRpc,
  PersonalTodaySubscribeBriefsRpc,
  PersonalTodayRefreshRpc,
  PersonalTodayTaskActionRpc,
  PersonalTodayRoutineActionRpc,
  PersonalTodayRoutineHistoryRpc,
  PersonalTodayPendingPromptsRpc,
  PersonalTodayUpdateSettingsRpc,
] as const;

/** Spread into the server's RPC scope map. */
export const PERSONAL_TODAY_RPC_SCOPES = {
  [PERSONAL_TODAY_WS_METHODS.subscribe]: AuthOrchestrationReadScope,
  [PERSONAL_TODAY_WS_METHODS.subscribeBriefs]: AuthOrchestrationReadScope,
  [PERSONAL_TODAY_WS_METHODS.refresh]: AuthOrchestrationReadScope,
  [PERSONAL_TODAY_WS_METHODS.pendingPrompts]: AuthOrchestrationReadScope,
  [PERSONAL_TODAY_WS_METHODS.routineHistory]: AuthOrchestrationReadScope,
  [PERSONAL_TODAY_WS_METHODS.taskAction]: AuthOrchestrationOperateScope,
  [PERSONAL_TODAY_WS_METHODS.routineAction]: AuthOrchestrationOperateScope,
  [PERSONAL_TODAY_WS_METHODS.updateSettings]: AuthOrchestrationOperateScope,
} as const;
