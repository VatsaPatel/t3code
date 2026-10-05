/**
 * Organization actions for the web client: move/undo/accept with failure
 * toasts, "New chat here" with its placement applied once the draft becomes a
 * thread, and Fork for sidebar and group-page rows.
 */
import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import type {
  EnvironmentId,
  PersonalMoveTarget,
  PersonalOrganizerMode,
  ProjectId,
  ScopedThreadRef,
  ThreadId,
} from "@t3tools/contracts";
import { useRouter } from "@tanstack/react-router";
import * as Schema from "effect/Schema";
import { useCallback, useEffect } from "react";
import { create } from "zustand";

import { stackedThreadToast, toastManager } from "../../components/ui/toast";
import { useNewThreadHandler } from "../../hooks/useHandleNewThread";
import { getLocalStorageItem, setLocalStorageItem } from "../../hooks/useLocalStorage";
import { newThreadId } from "../../lib/utils";
import { useThreadShells, waitForThreadShell } from "../../state/entities";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { buildThreadRouteParams } from "../../threadRoutes";
import { personalOrganizationEnvironment as org } from "../personalOrganization";

function reportFailure<A, E>(title: string, result: AtomCommandResult<A, E>): boolean {
  if (result._tag !== "Failure") return true;
  if (!isAtomCommandInterrupted(result)) {
    const error = squashAtomCommandFailure(result);
    toastManager.add(
      stackedThreadToast({
        type: "error",
        title,
        description: error instanceof Error ? error.message : "Something went wrong.",
      }),
    );
  }
  return false;
}

/** A group addressed by name inside one environment's project. */
export interface GroupTarget {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  /** [] = the repo root, [workstream] or [workstream, project]. */
  readonly path: ReadonlyArray<string>;
}

export const moveTargetForPath = (path: ReadonlyArray<string>): PersonalMoveTarget =>
  path.length === 0
    ? { type: "unassigned" }
    : { type: "path", workstream: path[0]!, project: path[1] ?? null };

export function useOrganizationActions() {
  const move = useAtomCommand(org.moveThread, { reportFailure: false });
  const undo = useAtomCommand(org.undoMove, { reportFailure: false });
  const accept = useAtomCommand(org.acceptSuggestion, { reportFailure: false });
  const upsert = useAtomCommand(org.upsertGroup, { reportFailure: false });
  const remove = useAtomCommand(org.deleteGroup, { reportFailure: false });
  const run = useAtomCommand(org.runOrganizer, { reportFailure: false });
  const settings = useAtomCommand(org.updateOrganizerSettings, { reportFailure: false });

  return {
    moveThread: useCallback(
      async (thread: ScopedThreadRef, path: ReadonlyArray<string>) =>
        reportFailure(
          "Couldn't move chat",
          await move({
            environmentId: thread.environmentId,
            input: { threadId: thread.threadId, target: moveTargetForPath(path) },
          }),
        ),
      [move],
    ),
    undoMove: useCallback(
      async (thread: ScopedThreadRef) =>
        reportFailure(
          "Couldn't undo the move",
          await undo({ environmentId: thread.environmentId, input: { threadId: thread.threadId } }),
        ),
      [undo],
    ),
    acceptSuggestion: useCallback(
      async (thread: ScopedThreadRef) =>
        reportFailure(
          "Couldn't accept the suggestion",
          await accept({
            environmentId: thread.environmentId,
            input: { threadId: thread.threadId },
          }),
        ),
      [accept],
    ),
    renameGroup: useCallback(
      async (
        members: ReadonlyArray<{ environmentId: string; projectId: string; groupId: string }>,
        name: string,
      ) => {
        for (const member of members) {
          const ok = reportFailure(
            "Couldn't rename",
            await upsert({
              environmentId: member.environmentId as EnvironmentId,
              input: {
                id: member.groupId as never,
                projectId: member.projectId as ProjectId,
                name,
              },
            }),
          );
          if (!ok) return false;
        }
        return true;
      },
      [upsert],
    ),
    createGroup: useCallback(
      async (input: {
        environmentId: EnvironmentId;
        projectId: ProjectId;
        parentId: string | null;
        name: string;
      }) =>
        reportFailure(
          "Couldn't create the group",
          await upsert({
            environmentId: input.environmentId,
            input: {
              projectId: input.projectId,
              parentId: input.parentId as never,
              name: input.name,
            },
          }),
        ),
      [upsert],
    ),
    deleteGroup: useCallback(
      async (members: ReadonlyArray<{ environmentId: string; groupId: string }>) => {
        for (const member of members) {
          if (
            !reportFailure(
              "Couldn't delete the group",
              await remove({
                environmentId: member.environmentId as EnvironmentId,
                input: { id: member.groupId as never },
              }),
            )
          ) {
            return false;
          }
        }
        return true;
      },
      [remove],
    ),
    runOrganizer: useCallback(
      async (environmentId: EnvironmentId) =>
        reportFailure("Couldn't start the organizer", await run({ environmentId, input: {} })),
      [run],
    ),
    setOrganizerMode: useCallback(
      async (environmentId: EnvironmentId, mode: PersonalOrganizerMode) =>
        reportFailure(
          "Couldn't save organizer settings",
          await settings({ environmentId, input: { mode } }),
        ),
      [settings],
    ),
  };
}

