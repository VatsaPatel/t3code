/**
 * Group page: one quiet list of a workstream or project's chats, ordered
 * waiting, working, then most recent; its projects; older chats on demand;
 * and one footer line when the organizer filed chats here today.
 */
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { collectOrganizedThreadKeys } from "@t3tools/client-runtime/personal/organizationTree";
import type {
  EnvironmentId,
  PersonalThreadDetail,
  ProjectId,
  ScopedThreadRef,
} from "@t3tools/contracts";
import { useRouter } from "@tanstack/react-router";
import { EllipsisIcon, GitBranchIcon, PlusIcon, SparklesIcon } from "lucide-react";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/unstable/reactivity";
import { useAtomValue } from "@effect/atom-react";
import { useCallback, useMemo, useState, type MouseEvent } from "react";

import { WorkspacePageHeader } from "../../components/WorkspacePageHeader";
import { Button } from "../../components/ui/button";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "../../components/ui/menu";
import { SidebarInset } from "../../components/ui/sidebar";
import { isElectron } from "../../env";
import { useThreadActions } from "../../hooks/useThreadActions";
import { readLocalApi } from "../../localApi";
import { cn } from "../../lib/utils";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { buildThreadRouteParams } from "../../threadRoutes";
import { AttentionDot } from "../organization/AttentionDot";
import { preferredGroupMember, useOpenGroupPage } from "../organization/groupNavigation";
import {
  openMoveThreadDialog,
  useForkThread,
  useOrganizationActions,
  useStartChatInGroup,
} from "../organization/organizationActions";
import {
  compareWorkspaceThreads,
  useWorkspaceTree,
  type WorkspaceGroupEntry,
  type WorkspaceThread,
} from "../organization/workspaceTree";
import { personalOrganizationEnvironment } from "../personalOrganization";
import { GroupNameDialog } from "./GroupNameDialog";

const INITIAL_ROWS = 12;
const ORIGIN_WORDS: Record<string, string> = {
  cron: "Cron",
  slack: "Slack",
  whatsapp: "WhatsApp",
  cli: "CLI",
  desktop: "Desktop",
  tui: "TUI",
  acp: "ACP",
  webui: "Web",
  subagent: "Subagent",
};

