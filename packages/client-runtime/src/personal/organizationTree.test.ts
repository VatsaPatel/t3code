import type { PersonalGroup, PersonalThreadPlacement } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  attentionFromSidebarStatus,
  buildOrganizedTree,
  flattenOrganizedGroups,
  type OrganizedThreadInput,
  type ThreadAttention,
} from "./organizationTree.ts";
import { reducePersonalOrganization, type PersonalOrganizationState } from "./organizationState.ts";

const NOW = "2026-10-05T12:00:00.000Z";

const group = (
  id: string,
  projectId: string,
  name: string,
  parentId: string | null = null,
): PersonalGroup =>
  ({
    id,
    projectId,
    parentId,
    name,
    kind: parentId === null ? "workstream" : "project",
    createdBy: "user",
    sortKey: "",
    createdAt: NOW,
    updatedAt: NOW,
  }) as PersonalGroup;

const placed = (threadId: string, groupId: string | null): PersonalThreadPlacement =>
  ({ threadId, groupId, source: "organizer", updatedAt: NOW }) as PersonalThreadPlacement;

const state = (
  groups: ReadonlyArray<PersonalGroup>,
  placements: ReadonlyArray<PersonalThreadPlacement>,
): PersonalOrganizationState =>
  reducePersonalOrganization(null, {
    type: "snapshot",
    snapshot: {
      groups,
      placements,
      organizer: {
        mode: "auto",
        classifierAvailable: true,
        classifierDetail: null,
        lastRunAt: null,
        lastRunStatus: "never",
        lastRunError: null,
        lastRunPlaced: 0,
        pendingCount: 0,
        nextAttemptAt: null,
      },
    },
  })!;

interface TestThread extends OrganizedThreadInput {
  readonly lastVisitedAt: string | null;
}

const thread = (
  environmentId: string,
  id: string,
  attention: ThreadAttention,
  projectId = "p",
): TestThread => ({ environmentId, id, projectId, attention, lastVisitedAt: null });

const repos = [
  {
    key: "repo:personal-git",
    label: "personal-git",
    isPersonal: false,
    members: [
      { environmentId: "laptop", projectId: "p" },
      { environmentId: "server", projectId: "p" },
    ],
  },
];

describe("buildOrganizedTree", () => {
  it("merges same-named groups across environments and rolls up unique threads needing you", () => {
    const laptop = state(
      [group("ws-1", "p", "Job search"), group("pr-1", "p", "Applications", "ws-1")],
      [placed("a", "pr-1"), placed("b", "ws-1")],
    );
    const server = state(
      // Same names, different ids and casing: one node in the tree.
      [group("ws-9", "p", "job search"), group("pr-9", "p", "applications", "ws-9")],
      [placed("c", "pr-9")],
    );
    const tree = buildOrganizedTree({
      repos,
      threads: [
        thread("laptop", "a", "needs_you"),
        thread("laptop", "b", "needs_you"),
        thread("server", "c", "needs_you"),
        thread("server", "d", "idle"),
      ],
      organizationByEnvironment: new Map([
        ["laptop", laptop],
        ["server", server],
      ]),
    });

    const [repo] = tree;
    expect(repo!.children).toHaveLength(1);
    const jobSearch = repo!.children[0]!;
    expect(jobSearch.members.map((member) => member.environmentId)).toEqual(["laptop", "server"]);
    expect(jobSearch.children.map((child) => child.threads.map((leaf) => leaf.thread.id))).toEqual([
      ["a", "c"],
    ]);
    // a + c under the project, b directly on the workstream: three distinct threads.
    expect(jobSearch.rollup.needsYou).toBe(3);
    expect(repo!.rollup).toEqual({ needsYou: 3, working: 0, failed: 0, total: 4 });
    // The unplaced thread sits at the repo root, after the workstreams.
    expect(repo!.threads.map((leaf) => leaf.thread.id)).toEqual(["d"]);
    expect(flattenOrganizedGroups(tree).map((entry) => entry.label)).toEqual([
      "personal-git › Job search",
      "personal-git › Job search › Applications",
    ]);
  });

  it("keeps mixed states: one needing you and two working show count 1 plus working", () => {
    const org = state(
      [group("ws", "p", "Health")],
      [placed("x", "ws"), placed("y", "ws"), placed("z", "ws")],
    );
    const build = (threads: ReadonlyArray<TestThread>) =>
      buildOrganizedTree({
        repos,
        threads,
        organizationByEnvironment: new Map([["laptop", org]]),
      })[0]!.children[0]!.rollup;

    const before = build([
      thread("laptop", "x", "needs_you"),
      thread("laptop", "y", "working"),
      thread("laptop", "z", "working"),
    ]);
    expect(before).toEqual({ needsYou: 1, working: 2, failed: 0, total: 3 });

    // Opening the thread records a visit but leaves its pending question: still needs you.
    const visited = build([
      {
        ...thread(
          "laptop",
          "x",
          attentionFromSidebarStatus("input", { hasActionableProposedPlan: false }),
        ),
        lastVisitedAt: NOW,
      },
      thread("laptop", "y", "working"),
      thread("laptop", "z", "working"),
    ]);
    expect(visited).toEqual(before);
  });
});

describe("attentionFromSidebarStatus", () => {
  it("maps T3 sidebar statuses onto the shared attention vocabulary", () => {
    const plan = { hasActionableProposedPlan: false };
    expect(attentionFromSidebarStatus("approval", plan)).toBe("needs_you");
    expect(attentionFromSidebarStatus("input", plan)).toBe("needs_you");
    expect(attentionFromSidebarStatus("waiting", plan)).toBe("idle");
    expect(attentionFromSidebarStatus("limited", plan)).toBe("failed");
    expect(attentionFromSidebarStatus("ready", plan)).toBe("idle");
    expect(attentionFromSidebarStatus("ready", { hasActionableProposedPlan: true })).toBe(
      "needs_you",
    );
  });
});

describe("reducePersonalOrganization", () => {
  it("applies deltas over the snapshot and ignores deltas before it", () => {
    expect(reducePersonalOrganization(null, { type: "delta", deletedGroupIds: [] })).toBeNull();
    const initial = state([group("ws", "p", "Finance")], [placed("t", "ws")]);
    const next = reducePersonalOrganization(initial, {
      type: "delta",
      deletedGroupIds: [group("ws", "p", "Finance").id],
      placements: [placed("t", null)],
    })!;
    expect(Object.keys(next.groupsById)).toEqual([]);
    expect(next.placementsByThreadId["t"]?.groupId).toBeNull();
  });
});
