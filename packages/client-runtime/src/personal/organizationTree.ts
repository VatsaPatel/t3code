/**
 * Pure tree building for the organized sidebar and chat manager:
 * repo (logical project) → workstream → project → threads, merging
 * same-named groups across the environments of one logical project, with
 * attention rollups counted over unique descendant threads.
 */
import type { PersonalGroup, PersonalThreadPlacement } from "@t3tools/contracts";

import type { PersonalOrganizationState } from "./organizationState.ts";

/** Shared attention vocabulary: amber / green / red / neutral. */
export type ThreadAttention = "needs_you" | "working" | "failed" | "idle";

/**
 * Maps T3's sidebar status (`resolveSidebarThreadStatus`) onto the attention
 * vocabulary. Visit/unread state is deliberately not an input: viewing a
 * thread never clears needs-you.
 */
export function attentionFromSidebarStatus(
  status: "approval" | "input" | "working" | "waiting" | "failed" | "limited" | "ready" | string,
  thread: { readonly hasActionableProposedPlan: boolean },
): ThreadAttention {
  switch (status) {
    case "approval":
    case "input":
      return "needs_you";
    case "working":
      return "working";
    // "waiting" is a stopped run parked on background work: grey, never a
    // live working dot (a synced chat is only working when a run is active).
    case "waiting":
      return "idle";
    case "failed":
    case "limited":
      return "failed";
    default:
      return thread.hasActionableProposedPlan ? "needs_you" : "idle";
  }
}

export interface OrganizedProjectMember {
  readonly environmentId: string;
  readonly projectId: string;
}

export interface OrganizedRepoInput {
  /** Logical project key (same repo across environments). */
  readonly key: string;
  readonly label: string;
  /** The synthetic "Personal" root built from Scratch projects. */
  readonly isPersonal: boolean;
  readonly members: ReadonlyArray<OrganizedProjectMember>;
}

export interface OrganizedThreadInput {
  readonly environmentId: string;
  readonly id: string;
  readonly projectId: string;
  readonly attention: ThreadAttention;
}

export interface AttentionRollup {
  readonly needsYou: number;
  readonly working: number;
  readonly failed: number;
  readonly total: number;
}

export interface OrganizedThreadLeaf<T extends OrganizedThreadInput> {
  readonly key: string;
  readonly thread: T;
  readonly placement: PersonalThreadPlacement | null;
}

export interface OrganizedGroupMember extends OrganizedProjectMember {
  readonly groupId: string;
}

export interface OrganizedGroupNode<T extends OrganizedThreadInput> {
  readonly kind: "workstream" | "project";
  /** Stable across environments: repo key + lowercased name path. */
  readonly key: string;
  readonly repoKey: string;
  readonly name: string;
  /** [workstream] or [workstream, project]. */
  readonly path: ReadonlyArray<string>;
  /** One entry per environment that has this group. */
  readonly members: ReadonlyArray<OrganizedGroupMember>;
  readonly children: ReadonlyArray<OrganizedGroupNode<T>>;
  readonly threads: ReadonlyArray<OrganizedThreadLeaf<T>>;
  readonly rollup: AttentionRollup;
}

export interface OrganizedRepoNode<T extends OrganizedThreadInput> {
  readonly kind: "repo";
  readonly key: string;
  readonly label: string;
  readonly isPersonal: boolean;
  readonly members: ReadonlyArray<OrganizedProjectMember>;
  readonly children: ReadonlyArray<OrganizedGroupNode<T>>;
  /** Unassigned threads, shown after the repo's workstreams. */
  readonly threads: ReadonlyArray<OrganizedThreadLeaf<T>>;
  readonly rollup: AttentionRollup;
}

export type OrganizedNode<T extends OrganizedThreadInput> =
  | OrganizedRepoNode<T>
  | OrganizedGroupNode<T>;

export const organizedThreadKey = (thread: { environmentId: string; id: string }) =>
  `${thread.environmentId}:${thread.id}`;

const nameKey = (name: string) => name.trim().toLocaleLowerCase();

interface MutableGroupNode<T extends OrganizedThreadInput> {
  kind: "workstream" | "project";
  key: string;
  repoKey: string;
  name: string;
  sortKey: string;
  path: string[];
  members: OrganizedGroupMember[];
  children: MutableGroupNode<T>[];
  threads: OrganizedThreadLeaf<T>[];
}

