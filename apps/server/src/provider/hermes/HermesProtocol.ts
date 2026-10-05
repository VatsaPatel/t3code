/**
 * HermesProtocol — typed subset of the Hermes `tui_gateway` stdio JSON-RPC
 * protocol (`python -m tui_gateway.entry`) that T3 Code uses.
 *
 * Only the frames, results, and event payloads the adapter reads are modeled.
 * Every struct ignores extra keys, so a newer gateway that adds fields keeps
 * decoding. Request params are written by hand: the gateway rejects unknown
 * param keys with error 4000, so callers must send only documented keys.
 *
 * Source of truth: `hermes-agent/apps/shared/src/gateway-contract.openrpc.json`
 * (generated from `hermes-agent/tui_gateway/contracts/*.py`).
 */
import * as Schema from "effect/Schema";

const OptionalString = Schema.optional(Schema.NullOr(Schema.String));
const OptionalNumber = Schema.optional(Schema.NullOr(Schema.Number));
const OptionalBoolean = Schema.optional(Schema.NullOr(Schema.Boolean));
const UnknownRecord = Schema.Record(Schema.String, Schema.Unknown);

/** Gateway JSON-RPC error codes T3 branches on. */
export const HERMES_RPC_ERROR = {
  methodNotFound: -32601,
  /** Runtime session id unknown to this gateway (restart or reap). */
  sessionNotFound: 4001,
  /** Stored session id does not exist (resume / branch). */
  storedSessionNotFound: 4007,
  nothingToBranch: 4008,
  busy: 4009,
  /** Active-session lease refused; `data.reason` names why. */
  activeSessionRefused: 4090,
} as const;

// ── frames ────────────────────────────────────────────────────

export const HermesEventFrameParams = Schema.Struct({
  type: Schema.String,
  session_id: OptionalString,
  seq: OptionalNumber,
  payload: Schema.optional(Schema.Unknown),
});
export type HermesEventFrameParams = typeof HermesEventFrameParams.Type;

export const HermesRpcErrorBody = Schema.Struct({
  code: Schema.Number,
  message: Schema.String,
  data: Schema.optional(Schema.Unknown),
});
export type HermesRpcErrorBody = typeof HermesRpcErrorBody.Type;

// ── results ───────────────────────────────────────────────────

export const HermesUsage = Schema.Struct({
  model: OptionalString,
  input: OptionalNumber,
  output: OptionalNumber,
  reasoning: OptionalNumber,
  total: OptionalNumber,
  cache_read: OptionalNumber,
  context_used: OptionalNumber,
  context_max: OptionalNumber,
});
export type HermesUsage = typeof HermesUsage.Type;

export const HermesSessionInfo = Schema.Struct({
  model: OptionalString,
  provider: OptionalString,
  reasoning_effort: OptionalString,
  fast: OptionalBoolean,
  yolo: OptionalBoolean,
  approval_mode: OptionalString,
  running: OptionalBoolean,
  title: OptionalString,
  stored_session_id: OptionalString,
  usage: Schema.optional(Schema.NullOr(HermesUsage)),
  version: OptionalString,
});
export type HermesSessionInfo = typeof HermesSessionInfo.Type;

export const HermesOpenRequest = Schema.Struct({
  id: Schema.String,
  method: Schema.String,
  params: UnknownRecord,
});
export type HermesOpenRequest = typeof HermesOpenRequest.Type;

export const HermesSessionCreateResult = Schema.Struct({
  session_id: Schema.String,
  stored_session_id: Schema.String,
  info: Schema.optional(Schema.NullOr(HermesSessionInfo)),
});
export type HermesSessionCreateResult = typeof HermesSessionCreateResult.Type;

export const HermesSessionResumeResult = Schema.Struct({
  session_id: Schema.String,
  message_count: OptionalNumber,
  info: Schema.optional(Schema.NullOr(HermesSessionInfo)),
  stored_session_id: OptionalString,
  resumed: OptionalString,
  session_key: OptionalString,
  running: OptionalBoolean,
  open_requests: Schema.optional(Schema.NullOr(Schema.Array(HermesOpenRequest))),
});
export type HermesSessionResumeResult = typeof HermesSessionResumeResult.Type;

export const HermesSessionBranchStoredResult = Schema.Struct({
  session_id: Schema.String,
  stored_session_id: Schema.String,
  message_count: OptionalNumber,
  info: Schema.optional(Schema.NullOr(HermesSessionInfo)),
});
export type HermesSessionBranchStoredResult = typeof HermesSessionBranchStoredResult.Type;

export const HermesCorrectionResult = Schema.Struct({
  status: Schema.String,
});

export const HermesTranscriptMessage = Schema.Struct({
  role: Schema.String,
  text: OptionalString,
  timestamp: OptionalNumber,
  row_id: OptionalNumber,
});
export const HermesSessionHistoryResult = Schema.Struct({
  messages: Schema.Array(HermesTranscriptMessage),
});

export const HermesGatewayCapabilitiesResult = Schema.Struct({
  per_session_exclusive_submit: OptionalBoolean,
});

