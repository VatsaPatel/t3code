/**
 * The organized "Workspaces" tree for the web client: T3's logical project
 * grouping (repos across environments) plus personal organization groups and
 * placements, with attention resolved through T3's sidebar status.
 */
import { useAtomValue } from "@effect/atom-react";
import {
  attentionFromSidebarStatus,
  buildOrganizedTree,
  flattenOrganizedGroups,
  organizedThreadKey,
  resolveGroupPath,
  type OrganizedGroupEntry,
  type OrganizedRepoInput,
  type OrganizedRepoNode,
  type ThreadAttention,
} from "@t3tools/client-runtime/personal/organizationTree";
import type { PersonalOrganizationState } from "@t3tools/client-runtime/personal/organizationState";
import { buildProjectGroups, selectProjectGroupingSettings } from "../../logicalProject";
import { isScratchProject } from "@t3tools/client-runtime/state/projects";
import type { EnvironmentId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/unstable/reactivity";
import { useMemo } from "react";

import {
  isSidebarSubagentThread,
  resolveSidebarThreadStatus,
} from "../../components/Sidebar.logic";
import { useClientSettings } from "../../hooks/useSettings";
import { useProjects, useServerConfigs, useThreadShells } from "../../state/entities";
import { useConnectedEnvironmentIds } from "../../state/environments";
import type { SidebarThreadSummary } from "../../types";
import { personalOrganizationEnvironment } from "../personalOrganization";

export const PERSONAL_REPO_KEY = "personal";
export const PERSONAL_REPO_LABEL = "Personal";

export interface WorkspaceThread {
  readonly environmentId: EnvironmentId;
  readonly id: SidebarThreadSummary["id"];
  readonly projectId: SidebarThreadSummary["projectId"];
  readonly attention: ThreadAttention;
  readonly activityAt: number;
  readonly shell: SidebarThreadSummary;
}

export type WorkspaceRepo = OrganizedRepoNode<WorkspaceThread>;
export type WorkspaceGroupEntry = OrganizedGroupEntry<WorkspaceThread>;

const EMPTY_STATES_ATOM = Atom.make(
  new Map<string, PersonalOrganizationState | null>() as ReadonlyMap<
    string,
    PersonalOrganizationState | null
  >,
);

/** Live organization state for every connected environment (one subscription each). */
export function useOrganizationByEnvironment(): ReadonlyMap<
  string,
  PersonalOrganizationState | null
> {
  const environmentIds = useConnectedEnvironmentIds();
  const atom = useMemo(
    () =>
      environmentIds.length === 0
        ? EMPTY_STATES_ATOM
        : Atom.make(
            (get) =>
              new Map(
                environmentIds.map((environmentId) => [
                  environmentId as string,
                  Option.getOrNull(
                    AsyncResult.value(
                      get(
                        personalOrganizationEnvironment.organizationLive({
                          environmentId,
                          input: {},
                        }),
                      ),
                    ),
                  ),
                ]),
              ) as ReadonlyMap<string, PersonalOrganizationState | null>,
          ).pipe(Atom.withLabel(`web:personal-organization:${environmentIds.join(",")}`)),
    [environmentIds],
  );
  return useAtomValue(atom);
}

const ATTENTION_RANK: Record<ThreadAttention, number> = {
  needs_you: 0,
  working: 1,
  failed: 2,
  idle: 3,
};

export function threadAttention(thread: SidebarThreadSummary): ThreadAttention {
  return attentionFromSidebarStatus(resolveSidebarThreadStatus(thread), thread);
}

function activityTime(thread: SidebarThreadSummary): number {
  const time = Date.parse(thread.updatedAt);
  return Number.isFinite(time) ? time : 0;
}

/** Waiting first, then working, then most recent. */
export function compareWorkspaceThreads(left: WorkspaceThread, right: WorkspaceThread): number {
  return (
    ATTENTION_RANK[left.attention] - ATTENTION_RANK[right.attention] ||
    right.activityAt - left.activityAt
  );
}

export interface WorkspaceTree {
  readonly repos: ReadonlyArray<WorkspaceRepo>;
  readonly groups: ReadonlyArray<WorkspaceGroupEntry>;
  readonly organizationByEnvironment: ReadonlyMap<string, PersonalOrganizationState | null>;
  readonly threadByKey: ReadonlyMap<string, WorkspaceThread>;
  /** Group path (workstream[, project]) for a thread, or [] when unsorted. */
  readonly groupPathOf: (thread: { environmentId: string; id: string }) => ReadonlyArray<string>;
  /** The repo a thread belongs to. */
  readonly repoOf: (thread: { environmentId: string; projectId: string }) => WorkspaceRepo | null;
}

export function useWorkspaceTree(): WorkspaceTree {
  const projects = useProjects();
  const shells = useThreadShells();
  const serverConfigs = useServerConfigs();
  const groupingSettings = useClientSettings(selectProjectGroupingSettings);
  const organizationByEnvironment = useOrganizationByEnvironment();

  const repos = useMemo((): ReadonlyArray<OrganizedRepoInput> => {
    const live = projects;
    const scratch = live.filter((project) =>
      isScratchProject(project, serverConfigs.get(project.environmentId)?.scratchWorkspaceRoot),
    );
    const scratchKeys = new Set(scratch.map((project) => `${project.environmentId}:${project.id}`));
    const groups = buildProjectGroups({
      projects: live.filter(
        (project) => !scratchKeys.has(`${project.environmentId}:${project.id}`),
      ),
      settings: groupingSettings,
    });
    const result: OrganizedRepoInput[] = [];
    if (scratch.length > 0) {
      result.push({
        key: PERSONAL_REPO_KEY,
        label: PERSONAL_REPO_LABEL,
        isPersonal: true,
        members: scratch.map((project) => ({
          environmentId: project.environmentId,
          projectId: project.id,
        })),
      });
    }
    for (const group of groups) {
      result.push({
        key: group.key,
        label: group.label,
        isPersonal: false,
        members: group.members.map((member) => ({
          environmentId: member.project.environmentId,
          projectId: member.project.id,
        })),
      });
    }
    return result;
  }, [groupingSettings, projects, serverConfigs]);

  const threads = useMemo(() => {
    const list: WorkspaceThread[] = [];
    for (const shell of shells) {
      if (shell.archivedAt !== null || shell.deletedAt != null || isSidebarSubagentThread(shell)) {
        continue;
      }
      list.push({
        environmentId: shell.environmentId,
        id: shell.id,
        projectId: shell.projectId,
        attention: threadAttention(shell),
        activityAt: activityTime(shell),
        shell,
      });
    }
    return list.sort(compareWorkspaceThreads);
  }, [shells]);

  return useMemo((): WorkspaceTree => {
    const built = buildOrganizedTree({ repos, threads, organizationByEnvironment });
    // Personal first, then repos by their latest activity.
    const latest = (repo: WorkspaceRepo) => {
      let max = 0;
      const visit = (node: {
        threads: ReadonlyArray<{ thread: WorkspaceThread }>;
        children: ReadonlyArray<unknown>;
      }) => {
        for (const leaf of node.threads) max = Math.max(max, leaf.thread.activityAt);
        for (const child of node.children as ReadonlyArray<typeof node>) visit(child);
      };
      visit(repo);
      return max;
    };
    const ordered = built
      .map((repo) => ({ repo, latest: latest(repo) }))
      .sort(
        (left, right) =>
          Number(right.repo.isPersonal) - Number(left.repo.isPersonal) ||
          right.latest - left.latest,
      )
      .map((entry) => entry.repo);
    const threadByKey = new Map(threads.map((thread) => [organizedThreadKey(thread), thread]));
    const repoByMember = new Map<string, WorkspaceRepo>();
    for (const repo of ordered) {
      for (const member of repo.members) {
        repoByMember.set(`${member.environmentId}:${member.projectId}`, repo);
      }
    }
    return {
      repos: ordered,
      groups: flattenOrganizedGroups(ordered),
      organizationByEnvironment,
      threadByKey,
      groupPathOf: (thread) => {
        const state = organizationByEnvironment.get(thread.environmentId);
        return resolveGroupPath(state, state?.placementsByThreadId[thread.id]?.groupId);
      },
      repoOf: (thread) => repoByMember.get(`${thread.environmentId}:${thread.projectId}`) ?? null,
    };
  }, [organizationByEnvironment, repos, threads]);
}