const compareGroups = (
  left: { sortKey: string; name: string },
  right: { sortKey: string; name: string },
) =>
  left.sortKey.localeCompare(right.sortKey) ||
  left.name.localeCompare(right.name, undefined, { sensitivity: "base" });

/** Thread keys by attention, unioned bottom-up so a thread is counted once. */
interface AttentionSets {
  readonly needsYou: Set<string>;
  readonly working: Set<string>;
  readonly failed: Set<string>;
  readonly all: Set<string>;
}

function emptySets(): AttentionSets {
  return { needsYou: new Set(), working: new Set(), failed: new Set(), all: new Set() };
}

function addLeaves<T extends OrganizedThreadInput>(
  sets: AttentionSets,
  leaves: ReadonlyArray<OrganizedThreadLeaf<T>>,
) {
  for (const leaf of leaves) {
    sets.all.add(leaf.key);
    if (leaf.thread.attention === "needs_you") sets.needsYou.add(leaf.key);
    else if (leaf.thread.attention === "working") sets.working.add(leaf.key);
    else if (leaf.thread.attention === "failed") sets.failed.add(leaf.key);
  }
}

function mergeSets(target: AttentionSets, source: AttentionSets) {
  for (const key of source.needsYou) target.needsYou.add(key);
  for (const key of source.working) target.working.add(key);
  for (const key of source.failed) target.failed.add(key);
  for (const key of source.all) target.all.add(key);
}

const rollupOf = (sets: AttentionSets): AttentionRollup => ({
  needsYou: sets.needsYou.size,
  working: sets.working.size,
  failed: sets.failed.size,
  total: sets.all.size,
});

function freezeGroup<T extends OrganizedThreadInput>(
  node: MutableGroupNode<T>,
): { readonly node: OrganizedGroupNode<T>; readonly sets: AttentionSets } {
  const sets = emptySets();
  addLeaves(sets, node.threads);
  const children = [...node.children].sort(compareGroups).map((child) => {
    const frozen = freezeGroup(child);
    mergeSets(sets, frozen.sets);
    return frozen.node;
  });
  return {
    node: {
      kind: node.kind,
      key: node.key,
      repoKey: node.repoKey,
      name: node.name,
      path: node.path,
      members: node.members,
      children,
      threads: node.threads,
      rollup: rollupOf(sets),
    },
    sets,
  };
}

/**
 * Builds the organized tree. Threads keep the caller's order within a node;
 * groups sort by sort key then name. Threads whose project is not part of any
 * repo are omitted. Repos with neither threads nor groups are dropped.
 */