export const HermesModelCapabilities = Schema.Struct({
  fast: OptionalBoolean,
  reasoning: OptionalBoolean,
  can_disable_reasoning: OptionalBoolean,
});

export const HermesModelOptionProvider = Schema.Struct({
  slug: Schema.String,
  name: Schema.String,
  models: Schema.optional(Schema.NullOr(Schema.Array(Schema.String))),
  is_current: OptionalBoolean,
  authenticated: OptionalBoolean,
  capabilities: Schema.optional(
    Schema.NullOr(Schema.Record(Schema.String, HermesModelCapabilities)),
  ),
});
export type HermesModelOptionProvider = typeof HermesModelOptionProvider.Type;

export const HermesModelOptionsResult = Schema.Struct({
  providers: Schema.Array(HermesModelOptionProvider),
  model: OptionalString,
  provider: OptionalString,
});
export type HermesModelOptionsResult = typeof HermesModelOptionsResult.Type;

// ── event payloads ────────────────────────────────────────────

export const HermesTextPayload = Schema.Struct({ text: Schema.String });

export const HermesInterimPayload = Schema.Struct({
  text: Schema.String,
  already_streamed: OptionalBoolean,
});

export const HermesMessageCompletePayload = Schema.Struct({
  text: OptionalString,
  usage: Schema.optional(Schema.NullOr(HermesUsage)),
  status: OptionalString,
  error: OptionalString,
  recoverable: OptionalBoolean,
  response_transformed: OptionalBoolean,
  error_surface: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        code: OptionalString,
        retryable: OptionalBoolean,
        resets_at: OptionalNumber,
      }),
    ),
  ),
});
export type HermesMessageCompletePayload = typeof HermesMessageCompletePayload.Type;

export const HermesToolStartPayload = Schema.Struct({
  tool_id: Schema.String,
  name: Schema.String,
  context: OptionalString,
  args: Schema.optional(Schema.NullOr(UnknownRecord)),
});
export type HermesToolStartPayload = typeof HermesToolStartPayload.Type;

export const HermesToolCompletePayload = Schema.Struct({
  tool_id: Schema.String,
  name: Schema.String,
  args: Schema.optional(Schema.NullOr(UnknownRecord)),
  duration_s: OptionalNumber,
  result: Schema.optional(Schema.Unknown),
  summary: OptionalString,
  inline_diff: OptionalString,
});
export type HermesToolCompletePayload = typeof HermesToolCompletePayload.Type;

export const HermesTodoItem = Schema.Struct({
  id: Schema.optional(Schema.Union([Schema.String, Schema.Number])),
  content: OptionalString,
  status: OptionalString,
});
export const HermesTodoUpdatedPayload = Schema.Struct({
  todos: Schema.Array(Schema.Unknown),
  revision: OptionalNumber,
});

export const HermesSubagentPayload = Schema.Struct({
  goal: Schema.String,
  task_count: OptionalNumber,
  task_index: OptionalNumber,
  subagent_id: OptionalString,
  delegation_id: OptionalString,
  child_session_id: OptionalString,
  model: OptionalString,
  tool_name: OptionalString,
  tool_preview: OptionalString,
  text: OptionalString,
  status: OptionalString,
  summary: OptionalString,
});
export type HermesSubagentPayload = typeof HermesSubagentPayload.Type;

export const HermesStatusUpdatePayload = Schema.Struct({
  kind: Schema.String,
  text: Schema.String,
});

export const HermesUsagePayload = Schema.Struct({ usage: HermesUsage });

export const HermesErrorPayload = Schema.Struct({ message: Schema.String });

export const HermesTitlePayload = Schema.Struct({
  session_id: OptionalString,
  title: Schema.String,
});

export const HermesRequestCancelPayload = Schema.Struct({
  id: Schema.String,
  method: OptionalString,
  reason: OptionalString,
});

// ── server→client requests ────────────────────────────────────

export const HermesApprovalChoice = Schema.Literals(["once", "session", "always", "deny"]);
export type HermesApprovalChoice = typeof HermesApprovalChoice.Type;

export const HermesApprovalRequestParams = Schema.Struct({
  session_id: Schema.String,
  request_id: OptionalString,
  command: OptionalString,
  description: OptionalString,
  choices: Schema.optional(Schema.NullOr(Schema.Array(Schema.String))),
  tool_name: OptionalString,
});
export type HermesApprovalRequestParams = typeof HermesApprovalRequestParams.Type;

export const HermesClarifyQuestion = Schema.Struct({
  qid: Schema.String,
  question: Schema.String,
  choices: Schema.optional(Schema.NullOr(Schema.Array(Schema.String))),
  multi_select: OptionalBoolean,
});

export const HermesClarifyRequestParams = Schema.Struct({
  session_id: Schema.String,
  question: OptionalString,
  choices: Schema.optional(Schema.NullOr(Schema.Array(Schema.String))),
  multi_select: OptionalBoolean,
  questions: Schema.optional(Schema.NullOr(Schema.Array(HermesClarifyQuestion))),
});
export type HermesClarifyRequestParams = typeof HermesClarifyRequestParams.Type;
