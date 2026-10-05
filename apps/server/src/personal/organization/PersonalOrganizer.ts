/**
 * Background organizer: files unplaced threads into workstream/project groups.
 *
 * Runs off the UI path on the shared Scheduler tick. Each pass is cheap when
 * there is nothing to do (one indexed count), applies deterministic rules
 * first, then asks the user's configured text-generation model about a small
 * batch. Failures back off exponentially. The organizer only ever writes
 * threads without a placement row (or with a pending suggestion), so a user
 * decision and an earlier organizer placement are never reshuffled.
 *
 * @module PersonalOrganizer
 */
import {
  PersonalGroupId,
  ProjectId,
  ThreadId,
  type PersonalOrganizerStatus,
  type ServerSettings,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as Scheduler from "../../scheduling/Scheduler.ts";
import {
  buildClassificationPrompt,
  ClassificationOutput,
  decideDeterministic,
  validateClassification,
  type GroupTreeEntry,
  type OrganizerThreadInput,
} from "./classification.ts";
import {
  PersonalOrganizationService,
  type OrganizerPlacement,
} from "./PersonalOrganizationService.ts";

export const ORGANIZER_LIMITS = {
  /** A new thread waits this long before the organizer looks (lets the title settle). */
  debounceMs: 15_000,
  /** An untitled thread is classified anyway after this long. */
  untitledGraceMs: 3 * 60_000,
  candidateScan: 200,
  llmBatchSize: 12,
  llmPerCallSize: 8,
  maxNewGroupsPerRun: 4,
  minLlmIntervalMs: 20_000,
  backoffBaseMs: 30_000,
  backoffMaxMs: 30 * 60_000,
  suggestionsPerPass: 50,
} as const;

/** One structured-output classification call. */
export interface ClassifyRequest {
  readonly cwd: string | null;
  readonly prompt: string;
}

export class OrganizerClassifier extends Context.Service<
  OrganizerClassifier,
  {
    /** Whether a model can classify right now, with a human-readable reason when not. */
    readonly availability: Effect.Effect<{
      readonly available: boolean;
      readonly detail: string | null;
    }>;
    readonly classify: (
      request: ClassifyRequest,
    ) => Effect.Effect<unknown, { readonly message: string }>;
  }
>()("t3/personal/organization/PersonalOrganizer/OrganizerClassifier") {}

export class PersonalOrganizer extends Context.Service<
  PersonalOrganizer,
  {
    /** Starts a pass now (ignoring backoff and pacing) without waiting for it. */
    readonly runNow: () => Effect.Effect<PersonalOrganizerStatus>;
    /** One full pass; exposed for tests and callers that want to await it. */
    readonly runPass: (options?: { readonly force?: boolean }) => Effect.Effect<void>;
  }
>()("t3/personal/organization/PersonalOrganizer") {}

interface CandidateRow {
  readonly thread_id: string;
  readonly project_id: string;
  readonly title: string;
  readonly provider: string | null;
  readonly parent_thread_id: string | null;
  readonly origin: string | null;
  readonly origin_detail: string | null;
}

const isoFromMillis = (millis: number) => DateTime.formatIso(DateTime.makeUnsafe(millis));

const errorMessage = (cause: unknown) =>
  typeof cause === "object" && cause !== null && "message" in cause
    ? String((cause as { message: unknown }).message)
    : String(cause);

export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const store = yield* PersonalOrganizationService;
  const classifier = yield* OrganizerClassifier;
  const scope = yield* Effect.scope;
  const permit = yield* Semaphore.make(1);
  const failures = yield* Ref.make(0);
  const lastLlmAt = yield* Ref.make(0);

  const hasExternalSessions = sql<{ found: number }>`
    SELECT 1 AS found FROM sqlite_master
    WHERE type = 'table' AND name = 'personal_external_sessions'
  `.pipe(Effect.map((rows) => rows.length > 0));

  const listCandidates = (nowMs: number, withExternal: boolean) => {
    const debounceCutoff = isoFromMillis(nowMs - ORGANIZER_LIMITS.debounceMs);
    const untitledCutoff = isoFromMillis(nowMs - ORGANIZER_LIMITS.untitledGraceMs);
    const external = withExternal
      ? sql`
          e.origin AS origin,
          e.origin_detail AS origin_detail,
          CASE WHEN e.parent_native_session_id IS NOT NULL
            THEN 'import:' || e.provider_instance_id || ':' || e.parent_native_session_id END
            AS external_parent
        `
      : sql`NULL AS origin, NULL AS origin_detail, NULL AS external_parent`;
    const externalJoin = withExternal
      ? sql`LEFT JOIN personal_external_sessions e ON e.thread_id = t.thread_id`
      : sql``;
    return sql<CandidateRow & { readonly external_parent: string | null }>`
      SELECT
        t.thread_id,
        t.project_id,
        t.title,
        json_extract(t.payload_json, '$.providerInstanceId') AS provider,
        json_extract(t.payload_json, '$.lineage.parentThreadId') AS parent_thread_id,
        ${external}
      FROM orchestration_v2_projection_threads t
      LEFT JOIN personal_thread_placements p ON p.thread_id = t.thread_id
      ${externalJoin}
      WHERE p.thread_id IS NULL
        AND t.deleted_at IS NULL
        AND t.archived_at IS NULL
        AND t.created_at <= ${debounceCutoff}
        AND (t.title <> 'New thread' OR t.created_at <= ${untitledCutoff})
      ORDER BY t.updated_at DESC
      LIMIT ${ORGANIZER_LIMITS.candidateScan}
    `.pipe(
      Effect.map((rows) =>
        rows.map((row): CandidateRow => ({
          ...row,
          parent_thread_id: row.parent_thread_id ?? row.external_parent,
        })),
      ),
    );
  };

  const countPending = sql<{ count: number }>`
    SELECT COUNT(*) AS count
    FROM orchestration_v2_projection_threads t
    LEFT JOIN personal_thread_placements p ON p.thread_id = t.thread_id
    WHERE p.thread_id IS NULL AND t.deleted_at IS NULL AND t.archived_at IS NULL
  `.pipe(Effect.map((rows) => Number(rows[0]?.count ?? 0)));

  const parentStates = (ids: ReadonlyArray<string>) =>
    ids.length === 0
      ? Effect.succeed(new Map<string, { state: "placed" | "pending"; groupId: string | null }>())
      : sql<{ thread_id: string; placed: number; group_id: string | null }>`
          SELECT t.thread_id, p.thread_id IS NOT NULL AS placed, p.group_id
          FROM orchestration_v2_projection_threads t
          LEFT JOIN personal_thread_placements p ON p.thread_id = t.thread_id
          WHERE t.thread_id IN ${sql.in(ids)} AND t.deleted_at IS NULL
        `.pipe(
          Effect.map(
            (rows) =>
              new Map(
                rows.map((row) => [
                  row.thread_id,
                  {
                    state: row.placed ? ("placed" as const) : ("pending" as const),
                    groupId: row.group_id,
                  },
                ]),
              ),
          ),
        );

  const firstUserMessage = (threadId: string) =>
    sql<{ text: string | null }>`
      SELECT json_extract(payload_json, '$.text') AS text
      FROM orchestration_v2_projection_messages
      WHERE thread_id = ${threadId} AND role = 'user'
      ORDER BY created_at ASC
      LIMIT 1
    `.pipe(Effect.map((rows) => rows[0]?.text ?? null));

  const projectInfo = (projectId: string) =>
    sql<{ title: string; workspace_root: string | null }>`
      SELECT title, workspace_root FROM projection_projects WHERE project_id = ${projectId}
    `.pipe(Effect.map((rows) => rows[0] ?? null));

  const groupTree = (projectId: ProjectId) =>
    store.listGroups(projectId).pipe(
      Effect.map((groups): GroupTreeEntry[] =>
        groups
          .filter((group) => group.parentId === null)
          .map((workstream) => ({
            workstream: workstream.name,
            projects: groups
              .filter((group) => group.parentId === workstream.id)
              .map((group) => group.name),
          })),
      ),
    );

  /** Turn a named path into a decision for the current mode. */
  const decide = (
    mode: "auto" | "suggest",
    thread: Pick<CandidateRow, "thread_id" | "project_id">,
    path: { readonly workstream: string; readonly project: string | null; readonly reason: string },
  ) =>
    mode === "suggest"
      ? Effect.succeed<OrganizerPlacement>({
          type: "suggest",
          threadId: ThreadId.make(thread.thread_id),
          suggestion: { workstream: path.workstream, project: path.project, reason: path.reason },
        })
      : store
          .ensureGroupPath({
            projectId: ProjectId.make(thread.project_id),
            workstream: path.workstream,
            project: path.project,
            createdBy: "organizer",
          })
          .pipe(
            Effect.map((groupId): OrganizerPlacement => ({
              type: "place",
              threadId: ThreadId.make(thread.thread_id),
              groupId,
              reason: path.reason,
            })),
          );

  /** Auto mode adopts suggestions left over from suggest mode. */
  const adoptSuggestions = Effect.gen(function* () {
    const snapshot = yield* store.getSnapshot();
    const pending = snapshot.placements
      .filter((placement) => placement.suggestion !== undefined && placement.groupId === null)
      .filter((placement) => placement.source === "organizer")
      .slice(0, ORGANIZER_LIMITS.suggestionsPerPass);
    if (pending.length === 0) return 0;
    const projects = yield* sql<{ thread_id: string; project_id: string }>`
      SELECT thread_id, project_id FROM orchestration_v2_projection_threads
      WHERE thread_id IN ${sql.in(pending.map((placement) => placement.threadId))}
    `;
    const projectByThread = new Map(projects.map((row) => [row.thread_id, row.project_id]));
    const decisions: OrganizerPlacement[] = [];
    for (const placement of pending) {
      const projectId = projectByThread.get(placement.threadId);
      if (projectId === undefined || placement.suggestion === undefined) continue;
      decisions.push(
        yield* decide(
          "auto",
          { thread_id: placement.threadId, project_id: projectId },
          {
            workstream: placement.suggestion.workstream,
            project: placement.suggestion.project,
            reason: placement.suggestion.reason ?? "Organizer suggestion",
          },
        ),
      );
    }
    return yield* store.applyOrganizerPlacements(decisions);
  });

  const classifyBatch = Effect.fn("PersonalOrganizer.classifyBatch")(function* (
    mode: "auto" | "suggest",
    threads: ReadonlyArray<CandidateRow>,
  ) {
    const byProject = new Map<string, CandidateRow[]>();
    for (const thread of threads) {
      const list = byProject.get(thread.project_id) ?? [];
      if (list.length < ORGANIZER_LIMITS.llmPerCallSize) list.push(thread);
      byProject.set(thread.project_id, list);
    }
    let newGroupBudget: number = ORGANIZER_LIMITS.maxNewGroupsPerRun;
    let placed = 0;
    for (const [projectId, batch] of byProject) {
      const project = yield* projectInfo(projectId);
      const tree = yield* groupTree(ProjectId.make(projectId));
      const inputs: OrganizerThreadInput[] = [];
      for (const thread of batch) {
        inputs.push({
          threadId: thread.thread_id,
          projectId: thread.project_id,
          title: thread.title,
          provider: thread.provider ?? "unknown",
          origin: thread.origin,
          originDetail: thread.origin_detail,
          firstUserMessage: yield* firstUserMessage(thread.thread_id),
          parentThreadId: thread.parent_thread_id,
        });
      }
      const output = yield* classifier.classify({
        cwd: project?.workspace_root ?? null,
        prompt: buildClassificationPrompt({
          repoName: project?.title ?? "Personal",
          tree,
          threads: inputs,
        }),
      });
      const answers = validateClassification({
        output,
        threadIds: new Set(batch.map((thread) => thread.thread_id)),
        tree,
        maxNewGroups: newGroupBudget,
      });
      const knownBefore = new Set(
        tree.flatMap((entry) => [
          entry.workstream.toLowerCase(),
          ...entry.projects.map((name) => `${entry.workstream}/${name}`.toLowerCase()),
        ]),
      );
      const created = new Set<string>();
      for (const answer of answers) {
        if (!knownBefore.has(answer.workstream.toLowerCase()))
          created.add(answer.workstream.toLowerCase());
        if (answer.project !== null) {
          const key = `${answer.workstream}/${answer.project}`.toLowerCase();
          if (!knownBefore.has(key)) created.add(key);
        }
      }
      newGroupBudget = Math.max(0, newGroupBudget - created.size);
      const answered = new Map(answers.map((answer) => [answer.threadId, answer]));
      const decisions: OrganizerPlacement[] = [];
      for (const thread of batch) {
        const answer = answered.get(thread.thread_id);
        decisions.push(
          answer === undefined
            ? {
                // Looked at but not classifiable: leave it at the repo root
                // and do not ask again until the user resets it.
                type: "place",
                threadId: ThreadId.make(thread.thread_id),
                groupId: null,
                reason: "Organizer could not classify this thread",
              }
            : yield* decide(mode, thread, answer),
        );
      }
      placed += yield* store.applyOrganizerPlacements(decisions);
    }
    return placed;
  });

  const pass = Effect.fn("PersonalOrganizer.pass")(function* (force: boolean) {
    const status = yield* store.getOrganizerStatus;
    if (status.mode === "off") return;
    const nowMs = yield* Clock.currentTimeMillis;
    const availability = yield* classifier.availability;
    yield* store.updateOrganizerStatus({
      classifierAvailable: availability.available,
      classifierDetail: availability.detail,
      pendingCount: yield* countPending,
    });

    let placed = 0;
    if (status.mode === "auto") placed += yield* adoptSuggestions;

    const candidates = yield* listCandidates(nowMs, yield* hasExternalSessions);
    if (candidates.length === 0) {
      if (placed > 0) yield* store.updateOrganizerStatus({ pendingCount: yield* countPending });
      return;
    }

    // Deterministic rules first: they need no model and never fail.
    const parents = yield* parentStates(
      candidates.flatMap((thread) => (thread.parent_thread_id ? [thread.parent_thread_id] : [])),
    );
    const deterministic: OrganizerPlacement[] = [];
    const remaining: CandidateRow[] = [];
    for (const thread of candidates) {
      const decision = decideDeterministic(
        {
          threadId: thread.thread_id,
          projectId: thread.project_id,
          title: thread.title,
          provider: thread.provider ?? "unknown",
          origin: thread.origin,
          originDetail: thread.origin_detail,
          firstUserMessage: null,
          parentThreadId: thread.parent_thread_id,
        },
        (id) => parents.get(id)?.state ?? "missing",
      );
      switch (decision.type) {
        case "follow-parent": {
          const groupId = parents.get(decision.parentThreadId)?.groupId ?? null;
          deterministic.push({
            type: "place",
            threadId: ThreadId.make(thread.thread_id),
            groupId: groupId === null ? null : PersonalGroupId.make(groupId),
            reason: "Follows its parent thread",
          });
          break;
        }
        case "path":
          deterministic.push(yield* decide(status.mode, thread, decision.path));
          break;
        case "wait-for-parent":
          break;
        case "none":
          remaining.push(thread);
      }
    }
    placed += yield* store.applyOrganizerPlacements(deterministic);

    const llmDue =
      force ||
      (nowMs - (yield* Ref.get(lastLlmAt)) >= ORGANIZER_LIMITS.minLlmIntervalMs &&
        (status.nextAttemptAt === null || Date.parse(status.nextAttemptAt) <= nowMs));
    const batch = remaining.slice(0, ORGANIZER_LIMITS.llmBatchSize);
    if (!availability.available || !llmDue || batch.length === 0) {
      if (deterministic.length > 0) {
        yield* store.updateOrganizerStatus({
          lastRunAt: isoFromMillis(nowMs),
          lastRunStatus: "succeeded",
          lastRunError: null,
          lastRunPlaced: placed,
          pendingCount: yield* countPending,
        });
      }
      return;
    }

    yield* Ref.set(lastLlmAt, nowMs);
    yield* store.updateOrganizerStatus({ lastRunStatus: "running" });
    const result = yield* Effect.result(classifyBatch(status.mode, batch));
    const finishedAt = isoFromMillis(yield* Clock.currentTimeMillis);
    if (result._tag === "Success") {
      yield* Ref.set(failures, 0);
      yield* store.updateOrganizerStatus({
        lastRunAt: finishedAt,
        lastRunStatus: "succeeded",
        lastRunError: null,
        lastRunPlaced: placed + result.success,
        nextAttemptAt: null,
        pendingCount: yield* countPending,
      });
    } else {
      const attempt = yield* Ref.updateAndGet(failures, (count) => count + 1);
      const delay = Math.min(
        ORGANIZER_LIMITS.backoffBaseMs * 2 ** (attempt - 1),
        ORGANIZER_LIMITS.backoffMaxMs,
      );
      yield* Effect.logWarning("Personal organizer classification failed", {
        cause: result.failure,
      });
      yield* store.updateOrganizerStatus({
        lastRunAt: finishedAt,
        lastRunStatus: "failed",
        lastRunError: errorMessage(result.failure),
        lastRunPlaced: placed,
        nextAttemptAt: isoFromMillis(nowMs + delay),
      });
    }
  });

  const runPass = (options?: { readonly force?: boolean }) =>
    pass(options?.force === true).pipe(
      Effect.catchCause((cause) => Effect.logWarning("Personal organizer pass failed", { cause })),
      permit.withPermits(1),
    );

  const runNow = () =>
    runPass({ force: true }).pipe(Effect.forkIn(scope), Effect.andThen(store.getOrganizerStatus));

  return PersonalOrganizer.of({ runNow, runPass });
});

