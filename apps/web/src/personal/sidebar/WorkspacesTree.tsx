/**
 * The "Workspaces" tree: repo → workstream → project → a few recent chats.
 * Chevrons only (no folder or chat icons, no counts); a 6px dot carries the
 * attention rollup. Only expanded nodes render and each node shows at most a
 * handful of chats, so thousands of synced chats stay cheap.
 */
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { OrganizedGroupNode } from "@t3tools/client-runtime/personal/organizationTree";
import { useParams, useRouter } from "@tanstack/react-router";
import { ChevronRightIcon } from "lucide-react";
import * as Schema from "effect/Schema";
import { memo, useCallback, useMemo, useState, type ReactNode } from "react";

import { ProjectFavicon } from "../../components/ProjectFavicon";
import { useLocalStorage } from "../../hooks/useLocalStorage";
import { useThreadActionMenu } from "../../hooks/useThreadActionMenu";
import { cn } from "../../lib/utils";
import { useProjects } from "../../state/entities";
import { buildThreadRouteParams } from "../../threadRoutes";
import { AttentionDot, rollupAttention } from "../organization/AttentionDot";
import { useOpenGroupPage } from "../organization/groupNavigation";
import type { WorkspaceRepo, WorkspaceThread } from "../organization/workspaceTree";

const CHATS_PER_GROUP = 3;
const UNSORTED_PAGE = 3;
const UNSORTED_STEP = 10;
const INDENT_PX = 12;

const EXPANDED_KEY = "t3code:personal:workspaces-expanded";
const ExpandedState = Schema.Record(Schema.String, Schema.Boolean);

type Group = OrganizedGroupNode<WorkspaceThread>;

function containsThread(
  node: { threads: ReadonlyArray<{ key: string }>; children: ReadonlyArray<Group> },
  key: string | null,
): boolean {
  if (key === null) return false;
  return (
    node.threads.some((leaf) => leaf.key === key) ||
    node.children.some((child) => containsThread(child, key))
  );
}

