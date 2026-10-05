/**
 * Personal organization store: groups (workstream → project) per T3 project
 * and per-thread placements, plus the organizer's persisted mode/status.
 *
 * Tables are personal side tables created idempotently at construction (not
 * numbered migrations — see the fork's persistence rule) and are labels only:
 * nothing here changes a thread's project, cwd, provider, or permissions.
 *
 * @module PersonalOrganizationService
 */
import {
  DEFAULT_PERSONAL_ORGANIZER_MODE,
  PersonalGroupId,
  PersonalOrganizationError,
  PersonalOrganizerMode,
  PersonalOrganizerStatus,
  PersonalPlacementSuggestion,
  ThreadId,
  type PersonalGroup,
  type PersonalGroupDeleteInput,
  type PersonalGroupKind,
  type PersonalGroupUpsertInput,
  type PersonalMoveTarget,
  type PersonalOrganizationActor,
  type PersonalOrganizationDelta,
  type PersonalOrganizationSnapshot,
  type PersonalOrganizationStreamEvent,
  type PersonalThreadInput,
  type PersonalThreadMoveInput,
  type PersonalThreadDetailsInput,
  type PersonalThreadDetailsResult,
  type PersonalThreadPlacement,
  type ProjectId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { normalizeGroupName, sameGroupName } from "./classification.ts";

interface GroupRow {
  readonly group_id: string;
  readonly project_id: string;
  readonly parent_id: string | null;
  readonly name: string;
  readonly kind: string;
  readonly created_by: string;
  readonly sort_key: string;
  readonly created_at: string;
  readonly updated_at: string;
}

interface PlacementRow {
  readonly thread_id: string;
  readonly group_id: string | null;
  readonly source: string;
  readonly reason: string | null;
  readonly undo_available: number;
  readonly previous_group_id: string | null;
  readonly suggestion_json: string | null;
  readonly updated_at: string;
}

const decodeSuggestion = Schema.decodeUnknownOption(
  Schema.fromJsonString(PersonalPlacementSuggestion),
);
const encodeSuggestion = Schema.encodeSync(Schema.fromJsonString(PersonalPlacementSuggestion));
const decodeMode = Schema.decodeUnknownOption(PersonalOrganizerMode);
const LastRun = Schema.fromJsonString(
  Schema.Struct({
    lastRunAt: Schema.optionalKey(PersonalOrganizerStatus.fields.lastRunAt),
    lastRunStatus: Schema.optionalKey(PersonalOrganizerStatus.fields.lastRunStatus),
    lastRunError: Schema.optionalKey(PersonalOrganizerStatus.fields.lastRunError),
    lastRunPlaced: Schema.optionalKey(PersonalOrganizerStatus.fields.lastRunPlaced),
  }),
);
const decodeLastRun = Schema.decodeUnknownOption(LastRun);
const encodeLastRun = Schema.encodeSync(LastRun);

export const ensurePersonalOrganizationTables = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE IF NOT EXISTS personal_groups (
      group_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      parent_id TEXT,
      name TEXT NOT NULL,
      kind TEXT NOT NULL,
      created_by TEXT NOT NULL,
      sort_key TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      deleted_at TEXT
    )
  `;
  yield* sql`CREATE INDEX IF NOT EXISTS personal_groups_project_idx ON personal_groups(project_id, deleted_at)`;
  yield* sql`
    CREATE TABLE IF NOT EXISTS personal_thread_placements (
      thread_id TEXT PRIMARY KEY,
      group_id TEXT,
      source TEXT NOT NULL,
      reason TEXT,
      undo_available INTEGER NOT NULL DEFAULT 0,
      previous_group_id TEXT,
      suggestion_json TEXT,
      updated_at TEXT NOT NULL
    )
  `;
  yield* sql`CREATE INDEX IF NOT EXISTS personal_thread_placements_group_idx ON personal_thread_placements(group_id)`;
  yield* sql`
    CREATE TABLE IF NOT EXISTS personal_organizer_state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )
  `;
});

const toGroup = (row: GroupRow): PersonalGroup => ({
  id: PersonalGroupId.make(row.group_id),
  projectId: row.project_id as ProjectId,
  parentId: row.parent_id === null ? null : PersonalGroupId.make(row.parent_id),
  name: row.name,
  kind: row.kind === "project" ? "project" : "workstream",
  createdBy: row.created_by === "organizer" ? "organizer" : "user",
  sortKey: row.sort_key,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const toPlacement = (row: PlacementRow): PersonalThreadPlacement => {
  const suggestion =
    row.suggestion_json === null ? undefined : decodeSuggestion(row.suggestion_json);
  return {
    threadId: ThreadId.make(row.thread_id),
    groupId: row.group_id === null ? null : PersonalGroupId.make(row.group_id),
    source: row.source === "user" ? "user" : "organizer",
    ...(row.reason === null ? {} : { reason: row.reason }),
    ...(row.undo_available === 1
      ? {
          undo: {
            groupId:
              row.previous_group_id === null ? null : PersonalGroupId.make(row.previous_group_id),
          },
        }
      : {}),
    ...(suggestion !== undefined && suggestion._tag === "Some"
      ? { suggestion: suggestion.value }
      : {}),
    updatedAt: row.updated_at,
  };
};

export const initialOrganizerStatus = (mode: PersonalOrganizerMode): PersonalOrganizerStatus => ({
  mode,
  classifierAvailable: false,
  classifierDetail: null,
  lastRunAt: null,
  lastRunStatus: "never",
  lastRunError: null,
  lastRunPlaced: 0,
  pendingCount: 0,
  nextAttemptAt: null,
});

/** An organizer decision for one thread. */
export type OrganizerPlacement =
  | {
      readonly type: "place";
      readonly threadId: ThreadId;
      readonly groupId: PersonalGroupId | null;
      readonly reason: string;
    }
  | {
      readonly type: "suggest";
      readonly threadId: ThreadId;
      readonly suggestion: PersonalPlacementSuggestion;
    };

export class PersonalOrganizationService extends Context.Service<
  PersonalOrganizationService,
  {
    readonly getSnapshot: () => Effect.Effect<
      PersonalOrganizationSnapshot,
      PersonalOrganizationError
    >;
    /** Snapshot first, then deltas for every change. */
    readonly subscribe: () => Stream.Stream<
      PersonalOrganizationStreamEvent,
      PersonalOrganizationError
    >;
    readonly upsertGroup: (
      input: PersonalGroupUpsertInput,
    ) => Effect.Effect<{ readonly group: PersonalGroup }, PersonalOrganizationError>;
    readonly deleteGroup: (
      input: PersonalGroupDeleteInput,
    ) => Effect.Effect<{ readonly id: PersonalGroupId }, PersonalOrganizationError>;
    /** A user move: records undo and locks the thread against the organizer. */
    readonly moveThread: (
      input: PersonalThreadMoveInput,
    ) => Effect.Effect<
      { readonly placement: PersonalThreadPlacement | null },
      PersonalOrganizationError
    >;
    readonly undoMove: (
      input: PersonalThreadInput,
    ) => Effect.Effect<
      { readonly placement: PersonalThreadPlacement | null },
      PersonalOrganizationError
    >;
    readonly acceptSuggestion: (
      input: PersonalThreadInput,
    ) => Effect.Effect<
      { readonly placement: PersonalThreadPlacement | null },
      PersonalOrganizationError
    >;
    readonly resetThread: (
      input: PersonalThreadInput,
    ) => Effect.Effect<
      { readonly placement: PersonalThreadPlacement | null },
      PersonalOrganizationError
    >;
    readonly setOrganizerMode: (
      mode: PersonalOrganizerMode,
    ) => Effect.Effect<PersonalOrganizerStatus, PersonalOrganizationError>;
    readonly getOrganizerStatus: Effect.Effect<PersonalOrganizerStatus>;
    /** Organizer-only: patch the live status (persists last-run fields). */
    readonly updateOrganizerStatus: (
      patch: Partial<PersonalOrganizerStatus>,
    ) => Effect.Effect<PersonalOrganizerStatus>;
    /** Organizer-only: find or create `workstream[/project]` in a project. */
    readonly ensureGroupPath: (input: {
      readonly projectId: ProjectId;
      readonly workstream: string;
      readonly project: string | null;
      readonly createdBy: PersonalOrganizationActor;
    }) => Effect.Effect<PersonalGroupId, PersonalOrganizationError>;
    /**
     * Organizer-only: apply decisions. A thread that already has any placement
     * row is skipped unless it only carries an organizer suggestion, so the
     * organizer can never overwrite a user (or earlier organizer) decision.
     */
    readonly applyOrganizerPlacements: (
      placements: ReadonlyArray<OrganizerPlacement>,
    ) => Effect.Effect<number, PersonalOrganizationError>;
    readonly listGroups: (
      projectId: ProjectId,
    ) => Effect.Effect<ReadonlyArray<PersonalGroup>, PersonalOrganizationError>;
    readonly getPlacement: (
      threadId: ThreadId,
    ) => Effect.Effect<PersonalThreadPlacement | null, PersonalOrganizationError>;
    /** Origin, message count, and last-message snippet per live thread (chat manager). */
    readonly listThreadDetails: (
      input: PersonalThreadDetailsInput,
    ) => Effect.Effect<PersonalThreadDetailsResult, PersonalOrganizationError>;
  }
>()("t3/personal/organization/PersonalOrganizationService") {}

const fail = (message: string, cause?: unknown) =>
  new PersonalOrganizationError({ message, ...(cause === undefined ? {} : { cause }) });

const STATUS_KEYS = ["lastRunAt", "lastRunStatus", "lastRunError", "lastRunPlaced"] as const;

export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const crypto = yield* Crypto.Crypto;
  yield* ensurePersonalOrganizationTables;

  const mutex = yield* Semaphore.make(1);
  const deltas = yield* PubSub.unbounded<PersonalOrganizationDelta>();
  const publish = (delta: Omit<PersonalOrganizationDelta, "type">) =>
    PubSub.publish(deltas, { type: "delta" as const, ...delta }).pipe(Effect.asVoid);

  const nowIso = DateTime.now.pipe(Effect.map((now) => DateTime.formatIso(now)));
  const sqlError = (message: string) => Effect.mapError((cause: unknown) => fail(message, cause));

  const stateRows = yield* sql<{ key: string; value: string }>`
    SELECT key, value FROM personal_organizer_state
  `.pipe(sqlError("Could not read organizer state."));
  const state = new Map(stateRows.map((row) => [row.key, row.value]));
  const persistedMode = decodeMode(state.get("mode"));
  const persistedStatus = Option.getOrElse(
    decodeLastRun(state.get("lastRun") ?? "{}"),
    (): Partial<PersonalOrganizerStatus> => ({}),
  );
  const status = yield* Ref.make<PersonalOrganizerStatus>({
    ...initialOrganizerStatus(
      persistedMode._tag === "Some" ? persistedMode.value : DEFAULT_PERSONAL_ORGANIZER_MODE,
    ),
    ...persistedStatus,
    // A run cannot survive a restart.
    ...(persistedStatus.lastRunStatus === "running" ? { lastRunStatus: "failed" as const } : {}),
  });

  const writeState = (key: string, value: string) =>
    sql`
      INSERT INTO personal_organizer_state (key, value) VALUES (${key}, ${value})
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `.pipe(Effect.asVoid);

  const selectGroups = () => sql<GroupRow>`
    SELECT group_id, project_id, parent_id, name, kind, created_by, sort_key, created_at, updated_at
    FROM personal_groups
    WHERE deleted_at IS NULL
    ORDER BY project_id, sort_key, name
  `;
  const selectGroup = (id: string) => sql<GroupRow>`
    SELECT group_id, project_id, parent_id, name, kind, created_by, sort_key, created_at, updated_at
    FROM personal_groups
    WHERE group_id = ${id} AND deleted_at IS NULL
  `;
  const selectPlacement = (threadId: string) => sql<PlacementRow>`
    SELECT * FROM personal_thread_placements WHERE thread_id = ${threadId}
  `;
  const threadProjectId = (threadId: string) =>
    sql<{ project_id: string }>`
      SELECT project_id FROM orchestration_v2_projection_threads
      WHERE thread_id = ${threadId} AND deleted_at IS NULL
    `.pipe(
      sqlError("Could not load the thread."),
      Effect.flatMap((rows) =>
        rows[0] === undefined
          ? Effect.fail(fail("Thread not found."))
          : Effect.succeed(rows[0].project_id as ProjectId),
      ),
    );

  const getPlacement = (threadId: ThreadId) =>
    selectPlacement(threadId).pipe(
      sqlError("Could not load placement."),
      Effect.map((rows) => (rows[0] === undefined ? null : toPlacement(rows[0]))),
    );

  const listGroups = (projectId: ProjectId) =>
    sql<GroupRow>`
      SELECT group_id, project_id, parent_id, name, kind, created_by, sort_key, created_at, updated_at
      FROM personal_groups
      WHERE project_id = ${projectId} AND deleted_at IS NULL
      ORDER BY sort_key, name
    `.pipe(
      sqlError("Could not list groups."),
      Effect.map((rows) => rows.map(toGroup)),
    );

  const getSnapshot = () =>
    Effect.gen(function* () {
      const groups = yield* selectGroups().pipe(sqlError("Could not list groups."));
      const placements = yield* sql<PlacementRow>`
        SELECT * FROM personal_thread_placements
      `.pipe(sqlError("Could not list placements."));
      return {
        groups: groups.map(toGroup),
        placements: placements.map(toPlacement),
        organizer: yield* Ref.get(status),
      } satisfies PersonalOrganizationSnapshot;
    });

  const subscribe = () =>
    Stream.unwrap(
      Effect.gen(function* () {
        // Subscribe before the snapshot so no change between the two is lost;
        // deltas are idempotent upserts, so a duplicate is harmless.
        const subscription = yield* PubSub.subscribe(deltas);
        const snapshot = yield* getSnapshot();
        return Stream.concat(
          Stream.succeed<PersonalOrganizationStreamEvent>({ type: "snapshot", snapshot }),
          Stream.fromSubscription(subscription),
        );
      }),
    );

  const insertGroup = Effect.fn("PersonalOrganization.insertGroup")(function* (input: {
    readonly projectId: ProjectId;
    readonly parentId: PersonalGroupId | null;
    readonly name: string;
    readonly kind: PersonalGroupKind;
    readonly createdBy: PersonalOrganizationActor;
  }) {
    const now = yield* nowIso;
    const id = PersonalGroupId.make(yield* crypto.randomUUIDv4.pipe(Effect.orDie));
    yield* sql`
      INSERT INTO personal_groups (
        group_id, project_id, parent_id, name, kind, created_by, sort_key, created_at, updated_at
      ) VALUES (
        ${id}, ${input.projectId}, ${input.parentId}, ${input.name}, ${input.kind},
        ${input.createdBy}, '', ${now}, ${now}
      )
    `.pipe(sqlError("Could not create group."));
    const group: PersonalGroup = {
      id,
      projectId: input.projectId,
      parentId: input.parentId,
      name: input.name,
      kind: input.kind,
      createdBy: input.createdBy,
      sortKey: "",
      createdAt: now,
      updatedAt: now,
    };
    yield* publish({ groups: [group] });
    return group;
  });

  /** Find a sibling by name or create it. Caller holds the mutex. */
  const findOrCreateGroup = Effect.fn("PersonalOrganization.findOrCreateGroup")(function* (input: {
    readonly projectId: ProjectId;
    readonly parentId: PersonalGroupId | null;
    readonly name: string;
    readonly createdBy: PersonalOrganizationActor;
  }) {
    const siblings = (yield* listGroups(input.projectId)).filter(
      (group) => group.parentId === input.parentId,
    );
    const existing = siblings.find((group) => sameGroupName(group.name, input.name));
    if (existing !== undefined) return existing;
    return yield* insertGroup({
      ...input,
      kind: input.parentId === null ? "workstream" : "project",
    });
  });

  const ensureGroupPathUnlocked = Effect.fn("PersonalOrganization.ensureGroupPath")(
    function* (input: {
      readonly projectId: ProjectId;
      readonly workstream: string;
      readonly project: string | null;
      readonly createdBy: PersonalOrganizationActor;
    }) {
      const workstreamName = normalizeGroupName(input.workstream);
      if (workstreamName === null) return yield* fail("Invalid workstream name.");
      const workstream = yield* findOrCreateGroup({
        projectId: input.projectId,
        parentId: null,
        name: workstreamName,
        createdBy: input.createdBy,
      });
      if (input.project === null) return workstream.id;
      const projectName = normalizeGroupName(input.project);
      if (projectName === null) return yield* fail("Invalid project name.");
      const project = yield* findOrCreateGroup({
        projectId: input.projectId,
        parentId: workstream.id,
        name: projectName,
        createdBy: input.createdBy,
      });
      return project.id;
    },
  );

  const upsertGroup = (input: PersonalGroupUpsertInput) =>
    mutex.withPermits(1)(
      Effect.gen(function* () {
        const name = input.name.trim();
        if (name.length === 0 || name.length > 40) {
          return yield* fail("Group names must be 1–40 characters.");
        }
        if (input.id !== undefined) {
          const rows = yield* selectGroup(input.id).pipe(sqlError("Could not load group."));
          const row = rows[0];
          if (row === undefined) return yield* fail("Group not found.");
          const now = yield* nowIso;
          yield* sql`
            UPDATE personal_groups SET name = ${name}, updated_at = ${now}
            WHERE group_id = ${input.id}
          `.pipe(sqlError("Could not rename group."));
          const group = toGroup({ ...row, name, updated_at: now });
          yield* publish({ groups: [group] });
          return { group };
        }
        const parentId = input.parentId ?? null;
        if (parentId !== null) {
          const parent = (yield* selectGroup(parentId).pipe(sqlError("Could not load group.")))[0];
          if (parent === undefined) return yield* fail("Parent group not found.");
          if (parent.kind !== "workstream" || parent.project_id !== input.projectId) {
            // Max depth is workstream → project below the repo.
            return yield* fail("Projects can only be created directly under a workstream.");
          }
        }
        const group = yield* findOrCreateGroup({
          projectId: input.projectId,
          parentId,
          name,
          createdBy: "user",
        });
        return { group };
      }),
    );

  const deleteGroup = (input: PersonalGroupDeleteInput) =>
    mutex.withPermits(1)(
      Effect.gen(function* () {
        const now = yield* nowIso;
        const ids = (yield* sql<{ group_id: string }>`
          SELECT group_id FROM personal_groups
          WHERE deleted_at IS NULL AND (group_id = ${input.id} OR parent_id = ${input.id})
        `.pipe(sqlError("Could not load group."))).map((row) => row.group_id);
        if (ids.length === 0) return { id: input.id };
        const affected = yield* sql<PlacementRow>`
          SELECT * FROM personal_thread_placements WHERE group_id IN ${sql.in(ids)}
        `.pipe(sqlError("Could not load placements."));
        yield* sql
          .withTransaction(
            Effect.gen(function* () {
              yield* sql`
              UPDATE personal_groups SET deleted_at = ${now}, updated_at = ${now}
              WHERE group_id IN ${sql.in(ids)}
            `;
              // Threads become unassigned; the row stays so the organizer does
              // not immediately re-file them into a fresh copy of the group.
              yield* sql`
              UPDATE personal_thread_placements
              SET group_id = NULL, undo_available = 0, previous_group_id = NULL, updated_at = ${now}
              WHERE group_id IN ${sql.in(ids)}
            `;
            }),
          )
          .pipe(sqlError("Could not delete group."));
        yield* publish({
          deletedGroupIds: ids.map((id) => PersonalGroupId.make(id)),
          placements: affected.map((row) =>
            toPlacement({
              ...row,
              group_id: null,
              undo_available: 0,
              previous_group_id: null,
              updated_at: now,
            }),
          ),
        });
        return { id: input.id };
      }),
    );

  /** Write a user decision for a thread, remembering the previous group for undo. */
  const writeUserPlacement = Effect.fn("PersonalOrganization.writeUserPlacement")(function* (
    threadId: ThreadId,
    groupId: PersonalGroupId | null,
    options: { readonly recordUndo: boolean },
  ) {
    const now = yield* nowIso;
    const previous = (yield* selectPlacement(threadId).pipe(
      sqlError("Could not load placement."),
    ))[0];
    const previousGroupId = previous?.group_id ?? null;
    const undo = options.recordUndo && previousGroupId !== groupId ? 1 : 0;
    yield* sql`
      INSERT INTO personal_thread_placements (
        thread_id, group_id, source, reason, undo_available, previous_group_id, suggestion_json, updated_at
      ) VALUES (
        ${threadId}, ${groupId}, 'user', NULL, ${undo}, ${undo === 1 ? previousGroupId : null}, NULL, ${now}
      )
      ON CONFLICT(thread_id) DO UPDATE SET
        group_id = excluded.group_id,
        source = 'user',
        reason = NULL,
        undo_available = excluded.undo_available,
        previous_group_id = excluded.previous_group_id,
        suggestion_json = NULL,
        updated_at = excluded.updated_at
    `.pipe(sqlError("Could not move thread."));
    const placement = toPlacement({
      thread_id: threadId,
      group_id: groupId,
      source: "user",
      reason: null,
      undo_available: undo,
      previous_group_id: undo === 1 ? previousGroupId : null,
      suggestion_json: null,
      updated_at: now,
    });
    yield* publish({ placements: [placement] });
    return { placement };
  });

  const resolveTarget = Effect.fn("PersonalOrganization.resolveTarget")(function* (
    projectId: ProjectId,
    target: PersonalMoveTarget,
  ) {
    switch (target.type) {
      case "unassigned":
        return null;
      case "group": {
        const group = (yield* selectGroup(target.groupId).pipe(
          sqlError("Could not load group."),
        ))[0];
        if (group === undefined) return yield* fail("Group not found.");
        if (group.project_id !== projectId) {
          return yield* fail("A thread can only be placed in a group of its own project.");
        }
        return PersonalGroupId.make(group.group_id);
      }
      case "path":
        return yield* ensureGroupPathUnlocked({
          projectId,
          workstream: target.workstream,
          project: target.project,
          createdBy: "user",
        });
    }
  });

  const moveThread = (input: PersonalThreadMoveInput) =>
    mutex.withPermits(1)(
      Effect.gen(function* () {
        const projectId = yield* threadProjectId(input.threadId);
        const groupId = yield* resolveTarget(projectId, input.target);
        return yield* writeUserPlacement(input.threadId, groupId, { recordUndo: true });
      }),
    );

  const undoMove = (input: PersonalThreadInput) =>
    mutex.withPermits(1)(
      Effect.gen(function* () {
        const row = (yield* selectPlacement(input.threadId).pipe(
          sqlError("Could not load placement."),
        ))[0];
        if (row === undefined || row.undo_available !== 1) {
          return yield* fail("There is no move to undo for this thread.");
        }
        const previous =
          row.previous_group_id === null
            ? null
            : (yield* selectGroup(row.previous_group_id).pipe(
                sqlError("Could not load group."),
              ))[0];
        // Undoing is a user decision too, so the thread stays locked.
        return yield* writeUserPlacement(
          input.threadId,
          previous === undefined || previous === null
            ? null
            : PersonalGroupId.make(previous.group_id),
          { recordUndo: false },
        );
      }),
    );

  const acceptSuggestion = (input: PersonalThreadInput) =>
    mutex.withPermits(1)(
      Effect.gen(function* () {
        const row = (yield* selectPlacement(input.threadId).pipe(
          sqlError("Could not load placement."),
        ))[0];
        const placement = row === undefined ? null : toPlacement(row);
        if (placement?.suggestion === undefined) {
          return yield* fail("This thread has no organizer suggestion.");
        }
        const projectId = yield* threadProjectId(input.threadId);
        const groupId = yield* ensureGroupPathUnlocked({
          projectId,
          workstream: placement.suggestion.workstream,
          project: placement.suggestion.project,
          createdBy: "organizer",
        });
        return yield* writeUserPlacement(input.threadId, groupId, { recordUndo: true });
      }),
    );

  const resetThread = (input: PersonalThreadInput) =>
    mutex.withPermits(1)(
      Effect.gen(function* () {
        yield* sql`DELETE FROM personal_thread_placements WHERE thread_id = ${input.threadId}`.pipe(
          sqlError("Could not reset placement."),
        );
        yield* publish({ deletedPlacementThreadIds: [input.threadId] });
        return { placement: null };
      }),
    );

  const updateOrganizerStatus = (patch: Partial<PersonalOrganizerStatus>) =>
    Effect.gen(function* () {
      const previous = yield* Ref.get(status);
      const next = { ...previous, ...patch };
      const changed = (Object.keys(patch) as Array<keyof PersonalOrganizerStatus>).some(
        (key) => previous[key] !== next[key],
      );
      if (!changed) return previous;
      yield* Ref.set(status, next);
      if (STATUS_KEYS.some((key) => key in patch)) {
        yield* writeState(
          "lastRun",
          encodeLastRun({
            lastRunAt: next.lastRunAt,
            lastRunStatus: next.lastRunStatus,
            lastRunError: next.lastRunError,
            lastRunPlaced: next.lastRunPlaced,
          }),
        ).pipe(
          Effect.catch((cause) =>
            Effect.logWarning("Could not persist organizer status", { cause }),
          ),
        );
      }
      yield* publish({ organizer: next });
      return next;
    });

  const setOrganizerMode = (mode: PersonalOrganizerMode) =>
    writeState("mode", mode).pipe(
      sqlError("Could not save organizer settings."),
      Effect.andThen(updateOrganizerStatus({ mode })),
    );

  const applyOrganizerPlacements = (placements: ReadonlyArray<OrganizerPlacement>) =>
    mutex.withPermits(1)(
      Effect.gen(function* () {
        if (placements.length === 0) return 0;
        const now = yield* nowIso;
        const written: PersonalThreadPlacement[] = [];
        for (const decision of placements) {
          const existing = (yield* selectPlacement(decision.threadId).pipe(
            sqlError("Could not load placement."),
          ))[0];
          // Never touch a user decision or an earlier organizer placement;
          // only an unplaced thread or a pending suggestion may change.
          if (existing !== undefined) {
            const pendingSuggestion =
              existing.source === "organizer" &&
              existing.group_id === null &&
              existing.suggestion_json !== null;
            if (!pendingSuggestion || decision.type === "suggest") continue;
          }
          const row: PlacementRow =
            decision.type === "place"
              ? {
                  thread_id: decision.threadId,
                  group_id: decision.groupId,
                  source: "organizer",
                  reason: decision.reason,
                  // An automatic move can always be undone back to unassigned.
                  undo_available: decision.groupId === null ? 0 : 1,
                  previous_group_id: null,
                  suggestion_json: null,
                  updated_at: now,
                }
              : {
                  thread_id: decision.threadId,
                  group_id: null,
                  source: "organizer",
                  reason: decision.suggestion.reason,
                  undo_available: 0,
                  previous_group_id: null,
                  suggestion_json: encodeSuggestion(decision.suggestion),
                  updated_at: now,
                };
          yield* sql`
            INSERT INTO personal_thread_placements (
              thread_id, group_id, source, reason, undo_available, previous_group_id, suggestion_json, updated_at
            ) VALUES (
              ${row.thread_id}, ${row.group_id}, 'organizer', ${row.reason}, ${row.undo_available},
              NULL, ${row.suggestion_json}, ${row.updated_at}
            )
            ON CONFLICT(thread_id) DO UPDATE SET
              group_id = excluded.group_id,
              reason = excluded.reason,
              undo_available = excluded.undo_available,
              previous_group_id = NULL,
              suggestion_json = excluded.suggestion_json,
              updated_at = excluded.updated_at
            WHERE personal_thread_placements.source = 'organizer'
              AND personal_thread_placements.group_id IS NULL
          `.pipe(sqlError("Could not save placement."));
          written.push(toPlacement(row));
        }
        if (written.length > 0) yield* publish({ placements: written });
        return written.filter((placement) => placement.groupId !== null).length;
      }),
    );

  const listThreadDetails = (input: PersonalThreadDetailsInput) =>
    Effect.gen(function* () {
      const external =
        (yield* sql<{ found: number }>`
        SELECT 1 AS found FROM sqlite_master
        WHERE type = 'table' AND name = 'personal_external_sessions'
      `).length > 0;
      // Correlated lookups ride the (thread_id, created_at) message index.
      const rows = yield* sql<{
        thread_id: string;
        message_count: number;
        last_message: string | null;
        origin: string | null;
        origin_detail: string | null;
        native_message_count: number | null;
      }>`
        SELECT
          t.thread_id,
          (SELECT COUNT(*) FROM orchestration_v2_projection_messages m
            WHERE m.thread_id = t.thread_id) AS message_count,
          (SELECT substr(json_extract(m.payload_json, '$.text'), 1, 400)
            FROM orchestration_v2_projection_messages m
            WHERE m.thread_id = t.thread_id AND m.role IN ('user', 'assistant')
            ORDER BY m.created_at DESC LIMIT 1) AS last_message,
          ${
            external
              ? sql`e.origin AS origin, e.origin_detail AS origin_detail,
                  e.native_message_count AS native_message_count`
              : sql`NULL AS origin, NULL AS origin_detail, NULL AS native_message_count`
          }
        FROM orchestration_v2_projection_threads t
        ${external ? sql`LEFT JOIN personal_external_sessions e ON e.thread_id = t.thread_id` : sql``}
        WHERE t.deleted_at IS NULL
          ${input.threadIds === undefined ? sql`` : sql`AND t.thread_id IN ${sql.in(input.threadIds)}`}
      `;
      return {
        threads: rows.map((row) => {
          const text = row.last_message?.replace(/\s+/g, " ").trim() ?? "";
          return {
            threadId: ThreadId.make(row.thread_id),
            origin: row.origin ?? "t3",
            originDetail: row.origin_detail,
            messageCount: Math.max(
              Number(row.message_count),
              Number(row.native_message_count ?? 0),
            ),
            lastMessage:
              text.length === 0 ? null : text.length > 160 ? `${text.slice(0, 159)}…` : text,
          };
        }),
      };
    }).pipe(sqlError("Could not list thread details."));

  return PersonalOrganizationService.of({
    listThreadDetails,
    getSnapshot,
    subscribe,
    upsertGroup,
    deleteGroup,
    moveThread,
    undoMove,
    acceptSuggestion,
    resetThread,
    setOrganizerMode,
    getOrganizerStatus: Ref.get(status),
    updateOrganizerStatus,
    ensureGroupPath: (input) => mutex.withPermits(1)(ensureGroupPathUnlocked(input)),
    applyOrganizerPlacements,
    listGroups,
    getPlacement,
  });
});

export const layer = Layer.effect(PersonalOrganizationService, make);
