import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, describe, it } from "@effect/vitest";
import { ProjectId, ThreadId, type PersonalGroup } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { validateClassification } from "./classification.ts";
import { PersonalOrganizationService, layer as storeLayer } from "./PersonalOrganizationService.ts";
import * as PersonalOrganizer from "./PersonalOrganizer.ts";

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const NOW = "2026-10-05T12:00:00.000Z";
const CREATED = "2026-10-05T11:00:00.000Z";
const PROJECT = ProjectId.make("project-personal");

type Answer = { threadId: string; workstream: string; project: string | null; reason: string };

/** Fake text generation: answers from a table keyed by thread id, recording each prompt. */
const fakeClassifier = (answers: Record<string, Omit<Answer, "threadId">>, prompts: string[]) =>
  Layer.succeed(PersonalOrganizer.OrganizerClassifier)({
    availability: Effect.succeed({ available: true, detail: null }),
    classify: (request) =>
      Effect.sync(() => {
        prompts.push(request.prompt);
        const ids = [...request.prompt.matchAll(/^threadId: (.+)$/gm)].map((match) => match[1]!);
        return {
          placements: ids.flatMap((threadId) =>
            answers[threadId] ? [{ threadId, ...answers[threadId] }] : [],
          ),
        };
      }),
  });

const insertThread = (thread: {
  id: string;
  title: string;
  parentThreadId?: string;
  relationship?: "subagent" | "fork";
}) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const payload = encodeJson({
      providerInstanceId: "codex",
      lineage: {
        parentThreadId: thread.parentThreadId ?? null,
        relationshipToParent: thread.relationship ?? null,
        rootThreadId: thread.parentThreadId ?? thread.id,
      },
    });
    yield* sql`
      INSERT INTO orchestration_v2_projection_threads (
        thread_id, project_id, title, default_provider, runtime_mode, interaction_mode,
        created_at, updated_at, payload_json
      ) VALUES (
        ${thread.id}, ${PROJECT}, ${thread.title}, 'codex', 'full-access', 'default',
        ${CREATED}, ${CREATED}, ${payload}
      )
    `;
  });

const setup = (answers: Record<string, Omit<Answer, "threadId">>, prompts: string[] = []) =>
  Layer.mergeAll(storeLayer, fakeClassifier(answers, prompts)).pipe(
    Layer.provideMerge(Layer.mergeAll(SqlitePersistenceMemory, NodeCrypto.layer)),
  );

const runOrganizer = Effect.gen(function* () {
  const organizer = yield* PersonalOrganizer.make;
  yield* organizer.runPass({ force: true });
});

const groupPath = (groups: ReadonlyArray<PersonalGroup>, groupId: string | null) => {
  const group = groups.find((entry) => entry.id === groupId);
  if (group === undefined) return null;
  const parent = groups.find((entry) => entry.id === group.parentId);
  return parent ? `${parent.name} / ${group.name}` : group.name;
};

const placementPath = (threadId: string) =>
  Effect.gen(function* () {
    const store = yield* PersonalOrganizationService;
    const snapshot = yield* store.getSnapshot();
    const placement = snapshot.placements.find((entry) => entry.threadId === threadId);
    return {
      path: groupPath(snapshot.groups, placement?.groupId ?? null),
      source: placement?.source ?? null,
      canUndo: placement?.undo !== undefined,
    };
  });