/** Registers the organizer on the shared Scheduler tick. */
export const layer = Layer.effect(
  PersonalOrganizer,
  Effect.gen(function* () {
    const organizer = yield* make;
    const scheduler = yield* Scheduler.Scheduler;
    yield* scheduler.register("personal-organizer", organizer.runPass());
    return organizer;
  }),
);

/** The user's text-generation model, if its driver can run a structured prompt. */
export const makeTextGenerationClassifier = (dependencies: {
  readonly getSettings: Effect.Effect<ServerSettings, { readonly message: string }>;
  readonly getTextGeneration: (
    instanceId: ServerSettings["textGenerationModelSelection"]["instanceId"],
  ) => Effect.Effect<
    | {
        readonly generateStructuredJson?: (input: {
          cwd: string;
          prompt: string;
          outputSchema: typeof ClassificationOutput;
          modelSelection: ServerSettings["textGenerationModelSelection"];
        }) => Effect.Effect<unknown, { readonly message: string }>;
      }
    | undefined
  >;
  readonly fallbackCwd: string;
}): OrganizerClassifier["Service"] => {
  const resolve = Effect.gen(function* () {
    const settings = yield* Effect.option(dependencies.getSettings);
    if (settings._tag === "None") {
      return { generate: null, detail: "Server settings are unavailable." } as const;
    }
    const selection = settings.value.textGenerationModelSelection;
    const textGeneration = yield* dependencies.getTextGeneration(selection.instanceId);
    if (textGeneration === undefined) {
      return {
        generate: null,
        detail: `Text generation provider '${selection.instanceId}' is not available.`,
      } as const;
    }
    if (textGeneration.generateStructuredJson === undefined) {
      return {
        generate: null,
        detail: `Text generation provider '${selection.instanceId}' cannot classify threads; choose a Codex or Claude model in Settings.`,
      } as const;
    }
    return { generate: textGeneration.generateStructuredJson, selection, detail: null } as const;
  });
  return OrganizerClassifier.of({
    availability: resolve.pipe(
      Effect.map((resolved) => ({
        available: resolved.generate !== null,
        detail: resolved.detail,
      })),
    ),
    classify: (request) =>
      Effect.gen(function* () {
        const resolved = yield* resolve;
        if (resolved.generate === null) {
          return yield* Effect.fail({ message: resolved.detail ?? "Organizer unavailable." });
        }
        return yield* resolved.generate({
          cwd: request.cwd ?? dependencies.fallbackCwd,
          prompt: request.prompt,
          outputSchema: ClassificationOutput,
          modelSelection: resolved.selection,
        });
      }),
  });
};