/** Forks a chat natively and opens the copy. */
export function useForkThread() {
  const router = useRouter();
  const fork = useAtomCommand(threadEnvironment.forkThread, { reportFailure: false });
  return useCallback(
    async (thread: ScopedThreadRef) => {
      const targetThreadId = newThreadId();
      const result = await fork({
        environmentId: thread.environmentId,
        input: { sourceThreadId: thread.threadId, targetThreadId },
      });
      if (!reportFailure("Couldn't fork chat", result)) return;
      const target = scopeThreadRef(thread.environmentId, targetThreadId);
      if (await waitForThreadShell(target)) {
        void router.navigate({
          to: "/$environmentId/$threadId",
          params: buildThreadRouteParams(target),
        });
      }
    },
    [fork, router],
  );
}

// "New chat here" remembers the group for the draft's reserved thread id and
// files the thread as soon as it exists. Persisted so a reload before sending
// does not lose it; entries expire after a day.
const PENDING_KEY = "t3code:personal:pending-placements";
const PendingPlacements = Schema.Record(
  Schema.String,
  Schema.Struct({
    environmentId: Schema.String,
    path: Schema.Array(Schema.String),
    createdAt: Schema.Number,
  }),
);
type PendingPlacements = typeof PendingPlacements.Type;
const PENDING_TTL_MS = 24 * 60 * 60 * 1000;

const readPending = (): PendingPlacements => {
  try {
    return getLocalStorageItem(PENDING_KEY, PendingPlacements) ?? {};
  } catch {
    return {};
  }
};

export function useStartChatInGroup() {
  const handleNewThread = useNewThreadHandler();
  return useCallback(
    async (target: GroupTarget) => {
      const draft = await handleNewThread(scopeProjectRef(target.environmentId, target.projectId));
      if (draft === null || target.path.length === 0) return draft;
      setLocalStorageItem(
        PENDING_KEY,
        {
          ...readPending(),
          [draft.threadId]: {
            environmentId: target.environmentId,
            path: [...target.path],
            createdAt: Date.now(),
          },
        },
        PendingPlacements,
      );
      return draft;
    },
    [handleNewThread],
  );
}

/** Mounted once (in the sidebar): applies pending placements when threads appear. */
export function usePendingPlacementWatcher() {
  const shells = useThreadShells();
  const { moveThread } = useOrganizationActions();
  useEffect(() => {
    const pending = readPending();
    const ids = Object.keys(pending);
    if (ids.length === 0) return;
    const now = Date.now();
    const remaining: Record<string, PendingPlacements[string]> = {};
    const ready: Array<{ threadId: string; environmentId: string; path: ReadonlyArray<string> }> =
      [];
    for (const threadId of ids) {
      const entry = pending[threadId]!;
      const exists = shells.some(
        (shell) => shell.id === threadId && shell.environmentId === entry.environmentId,
      );
      if (exists) ready.push({ threadId, ...entry });
      else if (now - entry.createdAt < PENDING_TTL_MS) remaining[threadId] = entry;
    }
    if (ready.length === 0 && Object.keys(remaining).length === ids.length) return;
    setLocalStorageItem(PENDING_KEY, remaining, PendingPlacements);
    for (const entry of ready) {
      void moveThread(
        scopeThreadRef(entry.environmentId as EnvironmentId, entry.threadId as ThreadId),
        entry.path,
      );
    }
  }, [moveThread, shells]);
}

interface MoveDialogState {
  readonly threads: ReadonlyArray<ScopedThreadRef>;
  readonly open: (threads: ReadonlyArray<ScopedThreadRef>) => void;
  readonly close: () => void;
}

export const useMoveThreadDialogStore = create<MoveDialogState>((set) => ({
  threads: [],
  open: (threads) => set({ threads }),
  close: () => set({ threads: [] }),
}));

/** Opens the "Move to…" picker for one or more chats. */
export const openMoveThreadDialog = (threads: ReadonlyArray<ScopedThreadRef>) =>
  useMoveThreadDialogStore.getState().open(threads);
