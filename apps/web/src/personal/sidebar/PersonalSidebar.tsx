/**
 * The fork's sidebar body: Home and Routines, Pinned (Hermes plus T3's pinned
 * chats) and the Workspaces tree. Also hosts the Move dialog and applies
 * pending "New chat here" placements.
 */
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ModelSelection, ProviderInstanceId } from "@t3tools/contracts";
import { useLocation, useRouter } from "@tanstack/react-router";
import { ClockIcon, HouseIcon } from "lucide-react";
import * as Schema from "effect/Schema";
import { useCallback, useMemo, type ReactNode } from "react";

import { sortPinnedThreadsForSidebar } from "../../components/Sidebar.logic";
import { ProviderInstanceIcon } from "../../components/chat/ProviderInstanceIcon";
import { useComposerDraftStore } from "../../composerDraftStore";
import { useLocalStorage } from "../../hooks/useLocalStorage";
import { useScratchProject } from "../../hooks/useScratchProject";
import { cn } from "../../lib/utils";
import { deriveProviderEntriesByEnvironment } from "../../providerInstances";
import { useServerConfigs } from "../../state/entities";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { buildThreadRouteParams } from "../../threadRoutes";
import { AttentionDot } from "../organization/AttentionDot";
import { MoveThreadDialog } from "../organization/MoveThreadDialog";
import { usePendingPlacementWatcher } from "../organization/organizationActions";
import { useWorkspaceTree, type WorkspaceThread } from "../organization/workspaceTree";
import { WorkspacesTree } from "./WorkspacesTree";

const SIDEBAR_VIEW_KEY = "t3code:personal:sidebar-view";
const SidebarView = Schema.Literals(["tree", "flat"]);
export type PersonalSidebarView = typeof SidebarView.Type;

/** Workspaces tree (default in this fork) or T3's flat list, per device. */
export function usePersonalSidebarView() {
  return useLocalStorage<PersonalSidebarView, PersonalSidebarView>(
    SIDEBAR_VIEW_KEY,
    "tree",
    SidebarView,
  );
}

const navRowClass =
  "flex h-8 w-full min-w-0 items-center gap-2.5 rounded-(--control-radius) px-(--sidebar-row-content-inset) text-left text-sm text-sidebar-foreground outline-hidden hover:bg-sidebar-row-hover focus-visible:ring-2 focus-visible:ring-ring data-[active=true]:bg-sidebar-row-selected data-[active=true]:font-medium [&>svg]:size-4 [&>svg]:shrink-0 [&>svg]:text-(--sidebar-icon-color)";

function NavRow(props: {
  readonly icon: ReactNode;
  readonly label: string;
  readonly path: string;
  readonly trailing?: ReactNode;
}) {
  const router = useRouter();
  const active = useLocation({ select: (location) => location.pathname === props.path });
  return (
    <button
      type="button"
      data-active={active}
      className={navRowClass}
      // Home and Routines are owned by another part of the fork; their routes
      // may not exist in every build, so navigate by path.
      onClick={() => router.history.push(props.path)}
    >
      {props.icon}
      <span className="min-w-0 flex-1 truncate">{props.label}</span>
      {props.trailing}
    </button>
  );
}

function SectionLabel(props: { readonly children: ReactNode }) {
  return (
    <div className="px-(--sidebar-row-content-inset) pt-4 pb-1 text-sidebar-muted-foreground text-xs">
      {props.children}
    </div>
  );
}

/** Nav rows, shown in both sidebar views. */
export function PersonalSidebarNav(props: { readonly needsYou: boolean }) {
  return (
    <div className="flex flex-col gap-px">
      <NavRow
        icon={<HouseIcon />}
        label="Home"
        path="/home"
        trailing={props.needsYou ? <AttentionDot attention="needs_you" /> : null}
      />
      <NavRow icon={<ClockIcon />} label="Routines" path="/routines" />
    </div>
  );
}

function useHermesTarget(threads: ReadonlyArray<WorkspaceThread>) {
  const serverConfigs = useServerConfigs();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  return useMemo(() => {
    const entries = deriveProviderEntriesByEnvironment(
      [...serverConfigs].map(
        ([environmentId, config]) => [environmentId, config.providers, config.settings] as const,
      ),
    );
    const hermesInstances: Array<{
      environmentId: string;
      instanceId: string;
      model: string | null;
      displayName: string;
    }> = [];
    for (const [environmentId, byInstance] of entries) {
      for (const entry of byInstance.values()) {
        if (entry.driverKind !== "hermes" || !entry.enabled) continue;
        hermesInstances.push({
          environmentId,
          instanceId: entry.instanceId,
          displayName: entry.displayName,
          model:
            entry.models.find((model) => model.isDefault)?.slug ?? entry.models[0]?.slug ?? null,
        });
      }
    }
    if (hermesInstances.length === 0) return null;
    const hermesKeys = new Set(
      hermesInstances.map((entry) => `${entry.environmentId}:${entry.instanceId}`),
    );
    // Threads arrive ordered by attention then recency; pick the most recent.
    let latest: WorkspaceThread | null = null;
    for (const thread of threads) {
      if (!hermesKeys.has(`${thread.environmentId}:${thread.shell.providerInstanceId}`)) continue;
      if (latest === null || thread.activityAt > latest.activityAt) latest = thread;
    }
    const instance =
      hermesInstances.find((entry) => entry.environmentId === primaryEnvironmentId) ??
      hermesInstances[0]!;
    return { latest, instance };
  }, [primaryEnvironmentId, serverConfigs, threads]);
}