/** "18 min", "3 hr", "2 days", "5 Oct". */
export function formatAge(iso: string, nowMs: number): string {
  const time = Date.parse(iso);
  if (!Number.isFinite(time)) return "";
  const minutes = Math.max(0, Math.floor((nowMs - time) / 60_000));
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hr`;
  const days = Math.floor(hours / 24);
  if (days < 7) return days === 1 ? "1 day" : `${days} days`;
  return new Date(time).toLocaleDateString(undefined, { day: "numeric", month: "short" });
}

function threadKey(thread: { environmentId: string; id: string }) {
  return `${thread.environmentId}:${thread.id}`;
}

/** Last-message snippets and origins for the rows on screen, one request per environment. */
function useThreadDetails(threads: ReadonlyArray<WorkspaceThread>) {
  const idsByEnvironment = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const thread of threads) {
      const list = map.get(thread.environmentId) ?? [];
      if (list.length < 500) list.push(thread.id);
      map.set(thread.environmentId, list);
    }
    return map;
  }, [threads]);
  const atom = useMemo(
    () =>
      Atom.make((get) => {
        const details = new Map<string, PersonalThreadDetail>();
        for (const [environmentId, threadIds] of idsByEnvironment) {
          const result = get(
            personalOrganizationEnvironment.threadDetails({
              environmentId: environmentId as EnvironmentId,
              input: { threadIds: threadIds as never },
            }),
          );
          const value = Option.getOrNull(AsyncResult.value(result));
          for (const detail of value?.threads ?? []) {
            details.set(`${environmentId}:${detail.threadId}`, detail);
          }
        }
        return details as ReadonlyMap<string, PersonalThreadDetail>;
      }),
    [idsByEnvironment],
  );
  return useAtomValue(atom);
}

export function GroupPage(props: { readonly environmentId: string; readonly groupId: string }) {
  const tree = useWorkspaceTree();
  const entry = useMemo(
    () =>
      tree.groups.find((candidate) =>
        candidate.group.members.some(
          (member) =>
            member.environmentId === props.environmentId && member.groupId === props.groupId,
        ),
      ) ?? null,
    [props.environmentId, props.groupId, tree.groups],
  );
  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background">
        <WorkspacePageHeader electron={isElectron} />
        <div className="min-h-0 flex-1 overflow-y-auto">
          {entry === null ? (
            <p className="mx-auto max-w-3xl px-8 pt-10 text-muted-foreground text-sm">
              This group no longer exists.
            </p>
          ) : (
            <GroupPageBody entry={entry} tree={tree} />
          )}
        </div>
      </div>
    </SidebarInset>
  );
}

function GroupPageBody(props: {
  readonly entry: WorkspaceGroupEntry;
  readonly tree: ReturnType<typeof useWorkspaceTree>;
}) {
  const { group, repo } = props.entry;
  const router = useRouter();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const openGroupPage = useOpenGroupPage();
  const startChat = useStartChatInGroup();
  const forkThread = useForkThread();
  const { archiveThread, markThreadUnread } = useThreadActions();
  const { undoMove, renameGroup, createGroup, deleteGroup } = useOrganizationActions();
  const [showAll, setShowAll] = useState(false);
  const [reviewing, setReviewing] = useState(false);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [nameDialog, setNameDialog] = useState<"rename" | "new-project" | null>(null);
  const nowMs = Date.now();

  const threads = useMemo(() => {
    const keys = collectOrganizedThreadKeys(group);
    const list: WorkspaceThread[] = [];
    for (const key of keys) {
      const thread = props.tree.threadByKey.get(key);
      if (thread) list.push(thread);
    }
    return list.sort(compareWorkspaceThreads);
  }, [group, props.tree.threadByKey]);

  // Organizer moves into this subtree today, still undoable.
  const filedToday = useMemo(() => {
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);
    return threads.filter((thread) => {
      const placement = props.tree.organizationByEnvironment.get(thread.environmentId)
        ?.placementsByThreadId[thread.id];
      return (
        placement?.source === "organizer" &&
        placement.undo !== undefined &&
        Date.parse(placement.updatedAt) >= startOfDay.getTime()
      );
    });
  }, [props.tree.organizationByEnvironment, threads]);

  const listed = reviewing ? filedToday : threads;
  const visible = showAll ? listed : listed.slice(0, INITIAL_ROWS);
  const olderCount = listed.length - visible.length;
  const details = useThreadDetails(visible);

  const member = preferredGroupMember(group.members, primaryEnvironmentId);
  const newChat = useCallback(() => {
    if (member === null) return;
    void startChat({
      environmentId: member.environmentId as EnvironmentId,
      projectId: member.projectId as ProjectId,
      path: group.path,
    });
  }, [group.path, member, startChat]);

  const refs = (keys: Iterable<string>): ScopedThreadRef[] =>
    [...keys].flatMap((key) => {
      const thread = props.tree.threadByKey.get(key);
      return thread ? [scopeThreadRef(thread.environmentId, thread.id)] : [];
    });

  const openThread = (thread: WorkspaceThread, event: MouseEvent) => {
    if (event.shiftKey || event.metaKey || event.ctrlKey) {
      const key = threadKey(thread);
      setSelected((current) => {
        const next = new Set(current);
        if (next.has(key)) next.delete(key);
        else next.add(key);
        return next;
      });
      return;
    }
    void router.navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(scopeThreadRef(thread.environmentId, thread.id)),
    });
  };

  const crumb = group.path.length > 1 ? `${repo.label} / ${group.path[0]} /` : `${repo.label} /`;

  return (
    <div className="mx-auto w-full max-w-3xl px-8 pt-6 pb-16">
      <div className="text-muted-foreground text-sm">{crumb}</div>
      <div className="mt-1 flex items-center gap-2">
        <h1 className="min-w-0 flex-1 truncate font-semibold text-2xl tracking-tight">
          {group.name}
        </h1>
        <Button variant="ghost" size="sm" onClick={newChat} disabled={member === null}>
          <PlusIcon />
          New chat
        </Button>
        <Menu>
          <MenuTrigger
            render={<Button variant="ghost" size="icon-sm" aria-label="Group actions" />}
          >
            <EllipsisIcon />
          </MenuTrigger>
          <MenuPopup align="end">
            <MenuItem onClick={() => setNameDialog("rename")}>Rename</MenuItem>
            {group.kind === "workstream" ? (
              <MenuItem onClick={() => setNameDialog("new-project")}>New project</MenuItem>
            ) : null}
            <MenuSeparator />
            <MenuItem
              variant="destructive"
              onClick={async () => {
                const confirmed = await readLocalApi()?.dialogs.confirm(
                  `Delete "${group.name}"? Its chats stay where they are, unsorted.`,
                );
                if (confirmed && (await deleteGroup(group.members))) {
                  router.history.push("/home");
                }
              }}
            >
              Delete
            </MenuItem>
          </MenuPopup>
        </Menu>
      </div>

      <ul className="mt-8 flex flex-col">
        {visible.map((thread) => (
          <GroupThreadRow
            key={threadKey(thread)}
            thread={thread}
            detail={details.get(threadKey(thread)) ?? null}
            nowMs={nowMs}
            selected={selected.has(threadKey(thread))}
            onOpen={(event) => openThread(thread, event)}
            onFork={() => void forkThread(scopeThreadRef(thread.environmentId, thread.id))}
            onMove={() => openMoveThreadDialog([scopeThreadRef(thread.environmentId, thread.id)])}
            onArchive={() => void archiveThread(scopeThreadRef(thread.environmentId, thread.id))}
            onMarkUnread={() => markThreadUnread(scopeThreadRef(thread.environmentId, thread.id))}
          />
        ))}
      </ul>
      {threads.length === 0 ? (
        <p className="mt-2 text-muted-foreground text-sm">No chats here yet.</p>
      ) : null}

      {group.children.length > 0 && !reviewing ? (
        <section className="mt-10">
          <h2 className="font-medium text-base">Projects</h2>
          <ul className="mt-3 flex flex-col">
            {group.children.map((child) => (
              <li key={child.key}>
                <button
                  type="button"
                  className="flex h-9 w-full items-center rounded-md px-2 text-left text-sm hover:bg-accent"
                  onClick={() => openGroupPage(child.members)}
                >
                  <span className="min-w-0 flex-1 truncate">{child.name}</span>
                  <AttentionDot attention={child.rollup.needsYou > 0 ? "needs_you" : "idle"} />
                  <span className="ml-3 text-muted-foreground tabular-nums">
                    {child.rollup.total === 1 ? "1 chat" : `${child.rollup.total} chats`}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {olderCount > 0 ? (
        <Button variant="link" size="sm" className="mt-6" onClick={() => setShowAll(true)}>
          {olderCount === 1 ? "Show 1 older chat" : `Show ${olderCount} older chats`}
        </Button>
      ) : null}

      {filedToday.length > 0 ? (
        <div className="mt-10 flex items-center gap-2 px-2 text-muted-foreground text-sm">
          <SparklesIcon className="size-4 shrink-0" />
          <span>
            {filedToday.length === 1
              ? "Filed 1 chat here today."
              : `Filed ${filedToday.length} chats here today.`}
          </span>
          <Button variant="link" size="sm" onClick={() => setReviewing((current) => !current)}>
            {reviewing ? "Show all" : "Review"}
          </Button>
          <Button
            variant="link"
            size="sm"
            onClick={async () => {
              for (const thread of filedToday) {
                await undoMove(scopeThreadRef(thread.environmentId, thread.id));
              }
              setReviewing(false);
            }}
          >
            Undo
          </Button>
        </div>
      ) : null}

      {selected.size > 0 ? (
        <div className="sticky bottom-4 mt-6 flex items-center gap-2 rounded-lg border bg-popover px-3 py-2 text-sm shadow-sm">
          <span className="min-w-0 flex-1 tabular-nums">{selected.size} selected</span>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              openMoveThreadDialog(refs(selected));
              setSelected(new Set());
            }}
          >
            Move
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={async () => {
              for (const ref of refs(selected)) await archiveThread(ref);
              setSelected(new Set());
            }}
          >
            Archive
          </Button>
          <Button variant="ghost-muted" size="sm" onClick={() => setSelected(new Set())}>
            Clear
          </Button>
        </div>
      ) : null}

      {nameDialog !== null ? (
        <GroupNameDialog
          title={nameDialog === "rename" ? "Rename" : "New project"}
          initialName={nameDialog === "rename" ? group.name : ""}
          onCancel={() => setNameDialog(null)}
          onSubmit={async (name) => {
            const ok =
              nameDialog === "rename"
                ? await renameGroup(group.members, name)
                : member !== null &&
                  (await createGroup({
                    environmentId: member.environmentId as EnvironmentId,
                    projectId: member.projectId as ProjectId,
                    parentId: member.groupId,
                    name,
                  }));
            if (ok) setNameDialog(null);
          }}
        />
      ) : null}
    </div>
  );
}

function GroupThreadRow(props: {
  readonly thread: WorkspaceThread;
  readonly detail: PersonalThreadDetail | null;
  readonly nowMs: number;
  readonly selected: boolean;
  readonly onOpen: (event: MouseEvent) => void;
  readonly onFork: () => void;
  readonly onMove: () => void;
  readonly onArchive: () => void;
  readonly onMarkUnread: () => void;
}) {
  const { thread, detail } = props;
  const origin = detail && detail.origin !== "t3" ? (ORIGIN_WORDS[detail.origin] ?? null) : null;
  const working = thread.attention === "working";
  return (
    <li
      className={cn(
        "group/row relative flex items-start gap-3 rounded-lg px-2 py-2.5 hover:bg-accent/60",
        props.selected && "bg-accent",
      )}
    >
      <span className="flex h-6 w-2 shrink-0 items-center">
        <AttentionDot attention={thread.attention} />
      </span>
      <button
        type="button"
        className="min-w-0 flex-1 text-left outline-hidden focus-visible:underline"
        onClick={props.onOpen}
      >
        <div className="truncate font-medium text-sm text-foreground">{thread.shell.title}</div>
        {detail?.lastMessage ? (
          <div className="truncate text-muted-foreground text-sm">{detail.lastMessage}</div>
        ) : null}
      </button>
      <div className="flex h-6 shrink-0 items-center gap-3 text-muted-foreground text-sm tabular-nums group-hover/row:hidden group-focus-within/row:hidden">
        {origin ? <span>{origin}</span> : null}
        <span>{working ? "working" : formatAge(thread.shell.updatedAt, props.nowMs)}</span>
      </div>
      <div className="hidden h-6 shrink-0 items-center gap-1 group-hover/row:flex group-focus-within/row:flex">
        <Button variant="ghost-muted" size="icon-xs" aria-label="Fork" onClick={props.onFork}>
          <GitBranchIcon />
        </Button>
        <Menu>
          <MenuTrigger
            render={<Button variant="ghost-muted" size="icon-xs" aria-label="Chat actions" />}
          >
            <EllipsisIcon />
          </MenuTrigger>
          <MenuPopup align="end">
            <MenuItem onClick={props.onMove}>Move to…</MenuItem>
            <MenuItem onClick={props.onArchive}>Archive</MenuItem>
            <MenuItem onClick={props.onMarkUnread}>Mark unread</MenuItem>
          </MenuPopup>
        </Menu>
      </div>
    </li>
  );
}
