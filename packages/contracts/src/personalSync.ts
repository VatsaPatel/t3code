/**
 * Personal fork: continuous sync of agent sessions started outside T3 Code
 * (Codex CLI, Claude Code, Hermes) plus the small personal settings store.
 *
 * Kept in its own module so the upstream contracts stay untouched apart from
 * the RPC registration lines in `rpc.ts`.
 */
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Rpc from "effect/unstable/rpc/Rpc";

import { EnvironmentAuthorizationError } from "./auth.ts";
import { ThreadId } from "./baseSchemas.ts";

export const PersonalSyncSource = Schema.Literals(["codex", "claude", "hermes"]);
export type PersonalSyncSource = typeof PersonalSyncSource.Type;

const PersonalSyncBackfillDays = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 3650 }));
const PersonalSyncPollSeconds = Schema.Int.check(Schema.isBetween({ minimum: 5, maximum: 3600 }));
const defaultTrue = Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true)));

export const PersonalSyncSettings = Schema.Struct({
  enabled: defaultTrue,
  codex: defaultTrue,
  claude: defaultTrue,
  hermes: defaultTrue,
  /** Sessions with no activity in this many days are not backfilled. */
  backfillDays: PersonalSyncBackfillDays.pipe(Schema.withDecodingDefault(Effect.succeed(45))),
  pollSeconds: PersonalSyncPollSeconds.pipe(Schema.withDecodingDefault(Effect.succeed(20))),
  /**
   * Project folder for sessions that ran outside any repository (home dir,
   * Slack, cron). Null uses `~/repos/personal-git` when it exists, else the
   * "No project" scratch project.
   */
  homeProjectPath: Schema.NullOr(Schema.String).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
});
export type PersonalSyncSettings = typeof PersonalSyncSettings.Type;

export const PersonalSettings = Schema.Struct({
  sync: PersonalSyncSettings.pipe(Schema.withDecodingDefault(Effect.succeed({}))),
});
export type PersonalSettings = typeof PersonalSettings.Type;

export const DEFAULT_PERSONAL_SETTINGS: PersonalSettings = Schema.decodeSync(PersonalSettings)({});

export const PersonalSettingsPatch = Schema.Struct({
  sync: Schema.optional(
    Schema.Struct({
      enabled: Schema.optional(Schema.Boolean),
      codex: Schema.optional(Schema.Boolean),
      claude: Schema.optional(Schema.Boolean),
      hermes: Schema.optional(Schema.Boolean),
      backfillDays: Schema.optional(PersonalSyncBackfillDays),
      pollSeconds: Schema.optional(PersonalSyncPollSeconds),
      homeProjectPath: Schema.optional(Schema.NullOr(Schema.String)),
    }),
  ),
});
export type PersonalSettingsPatch = typeof PersonalSettingsPatch.Type;

export const PersonalSyncSourceStatus = Schema.Struct({
  source: PersonalSyncSource,
  enabled: Schema.Boolean,
  lastRunAt: Schema.NullOr(Schema.String),
  lastSuccessAt: Schema.NullOr(Schema.String),
  nextRunAt: Schema.NullOr(Schema.String),
  /** Native sessions seen inside the backfill window on the last run. */
  discoveredCount: Schema.Number,
  /** Threads this source has synced into T3 so far. */
  syncedCount: Schema.Number,
  lastError: Schema.NullOr(Schema.String),
});
export type PersonalSyncSourceStatus = typeof PersonalSyncSourceStatus.Type;

export const PersonalSyncStatus = Schema.Struct({
  enabled: Schema.Boolean,
  running: Schema.Boolean,
  sources: Schema.Array(PersonalSyncSourceStatus),
});
export type PersonalSyncStatus = typeof PersonalSyncStatus.Type;

/** One row of `personal_external_sessions`: a T3 thread mirrored from a native session. */
export const PersonalExternalSession = Schema.Struct({
  threadId: ThreadId,
  providerInstanceId: Schema.String,
  driver: Schema.String,
  nativeSessionId: Schema.String,
  /** hermes: cli|desktop|slack|cron|acp|tui|webui|whatsapp|subagent|...; codex/claude: cli */
  origin: Schema.String,
  /** e.g. cron job name or Slack chat id. */
  originDetail: Schema.NullOr(Schema.String),
  cwd: Schema.NullOr(Schema.String),
  nativeMessageCount: Schema.Number,
  nativeUpdatedAt: Schema.String,
  lastSyncedAt: Schema.String,
  parentNativeSessionId: Schema.NullOr(Schema.String),
});
export type PersonalExternalSession = typeof PersonalExternalSession.Type;

export class PersonalSyncError extends Schema.TaggedError<PersonalSyncError>()(
  "PersonalSyncError",
  {
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

export const PERSONAL_WS_METHODS = {
  personalSyncStatus: "personal.sync.status",
  personalSyncRunNow: "personal.sync.runNow",
  personalSettingsGet: "personal.settings.get",
  personalSettingsUpdate: "personal.settings.update",
} as const;

export const WsPersonalSyncStatusRpc = Rpc.make(PERSONAL_WS_METHODS.personalSyncStatus, {
  payload: Schema.Struct({}),
  success: PersonalSyncStatus,
  error: Schema.Union([PersonalSyncError, EnvironmentAuthorizationError]),
});

/** Runs one sync pass now (waits for an in-flight pass) and returns the fresh status. */
export const WsPersonalSyncRunNowRpc = Rpc.make(PERSONAL_WS_METHODS.personalSyncRunNow, {
  payload: Schema.Struct({}),
  success: PersonalSyncStatus,
  error: Schema.Union([PersonalSyncError, EnvironmentAuthorizationError]),
});

export const WsPersonalSettingsGetRpc = Rpc.make(PERSONAL_WS_METHODS.personalSettingsGet, {
  payload: Schema.Struct({}),
  success: PersonalSettings,
  error: Schema.Union([PersonalSyncError, EnvironmentAuthorizationError]),
});

export const WsPersonalSettingsUpdateRpc = Rpc.make(PERSONAL_WS_METHODS.personalSettingsUpdate, {
  payload: PersonalSettingsPatch,
  success: PersonalSettings,
  error: Schema.Union([PersonalSyncError, EnvironmentAuthorizationError]),
});