type HermesTarget = NonNullable<ReturnType<typeof useHermesTarget>>;

function HermesRow(props: { readonly target: HermesTarget }) {
  const router = useRouter();
  const target = props.target;
  const { startScratchThread, openScratchProject } = useScratchProject();
  const routeKey = useLocation({ select: (location) => location.pathname });
  const open = useCallback(async () => {
    if (target.latest !== null) {
      void router.navigate({
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams(
          scopeThreadRef(target.latest.environmentId, target.latest.id),
        ),
      });
      return;
    }
    // No Hermes chat yet: a new draft without a project, with Hermes selected.
    const environmentId = target.instance.environmentId as EnvironmentId;
    const project = await openScratchProject(environmentId);
    if (!project) return;
    await startScratchThread(environmentId);
    const draftId = router.state.location.pathname.match(/^\/draft\/([^/]+)/)?.[1];
    if (draftId && target.instance.model) {
      const selection: ModelSelection = {
        instanceId: target.instance.instanceId as ProviderInstanceId,
        model: target.instance.model,
      };
      useComposerDraftStore
        .getState()
        .setModelSelection(decodeURIComponent(draftId) as never, selection, { explicit: true });
    }
  }, [openScratchProject, router, startScratchThread, target]);
  const active =
    target.latest !== null && routeKey === `/${target.latest.environmentId}/${target.latest.id}`;
  return (
    <button type="button" data-active={active} className={navRowClass} onClick={() => void open()}>
      <ProviderInstanceIcon
        driverKind={"hermes" as never}
        displayName={target.instance.displayName}
        iconClassName="size-4"
      />
      <span className="min-w-0 flex-1 truncate">Hermes</span>
      {target.latest ? <AttentionDot attention={target.latest.attention} /> : null}
    </button>
  );
}

function PinnedChats(props: { readonly threads: ReadonlyArray<WorkspaceThread> }) {
  const router = useRouter();
  const pathname = useLocation({ select: (location) => location.pathname });
  const pinned = useMemo(() => {
    const byShell = new Map(props.threads.map((thread) => [thread.shell, thread]));
    return sortPinnedThreadsForSidebar(
      props.threads.filter((thread) => thread.shell.pinnedAt != null).map((thread) => thread.shell),
    ).map((shell) => byShell.get(shell)!);
  }, [props.threads]);
  return pinned.map((thread) => (
    <button
      key={`${thread.environmentId}:${thread.id}`}
      type="button"
      data-active={pathname === `/${thread.environmentId}/${thread.id}`}
      className={cn(
        navRowClass,
        "text-sidebar-muted-foreground data-[active=true]:text-sidebar-foreground",
      )}
      onClick={() =>
        void router.navigate({
          to: "/$environmentId/$threadId",
          params: buildThreadRouteParams(scopeThreadRef(thread.environmentId, thread.id)),
        })
      }
    >
      <span className="min-w-0 flex-1 truncate">{thread.shell.title}</span>
      <AttentionDot attention={thread.attention} />
    </button>
  ));
}

/**
 * The sidebar body above (flat view) or instead of (tree view) T3's list:
 * nav rows always; Pinned and Workspaces in the tree view.
 */
export function PersonalSidebar(props: { readonly view: PersonalSidebarView }) {
  const tree = useWorkspaceTree();
  const threads = useMemo(() => [...tree.threadByKey.values()], [tree.threadByKey]);
  const needsYou = tree.repos.some((repo) => repo.rollup.needsYou > 0);
  const hermes = useHermesTarget(threads);
  const hasPinned = threads.some((thread) => thread.shell.pinnedAt != null);
  return (
    <div className="flex flex-col pb-2">
      <PersonalSidebarNav needsYou={needsYou} />
      {props.view === "tree" ? (
        <>
          {hermes !== null || hasPinned ? <SectionLabel>Pinned</SectionLabel> : null}
          {hermes !== null ? <HermesRow target={hermes} /> : null}
          {hasPinned ? <PinnedChats threads={threads} /> : null}
          {tree.repos.length > 0 ? (
            <>
              <SectionLabel>Workspaces</SectionLabel>
              <WorkspacesTree repos={tree.repos} />
            </>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

/** Mounted once by the sidebar in either view. */
export function PersonalSidebarServices() {
  usePendingPlacementWatcher();
  return <MoveThreadDialog />;
}