export function buildOrganizedTree<T extends OrganizedThreadInput>(input: {
  readonly repos: ReadonlyArray<OrganizedRepoInput>;
  readonly threads: ReadonlyArray<T>;
  readonly organizationByEnvironment: ReadonlyMap<string, PersonalOrganizationState | null>;
}): ReadonlyArray<OrganizedRepoNode<T>> {
  const repoByMember = new Map<string, OrganizedRepoInput>();
  for (const repo of input.repos) {
    for (const member of repo.members) {
      repoByMember.set(`${member.environmentId}:${member.projectId}`, repo);
    }
  }

  const workstreamsByRepo = new Map<string, Map<string, MutableGroupNode<T>>>();
  const nodeByGroup = new Map<string, MutableGroupNode<T>>();
  const unassignedByRepo = new Map<string, OrganizedThreadLeaf<T>[]>();

  const groupsByMember = new Map<string, PersonalGroup[]>();
  for (const [environmentId, state] of input.organizationByEnvironment) {
    if (state === null) continue;
    for (const group of Object.values(state.groupsById)) {
      const memberKey = `${environmentId}:${group.projectId}`;
      const list = groupsByMember.get(memberKey) ?? [];
      list.push(group);
      groupsByMember.set(memberKey, list);
    }
  }

  for (const repo of input.repos) {
    const workstreams = new Map<string, MutableGroupNode<T>>();
    workstreamsByRepo.set(repo.key, workstreams);
    unassignedByRepo.set(repo.key, []);
    for (const member of repo.members) {
      const groups = groupsByMember.get(`${member.environmentId}:${member.projectId}`) ?? [];
      // Workstreams first so projects can attach to them by parent id.
      for (const group of groups.filter((entry) => entry.parentId === null)) {
        const key = `${repo.key}/${nameKey(group.name)}`;
        let node = workstreams.get(nameKey(group.name));
        if (node === undefined) {
          node = {
            kind: "workstream",
            key,
            repoKey: repo.key,
            name: group.name,
            sortKey: group.sortKey,
            path: [group.name],
            members: [],
            children: [],
            threads: [],
          };
          workstreams.set(nameKey(group.name), node);
        }
        node.members.push({ ...member, groupId: group.id });
        nodeByGroup.set(`${member.environmentId}:${group.id}`, node);
      }
      for (const group of groups.filter((entry) => entry.parentId !== null)) {
        const parent = nodeByGroup.get(`${member.environmentId}:${group.parentId}`);
        if (parent === undefined) continue;
        let node = parent.children.find((child) => nameKey(child.name) === nameKey(group.name));
        if (node === undefined) {
          node = {
            kind: "project",
            key: `${parent.key}/${nameKey(group.name)}`,
            repoKey: repo.key,
            name: group.name,
            sortKey: group.sortKey,
            path: [parent.name, group.name],
            members: [],
            children: [],
            threads: [],
          };
          parent.children.push(node);
        }
        node.members.push({ ...member, groupId: group.id });
        nodeByGroup.set(`${member.environmentId}:${group.id}`, node);
      }
    }
  }

  for (const thread of input.threads) {
    const repo = repoByMember.get(`${thread.environmentId}:${thread.projectId}`);
    if (repo === undefined) continue;
    const placement =
      input.organizationByEnvironment.get(thread.environmentId)?.placementsByThreadId[thread.id] ??
      null;
    const leaf: OrganizedThreadLeaf<T> = { key: organizedThreadKey(thread), thread, placement };
    const node =
      placement?.groupId == null
        ? undefined
        : nodeByGroup.get(`${thread.environmentId}:${placement.groupId}`);
    if (node === undefined) unassignedByRepo.get(repo.key)!.push(leaf);
    else node.threads.push(leaf);
  }

  const result: OrganizedRepoNode<T>[] = [];
  for (const repo of input.repos) {
    const sets = emptySets();
    const unassigned = unassignedByRepo.get(repo.key) ?? [];
    addLeaves(sets, unassigned);
    const children = [...(workstreamsByRepo.get(repo.key)?.values() ?? [])]
      .sort(compareGroups)
      .map((workstream) => {
        const frozen = freezeGroup(workstream);
        mergeSets(sets, frozen.sets);
        return frozen.node;
      });
    if (sets.all.size === 0 && children.length === 0) continue;
    result.push({
      kind: "repo",
      key: repo.key,
      label: repo.label,
      isPersonal: repo.isPersonal,
      members: repo.members,
      children,
      threads: unassigned,
      rollup: rollupOf(sets),
    });
  }
  return result;
}

export interface OrganizedGroupEntry<T extends OrganizedThreadInput> {
  readonly repo: OrganizedRepoNode<T>;
  readonly group: OrganizedGroupNode<T>;
  /** "repo › workstream › project" for pickers and search. */
  readonly label: string;
}

/** Every group node in tree order, for pickers and grouped search. */
export function flattenOrganizedGroups<T extends OrganizedThreadInput>(
  tree: ReadonlyArray<OrganizedRepoNode<T>>,
): ReadonlyArray<OrganizedGroupEntry<T>> {
  const entries: OrganizedGroupEntry<T>[] = [];
  const visit = (repo: OrganizedRepoNode<T>, group: OrganizedGroupNode<T>) => {
    entries.push({ repo, group, label: [repo.label, ...group.path].join(" › ") });
    for (const child of group.children) visit(repo, child);
  };
  for (const repo of tree) for (const group of repo.children) visit(repo, group);
  return entries;
}

/** Keys of every thread below a node (for scoped search and filters). */
export function collectOrganizedThreadKeys<T extends OrganizedThreadInput>(
  node: OrganizedNode<T>,
): Set<string> {
  const keys = new Set<string>();
  const visit = (current: OrganizedNode<T>) => {
    for (const leaf of current.threads) keys.add(leaf.key);
    for (const child of current.children) visit(child);
  };
  visit(node);
  return keys;
}

/** Group names from workstream down for one placement, or [] when unassigned. */
export function resolveGroupPath(
  state: PersonalOrganizationState | null | undefined,
  groupId: string | null | undefined,
): ReadonlyArray<string> {
  if (state == null || groupId == null) return [];
  const group = state.groupsById[groupId];
  if (group === undefined) return [];
  const parent = group.parentId === null ? undefined : state.groupsById[group.parentId];
  return parent === undefined ? [group.name] : [parent.name, group.name];
}