export function WorkspacesTree(props: { readonly repos: ReadonlyArray<WorkspaceRepo> }) {
  const params = useParams({ strict: false }) as { environmentId?: string; threadId?: string };
  const activeKey =
    params.environmentId && params.threadId ? `${params.environmentId}:${params.threadId}` : null;
  const [expanded, setExpanded] = useLocalStorage(EXPANDED_KEY, {}, ExpandedState);
  const toggle = useCallback(
    (key: string, current: boolean) =>
      setExpanded((previous) => ({ ...previous, [key]: !current })),
    [setExpanded],
  );
  const isExpanded = useCallback(
    (key: string, fallback: boolean) => expanded[key] ?? fallback,
    [expanded],
  );
  const projects = useProjects();
  const projectByKey = useMemo(
    () => new Map(projects.map((project) => [`${project.environmentId}:${project.id}`, project])),
    [projects],
  );

  return (
    <ul role="tree" aria-label="Workspaces" className="flex flex-col gap-px">
      {props.repos.map((repo) => {
        // A repo opens by default when it holds the chat on screen.
        const open = isExpanded(repo.key, repo.isPersonal || containsThread(repo, activeKey));
        const member = repo.members[0];
        const project = member
          ? projectByKey.get(`${member.environmentId}:${member.projectId}`)
          : undefined;
        return (
          <li key={repo.key} role="treeitem" aria-expanded={open}>
            <TreeRow
              depth={0}
              expanded={open}
              onToggle={() => toggle(repo.key, open)}
              onActivate={() => toggle(repo.key, open)}
              leading={
                project ? <ProjectFavicon project={project} className="size-4 shrink-0" /> : null
              }
              label={repo.label}
              attention={rollupAttention(repo.rollup)}
              strong
            />
            {open ? (
              <ul role="group" className="flex flex-col gap-px">
                {repo.children.map((group) => (
                  <GroupBranch
                    key={group.key}
                    group={group}
                    depth={1}
                    activeKey={activeKey}
                    isExpanded={isExpanded}
                    toggle={toggle}
                  />
                ))}
                <UnsortedChats repo={repo} activeKey={activeKey} />
              </ul>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}

function GroupBranch(props: {
  readonly group: Group;
  readonly depth: number;
  readonly activeKey: string | null;
  readonly isExpanded: (key: string, fallback: boolean) => boolean;
  readonly toggle: (key: string, current: boolean) => void;
}) {
  const { group, depth } = props;
  const openGroupPage = useOpenGroupPage();
  const open = props.isExpanded(group.key, containsThread(group, props.activeKey));
  const shown = group.threads.slice(0, CHATS_PER_GROUP);
  const hidden = group.threads.length - shown.length;
  return (
    <li role="treeitem" aria-expanded={open}>
      <TreeRow
        depth={depth}
        expanded={open}
        onToggle={() => props.toggle(group.key, open)}
        onActivate={() => openGroupPage(group.members)}
        label={group.name}
        attention={rollupAttention(group.rollup)}
      />
      {open ? (
        <ul role="group" className="flex flex-col gap-px">
          {group.children.map((child) => (
            <GroupBranch
              key={child.key}
              group={child}
              depth={depth + 1}
              activeKey={props.activeKey}
              isExpanded={props.isExpanded}
              toggle={props.toggle}
            />
          ))}
          {shown.map((leaf) => (
            <ChatRow
              key={leaf.key}
              thread={leaf.thread}
              depth={depth + 1}
              active={leaf.key === props.activeKey}
            />
          ))}
          {hidden > 0 ? (
            <li>
              <MoreRow depth={depth + 1} onClick={() => openGroupPage(group.members)} />
            </li>
          ) : null}
        </ul>
      ) : null}
    </li>
  );
}

function UnsortedChats(props: { readonly repo: WorkspaceRepo; readonly activeKey: string | null }) {
  const [limit, setLimit] = useState(UNSORTED_PAGE);
  const leaves = props.repo.threads;
  // Keep the open chat visible even when it is past the limit.
  const activeIndex = leaves.findIndex((leaf) => leaf.key === props.activeKey);
  const shown = leaves.slice(0, Math.max(limit, activeIndex + 1));
  return (
    <>
      {shown.map((leaf) => (
        <ChatRow
          key={leaf.key}
          thread={leaf.thread}
          depth={1}
          active={leaf.key === props.activeKey}
        />
      ))}
      {leaves.length > shown.length ? (
        <li>
          <MoreRow depth={1} onClick={() => setLimit(shown.length + UNSORTED_STEP)} />
        </li>
      ) : null}
    </>
  );
}

const rowClass =
  "group/tree-row flex h-7 w-full min-w-0 cursor-pointer items-center gap-1.5 rounded-(--control-radius) pr-2 text-left text-sm outline-hidden hover:bg-sidebar-row-hover focus-visible:ring-2 focus-visible:ring-ring";

function TreeRow(props: {
  readonly depth: number;
  readonly expanded: boolean;
  readonly onToggle: () => void;
  readonly onActivate: () => void;
  readonly label: string;
  readonly leading?: ReactNode;
  readonly attention: ReturnType<typeof rollupAttention>;
  readonly strong?: boolean;
}) {
  return (
    <div
      className={cn(rowClass, "text-sidebar-foreground")}
      style={{ paddingLeft: 4 + props.depth * INDENT_PX }}
    >
      <button
        type="button"
        aria-label={props.expanded ? `Collapse ${props.label}` : `Expand ${props.label}`}
        className="flex size-4 shrink-0 items-center justify-center rounded-sm text-sidebar-muted-foreground hover:text-sidebar-foreground"
        onClick={props.onToggle}
      >
        <ChevronRightIcon
          className={cn(
            "size-3.5 transition-transform duration-100",
            props.expanded && "rotate-90",
          )}
        />
      </button>
      <button
        type="button"
        className="flex min-w-0 flex-1 items-center gap-2 text-left"
        onClick={props.onActivate}
      >
        {props.leading}
        <span className={cn("truncate", props.strong ? "font-medium" : "font-normal")}>
          {props.label}
        </span>
      </button>
      <AttentionDot attention={props.attention} />
    </div>
  );
}

function MoreRow(props: { readonly depth: number; readonly onClick: () => void }) {
  return (
    <button
      type="button"
      className={cn(rowClass, "text-sidebar-muted-foreground hover:text-sidebar-foreground")}
      style={{ paddingLeft: 4 + props.depth * INDENT_PX + 22 }}
      onClick={props.onClick}
    >
      More…
    </button>
  );
}

const ChatRow = memo(function ChatRow(props: {
  readonly thread: WorkspaceThread;
  readonly depth: number;
  readonly active: boolean;
}) {
  const router = useRouter();
  const threadRef = useMemo(
    () => scopeThreadRef(props.thread.environmentId, props.thread.id),
    [props.thread.environmentId, props.thread.id],
  );
  const open = useCallback(() => {
    void router.navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(threadRef),
    });
  }, [router, threadRef]);
  const { openMenu } = useThreadActionMenu({ threadRef, projectCwd: null, onStartRename: open });
  return (
    <li role="treeitem">
      <button
        type="button"
        data-active={props.active}
        className={cn(
          rowClass,
          "text-sidebar-muted-foreground hover:text-sidebar-foreground data-[active=true]:bg-sidebar-row-selected data-[active=true]:text-sidebar-foreground",
        )}
        style={{ paddingLeft: 4 + props.depth * INDENT_PX + 22 }}
        onClick={open}
        onContextMenu={(event) => {
          event.preventDefault();
          openMenu({ x: event.clientX, y: event.clientY });
        }}
      >
        <span className="min-w-0 flex-1 truncate">{props.thread.shell.title}</span>
        <AttentionDot attention={props.thread.attention} />
      </button>
    </li>
  );
});
