/**
 * Personal organization: user/organizer-maintained labels that sort threads
 * into a repo → workstream → project hierarchy. Labels only — a placement
 * never changes a thread's project, cwd, provider, worktree, or permissions.
 */
import * as Schema from "effect/Schema";
import * as Rpc from "effect/unstable/rpc/Rpc";

import { EnvironmentAuthorizationError } from "./auth.ts";
import { IsoDateTime, ProjectId, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";

export const PERSONAL_GROUP_NAME_MAX_LENGTH = 40;

export const PersonalGroupId = TrimmedNonEmptyString.pipe(Schema.brand("PersonalGroupId"));
export type PersonalGroupId = typeof PersonalGroupId.Type;

/** Level 2 below the repo is a workstream; level 3 is an optional project. */
export const PersonalGroupKind = Schema.Literals(["workstream", "project"]);
export type PersonalGroupKind = typeof PersonalGroupKind.Type;

export const PersonalOrganizationActor = Schema.Literals(["user", "organizer"]);
export type PersonalOrganizationActor = typeof PersonalOrganizationActor.Type;

export const PersonalGroupName = TrimmedNonEmptyString.check(
  Schema.isMaxLength(PERSONAL_GROUP_NAME_MAX_LENGTH),
);

export const PersonalGroup = Schema.Struct({
  id: PersonalGroupId,
  projectId: ProjectId,
  parentId: Schema.NullOr(PersonalGroupId),
  name: PersonalGroupName,
  kind: PersonalGroupKind,
  createdBy: PersonalOrganizationActor,
  sortKey: Schema.String,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type PersonalGroup = typeof PersonalGroup.Type;

/** An organizer suggestion awaiting one-click accept (suggest mode). */
export const PersonalPlacementSuggestion = Schema.Struct({
  workstream: PersonalGroupName,
  project: Schema.NullOr(PersonalGroupName),
  reason: Schema.NullOr(Schema.String),
});
export type PersonalPlacementSuggestion = typeof PersonalPlacementSuggestion.Type;

/**
 * Where a thread sits. `groupId: null` means unassigned (directly under its
 * repo). A row with `source: "user"` is locked: the organizer never moves it.
 */
export const PersonalThreadPlacement = Schema.Struct({
  threadId: ThreadId,
  groupId: Schema.NullOr(PersonalGroupId),
  source: PersonalOrganizationActor,
  reason: Schema.optionalKey(Schema.String),
  /** Present when the last move can be undone; restores this group (null = unassigned). */
  undo: Schema.optionalKey(Schema.Struct({ groupId: Schema.NullOr(PersonalGroupId) })),
  suggestion: Schema.optionalKey(PersonalPlacementSuggestion),
  updatedAt: IsoDateTime,
});
export type PersonalThreadPlacement = typeof PersonalThreadPlacement.Type;

export const PersonalOrganizerMode = Schema.Literals(["off", "suggest", "auto"]);
export type PersonalOrganizerMode = typeof PersonalOrganizerMode.Type;
export const DEFAULT_PERSONAL_ORGANIZER_MODE: PersonalOrganizerMode = "auto";

export const PersonalOrganizerRunStatus = Schema.Literals([
  "never",
  "running",
  "succeeded",
  "failed",
]);
export type PersonalOrganizerRunStatus = typeof PersonalOrganizerRunStatus.Type;

export const PersonalOrganizerStatus = Schema.Struct({
  mode: PersonalOrganizerMode,
  /** False when no text-generation provider can classify; deterministic rules still run. */
  classifierAvailable: Schema.Boolean,
  classifierDetail: Schema.NullOr(Schema.String),
  lastRunAt: Schema.NullOr(IsoDateTime),
  lastRunStatus: PersonalOrganizerRunStatus,
  lastRunError: Schema.NullOr(Schema.String),
  lastRunPlaced: Schema.Int,
  /** Threads waiting for the organizer's first look. */
  pendingCount: Schema.Int,
  nextAttemptAt: Schema.NullOr(IsoDateTime),
});
export type PersonalOrganizerStatus = typeof PersonalOrganizerStatus.Type;

export const PersonalOrganizationSnapshot = Schema.Struct({
  groups: Schema.Array(PersonalGroup),
  placements: Schema.Array(PersonalThreadPlacement),
  organizer: PersonalOrganizerStatus,
});
export type PersonalOrganizationSnapshot = typeof PersonalOrganizationSnapshot.Type;

/** First event is a snapshot; later events carry only what changed. */
export const PersonalOrganizationStreamEvent = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("snapshot"),
    snapshot: PersonalOrganizationSnapshot,
  }),
  Schema.Struct({
    type: Schema.Literal("delta"),
    groups: Schema.optionalKey(Schema.Array(PersonalGroup)),
    deletedGroupIds: Schema.optionalKey(Schema.Array(PersonalGroupId)),
    placements: Schema.optionalKey(Schema.Array(PersonalThreadPlacement)),
    deletedPlacementThreadIds: Schema.optionalKey(Schema.Array(ThreadId)),
    organizer: Schema.optionalKey(PersonalOrganizerStatus),
  }),
]);
export type PersonalOrganizationStreamEvent = typeof PersonalOrganizationStreamEvent.Type;
export type PersonalOrganizationDelta = Extract<PersonalOrganizationStreamEvent, { type: "delta" }>;

export const PersonalGroupUpsertInput = Schema.Struct({
  id: Schema.optionalKey(PersonalGroupId),
  projectId: ProjectId,
  /** Null/omitted creates a workstream; a workstream id creates a project under it. */
  parentId: Schema.optionalKey(Schema.NullOr(PersonalGroupId)),
  name: TrimmedNonEmptyString,
});
export type PersonalGroupUpsertInput = typeof PersonalGroupUpsertInput.Type;