describe("PersonalOrganizer", () => {
  it.effect("never moves a user-placed thread and keeps its own placements sticky", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse(NOW));
      const store = yield* PersonalOrganizationService;
      yield* insertThread({ id: "user-thread", title: "Cover letter for Goodfire" });
      yield* insertThread({ id: "auto-thread", title: "Tax return questions" });
      yield* store.moveThread({
        threadId: ThreadId.make("user-thread"),
        target: { type: "path", workstream: "Job search", project: "Applications" },
      });

      yield* runOrganizer;
      assert.deepStrictEqual(yield* placementPath("user-thread"), {
        path: "Job Search / Applications",
        source: "user",
        canUndo: true,
      });
      assert.deepStrictEqual((yield* placementPath("auto-thread")).path, "Finance");

      // A reset-free second pass must not reshuffle the organizer's own choice.
      yield* runOrganizer;
      assert.deepStrictEqual((yield* placementPath("auto-thread")).path, "Finance");
    }).pipe(
      Effect.scoped,
      Effect.provide(
        setup({
          "user-thread": { workstream: "Writing", project: null, reason: "letter" },
          "auto-thread": { workstream: "finance", project: null, reason: "taxes" },
        }),
      ),
    ),
  );

  it.effect("undo restores the previous placement and locks the thread", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse(NOW));
      const store = yield* PersonalOrganizationService;
      const threadId = ThreadId.make("thread-1");
      yield* insertThread({ id: threadId, title: "Invoice for October" });

      yield* runOrganizer;
      assert.deepStrictEqual(yield* placementPath(threadId), {
        path: "Billing",
        source: "organizer",
        canUndo: true,
      });
      yield* store.undoMove({ threadId });
      assert.deepStrictEqual(yield* placementPath(threadId), {
        path: null,
        source: "user",
        canUndo: false,
      });
      // The organizer leaves an undone thread alone.
      yield* runOrganizer;
      assert.strictEqual((yield* placementPath(threadId)).path, null);

      yield* store.moveThread({
        threadId,
        target: { type: "path", workstream: "Billing", project: "Clients" },
      });
      yield* store.moveThread({
        threadId,
        target: { type: "path", workstream: "Admin", project: null },
      });
      yield* store.undoMove({ threadId });
      assert.strictEqual((yield* placementPath(threadId)).path, "Billing / Clients");
    }).pipe(
      Effect.scoped,
      Effect.provide(setup({ "thread-1": { workstream: "Billing", project: null, reason: "x" } })),
    ),
  );

  it.effect("files Hermes cron runs under Routines and subagents with their parent", () => {
    const prompts: string[] = [];
    return Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse(NOW));
      const sql = yield* SqlClient.SqlClient;
      // Created by the session-sync workstream; the organizer only reads it.
      yield* sql`
        CREATE TABLE personal_external_sessions (
          thread_id TEXT PRIMARY KEY, provider_instance_id TEXT, driver TEXT,
          native_session_id TEXT, origin TEXT, origin_detail TEXT,
          parent_native_session_id TEXT
        )
      `;
      yield* insertThread({ id: "import:hermes:cron_1", title: "Morning brief" });
      yield* sql`
        INSERT INTO personal_external_sessions
          (thread_id, provider_instance_id, driver, native_session_id, origin, origin_detail)
        VALUES ('import:hermes:cron_1', 'hermes', 'hermes', 'cron_1', 'cron',
          'daily life chief-of-staff brief')
      `;
      yield* insertThread({ id: "parent", title: "Refactor billing" });
      yield* insertThread({
        id: "child",
        title: "Subagent: read files",
        parentThreadId: "parent",
        relationship: "subagent",
      });

      // First pass: the parent is classified; the child waits for it.
      yield* runOrganizer;
      assert.strictEqual(
        (yield* placementPath("import:hermes:cron_1")).path,
        "Routines / Daily Life Chief-of-staff Brief",
      );
      assert.strictEqual((yield* placementPath("parent")).path, "Billing / Refactor");
      assert.strictEqual((yield* placementPath("child")).source, null);

      yield* runOrganizer;
      assert.strictEqual((yield* placementPath("child")).path, "Billing / Refactor");
      // Neither the cron run nor the subagent was ever sent to the model.
      assert.isFalse(prompts.some((prompt) => prompt.includes("threadId: child")));
      assert.isFalse(prompts.some((prompt) => prompt.includes("cron_1")));
    }).pipe(
      Effect.scoped,
      Effect.provide(
        setup(
          {
            parent: { workstream: "Billing", project: "Refactor", reason: "code" },
            child: { workstream: "Elsewhere", project: null, reason: "should not be asked" },
          },
          prompts,
        ),
      ),
    );
  });
});

describe("validateClassification", () => {
  const threadIds = new Set(["a", "b", "c", "d"]);
  const tree = [{ workstream: "Job Search", projects: ["Applications"] }];

  it("rejects malformed output and unknown threads", () => {
    for (const output of [null, "Job search", { placements: "nope" }, { placements: [{}] }]) {
      assert.deepStrictEqual(
        validateClassification({ output, threadIds, tree, maxNewGroups: 4 }),
        [],
      );
    }
    assert.deepStrictEqual(
      validateClassification({
        output: { placements: [{ threadId: "zzz", workstream: "X", project: null, reason: "" }] },
        threadIds,
        tree,
        maxNewGroups: 4,
      }),
      [],
    );
  });

  it("rejects over-deep paths, snaps to existing groups, and caps new groups", () => {
    const result = validateClassification({
      output: {
        placements: [
          // Three levels smuggled into one name: refused outright.
          {
            threadId: "a",
            workstream: "Job Search / Applications",
            project: "Goodfire",
            reason: "deep",
          },
          { threadId: "b", workstream: "job search", project: "applications", reason: "fits" },
          { threadId: "c", workstream: "health and fitness", project: "Running Plan", reason: "n" },
          { threadId: "d", workstream: "Travel", project: null, reason: "over budget" },
        ],
      },
      threadIds,
      tree,
      maxNewGroups: 1,
    });
    assert.deepStrictEqual(
      result.map(({ threadId, workstream, project }) => ({ threadId, workstream, project })),
      [
        { threadId: "b", workstream: "Job Search", project: "Applications" },
        // The budget allows the new workstream but not its new project.
        { threadId: "c", workstream: "Health and Fitness", project: null },
      ],
    );
  });
});