export const PersonalGroupDeleteInput = Schema.Struct({ id: PersonalGroupId });
export type PersonalGroupDeleteInput = typeof PersonalGroupDeleteInput.Type;

/**
 * Where to move a thread. `path` resolves (creating if needed) groups by name
 * inside the thread's own project, so clients merging environments and agents
 * never need another environment's group ids. `unassigned` moves it back to
 * its repo root; every target locks the thread against the organizer.
 */
export const PersonalMoveTarget = Schema.Union([
  Schema.Struct({ type: Schema.Literal("group"), groupId: PersonalGroupId }),
  Schema.Struct({
    type: Schema.Literal("path"),
    workstream: PersonalGroupName,
    project: Schema.NullOr(PersonalGroupName),
  }),
  Schema.Struct({ type: Schema.Literal("unassigned") }),
]);
export type PersonalMoveTarget = typeof PersonalMoveTarget.Type;

export const PersonalThreadMoveInput = Schema.Struct({
  threadId: ThreadId,
  target: PersonalMoveTarget,
});
export type PersonalThreadMoveInput = typeof PersonalThreadMoveInput.Type;

export const PersonalThreadInput = Schema.Struct({ threadId: ThreadId });
export type PersonalThreadInput = typeof PersonalThreadInput.Type;

export const PersonalOrganizerSettingsInput = Schema.Struct({ mode: PersonalOrganizerMode });
export type PersonalOrganizerSettingsInput = typeof PersonalOrganizerSettingsInput.Type;

export const PersonalGroupResult = Schema.Struct({ group: PersonalGroup });
export const PersonalPlacementResult = Schema.Struct({
  placement: Schema.NullOr(PersonalThreadPlacement),
});

/**
 * Per-thread details for the chat manager, fetched on demand (not part of the
 * live snapshot). Origin comes from synced external sessions; T3-native
 * threads report origin "t3".
 */
export const PersonalThreadDetail = Schema.Struct({
  threadId: ThreadId,
  origin: Schema.String,
  originDetail: Schema.NullOr(Schema.String),
  messageCount: Schema.Int,
  /** Last user/assistant message text, whitespace-collapsed and truncated. */
  lastMessage: Schema.NullOr(Schema.String),
});
export type PersonalThreadDetail = typeof PersonalThreadDetail.Type;

export const PersonalThreadDetailsResult = Schema.Struct({
  threads: Schema.Array(PersonalThreadDetail),
});
export type PersonalThreadDetailsResult = typeof PersonalThreadDetailsResult.Type;

export class PersonalOrganizationError extends Schema.TaggedError<PersonalOrganizationError>()(
  "PersonalOrganizationError",
  {
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

const RpcError = Schema.Union([PersonalOrganizationError, EnvironmentAuthorizationError]);

export const PERSONAL_ORGANIZATION_WS_METHODS = {
  getSnapshot: "personalOrganization.getSnapshot",
  subscribe: "personalOrganization.subscribe",
  upsertGroup: "personalOrganization.upsertGroup",
  deleteGroup: "personalOrganization.deleteGroup",
  moveThread: "personalOrganization.moveThread",
  undoMove: "personalOrganization.undoMove",
  acceptSuggestion: "personalOrganization.acceptSuggestion",
  resetThread: "personalOrganization.resetThread",
  runOrganizer: "personalOrganization.runOrganizer",
  updateOrganizerSettings: "personalOrganization.updateOrganizerSettings",
  listThreadDetails: "personalOrganization.listThreadDetails",
} as const;
const M = PERSONAL_ORGANIZATION_WS_METHODS;

export const PersonalOrganizationRpcs = [
  Rpc.make(M.getSnapshot, {
    payload: Schema.Struct({}),
    success: PersonalOrganizationSnapshot,
    error: RpcError,
  }),
  Rpc.make(M.subscribe, {
    payload: Schema.Struct({}),
    success: PersonalOrganizationStreamEvent,
    error: RpcError,
    stream: true,
  }),
  Rpc.make(M.upsertGroup, {
    payload: PersonalGroupUpsertInput,
    success: PersonalGroupResult,
    error: RpcError,
  }),
  Rpc.make(M.deleteGroup, {
    payload: PersonalGroupDeleteInput,
    success: Schema.Struct({ id: PersonalGroupId }),
    error: RpcError,
  }),
  Rpc.make(M.moveThread, {
    payload: PersonalThreadMoveInput,
    success: PersonalPlacementResult,
    error: RpcError,
  }),
  Rpc.make(M.undoMove, {
    payload: PersonalThreadInput,
    success: PersonalPlacementResult,
    error: RpcError,
  }),
  Rpc.make(M.acceptSuggestion, {
    payload: PersonalThreadInput,
    success: PersonalPlacementResult,
    error: RpcError,
  }),
  /** Forgets a placement so the organizer may place the thread again. */
  Rpc.make(M.resetThread, {
    payload: PersonalThreadInput,
    success: PersonalPlacementResult,
    error: RpcError,
  }),
  Rpc.make(M.runOrganizer, {
    payload: Schema.Struct({}),
    success: PersonalOrganizerStatus,
    error: RpcError,
  }),
  Rpc.make(M.updateOrganizerSettings, {
    payload: PersonalOrganizerSettingsInput,
    success: PersonalOrganizerStatus,
    error: RpcError,
  }),
  Rpc.make(M.listThreadDetails, {
    payload: Schema.Struct({}),
    success: PersonalThreadDetailsResult,
    error: RpcError,
  }),
] as const;
