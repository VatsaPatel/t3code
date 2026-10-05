/**
 * Personal ⌘K additions: a group scope chip, a Groups section, group paths on
 * chat rows, and group-aware actions. The palette calls this once and threads
 * its outputs through its existing item, key and footer plumbing.
 */
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  collectOrganizedThreadKeys,
  organizedThreadKey,
} from "@t3tools/client-runtime/personal/organizationTree";
import type { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { useRouter } from "@tanstack/react-router";
import { ArrowRightIcon, ClockIcon, HomeIcon, SquarePenIcon, XIcon } from "lucide-react";
import {
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
  Fragment,
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import {
  ITEM_ICON_CLASS,
  type CommandPaletteActionItem,
  type CommandPaletteGroup,
  type CommandPaletteSubmenuItem,
} from "../../components/CommandPalette.logic";
import { Badge } from "../../components/ui/badge";
import { Kbd, KbdGroup } from "../../components/ui/kbd";
import { isMacPlatform } from "../../lib/utils";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { preferredGroupMember, useOpenGroupPage } from "../organization/groupNavigation";
import { openMoveThreadDialog, useStartChatInGroup } from "../organization/organizationActions";
import { useWorkspaceTree, type WorkspaceGroupEntry } from "../organization/workspaceTree";
import {
  arrangePersonalPaletteGroups,
  groupItemValue,
  isGroupItemValue,
} from "./paletteGroups.logic";

/** "Job search › Applications"; `emphasizeLeaf` mutes the parents. */
export function GroupPathText(props: {
  readonly path: ReadonlyArray<string>;
  readonly emphasizeLeaf?: boolean;
}) {
  return props.path.map((name, index) => (
    <Fragment key={props.path.slice(0, index + 1).join("\u0000")}>
      {index > 0 ? <span className="px-1 text-muted-foreground/60">›</span> : null}
      <span
        className={
          props.emphasizeLeaf && index < props.path.length - 1 ? "text-muted-foreground" : undefined
        }
      >
        {name}
      </span>
    </Fragment>
  ));
}

const SCOPE_INSET_CLASS =
  "*:data-[slot=autocomplete-input]:ps-(--palette-scope-inset)! sm:*:data-[slot=autocomplete-input]:ps-(--palette-scope-inset)!";
const GROUP_ROW_SPACER = <span aria-hidden className="size-4 shrink-0" />;

function ScopeChip(props: {
  readonly name: string;
  readonly onRemove: () => void;
  readonly onInset: (px: number) => void;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  const { onInset } = props;
  // The chip sits in the input's start addon; the text starts after it. Keyed by
  // scope, so a new scope remounts and re-measures.
  useLayoutEffect(() => {
    const addon = ref.current?.parentElement;
    if (addon) onInset(addon.offsetLeft + addon.offsetWidth + 6);
  }, [onInset]);
  return (
    <Badge ref={ref} variant="outline" size="lg">
      <span className="text-muted-foreground">in:</span>
      <span>{props.name}</span>
      <button
        type="button"
        tabIndex={-1}
        aria-label="Remove scope"
        className="flex cursor-pointer items-center text-muted-foreground hover:text-foreground"
        onMouseDown={(event) => event.preventDefault()}
        onClick={props.onRemove}
      >
        <XIcon className="size-3" />
      </button>
    </Badge>
  );
}

type PaletteItem = CommandPaletteActionItem | CommandPaletteSubmenuItem;

export function usePersonalPalette<T extends { environmentId: string; id: string }>(input: {
  readonly threads: ReadonlyArray<T>;
  readonly activeThreadEnvironmentId: EnvironmentId | null;
  readonly activeThreadId: ThreadId | null;
  /** Root view only: submenus, browsing and project flows keep upstream behavior. */
  readonly enabled: boolean;
}) {
  const { threads, activeThreadEnvironmentId, activeThreadId, enabled } = input;
  const tree = useWorkspaceTree();
  const router = useRouter();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const openGroupPage = useOpenGroupPage();
  const startChatInGroup = useStartChatInGroup();
  const [scopeKey, setScopeKey] = useState<string | null>(null);
  const [scopeInset, setScopeInset] = useState(0);

  const entryByValue = useMemo(
    () => new Map(tree.groups.map((entry) => [groupItemValue(entry.group.key), entry] as const)),
    [tree.groups],
  );
  const scope =
    enabled && scopeKey !== null ? (entryByValue.get(groupItemValue(scopeKey)) ?? null) : null;
  const scopeThreadKeys = useMemo(
    () => (scope === null ? null : collectOrganizedThreadKeys(scope.group)),
    [scope],
  );
  const scopedThreads = useMemo(
    () =>
      scopeThreadKeys === null
        ? threads
        : threads.filter((thread) => scopeThreadKeys.has(organizedThreadKey(thread))),
    [scopeThreadKeys, threads],
  );

  const allGroupItems = useMemo(() => {
    const pathCounts = new Map<string, number>();
    for (const entry of tree.groups) {
      const label = entry.group.path.join("\u0000");
      pathCounts.set(label, (pathCounts.get(label) ?? 0) + 1);
    }
    return tree.groups.map((entry): CommandPaletteActionItem => ({
      kind: "action",
      value: groupItemValue(entry.group.key),
      searchTerms: [entry.group.path.join(" ")],
      title: <GroupPathText path={entry.group.path} emphasizeLeaf />,
      // Same-named groups in different repos say which repo they belong to.
      ...((pathCounts.get(entry.group.path.join("\u0000")) ?? 0) > 1
        ? { description: entry.repo.label }
        : {}),
      icon: GROUP_ROW_SPACER,
      run: async () => openGroupPage(entry.group.members),
    }));
  }, [openGroupPage, tree.groups]);
  const groupItems = useMemo(() => {
    if (scope === null) return allGroupItems;
    const descendants = new Set<string>();
    const visit = (node: WorkspaceGroupEntry["group"]) => {
      for (const child of node.children) {
        descendants.add(groupItemValue(child.key));
        visit(child);
      }
    };
    visit(scope.group);
    return allGroupItems.filter((item) => descendants.has(item.value));
  }, [allGroupItems, scope]);

  const newChatItemFor = useCallback(
    (value: string): CommandPaletteActionItem | null => {
      const entry = entryByValue.get(value);
      const member = entry && preferredGroupMember(entry.group.members, primaryEnvironmentId);
      if (!entry || !member) return null;
      return {
        kind: "action",
        value: `personal-new-chat:${entry.group.key}`,
        searchTerms: ["new chat", ...entry.group.path],
        title: (
          <>
            New chat in <GroupPathText path={entry.group.path} />
          </>
        ),
        icon: <SquarePenIcon className={ITEM_ICON_CLASS} />,
        run: async () => {
          await startChatInGroup({
            environmentId: member.environmentId as EnvironmentId,
            projectId: member.projectId as ProjectId,
            path: entry.group.path,
          });
        },
      };
    },
    [entryByValue, primaryEnvironmentId, startChatInGroup],
  );

  const moveItem = useMemo((): CommandPaletteActionItem | null => {
    if (activeThreadEnvironmentId === null || activeThreadId === null) return null;
    const ref = scopeThreadRef(activeThreadEnvironmentId, activeThreadId);
    return {
      kind: "action",
      value: "personal-move-chat",
      searchTerms: ["move current chat to", "file", "group", "organize"],
      title: "Move current chat to…",
      icon: <ArrowRightIcon className={ITEM_ICON_CLASS} />,
      run: async () => openMoveThreadDialog([ref]),
    };
  }, [activeThreadEnvironmentId, activeThreadId]);

  const actionItems = useMemo((): CommandPaletteActionItem[] => {
    // /home and /routines live on other branches, so these paths are untyped.
    const go = (path: string) => async () => router.history.push(path);
    return [
      ...(moveItem ? [moveItem] : []),
      {
        kind: "action",
        value: "personal-go-home",
        searchTerms: ["go to home", "today", "daybook"],
        title: "Go to Home",
        icon: <HomeIcon className={ITEM_ICON_CLASS} />,
        run: go("/home"),
      },
      {
        kind: "action",
        value: "personal-go-routines",
        searchTerms: ["go to routines", "schedules", "cron", "automations"],
        title: "Go to Routines",
        icon: <ClockIcon className={ITEM_ICON_CLASS} />,
        run: go("/routines"),
      },
    ];
  }, [moveItem, router]);

  const arrangeGroups = (
    groups: ReadonlyArray<CommandPaletteGroup>,
    query: string,
  ): ReadonlyArray<CommandPaletteGroup> =>
    enabled
      ? arrangePersonalPaletteGroups({
          groups,
          query,
          groupItems,
          scopeValue: scope === null ? null : groupItemValue(scope.group.key),
          newChatItemFor,
          moveItem,
        })
      : groups;

  const clearScope = useCallback(() => setScopeKey(null), []);
  const inputProps =
    scope === null
      ? null
      : {
          className: SCOPE_INSET_CLASS,
          style: { "--palette-scope-inset": `${scopeInset}px` } as CSSProperties,
          startAddon: (
            <ScopeChip
              key={scope.group.key}
              name={scope.group.name}
              onRemove={clearScope}
              onInset={setScopeInset}
            />
          ),
        };

  /** The group a ⌘Enter would start a chat in: the highlighted group row, else the scope. */
  const newChatTargetFor = (highlightedValue: string | null) =>
    isGroupItemValue(highlightedValue) && entryByValue.has(highlightedValue)
      ? highlightedValue
      : scope === null
        ? null
        : groupItemValue(scope.group.key);

  /** Tab scopes, Backspace on an empty query unscopes, ⌘Enter starts a chat. True when handled. */
  const handleKeyDown = (
    event: KeyboardEvent<HTMLInputElement>,
    context: {
      readonly query: string;
      /** The row Enter would run: the highlight, or the auto-highlighted first row. */
      readonly highlightedValue: string | null;
      readonly clearQuery: () => void;
      readonly execute: (item: PaletteItem) => void;
    },
  ): boolean => {
    if (!enabled || event.nativeEvent.isComposing) return false;
    const consume = () => {
      (event as typeof event & { preventBaseUIHandler?: () => void }).preventBaseUIHandler?.();
      event.preventDefault();
      event.stopPropagation();
    };
    const plain = !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey;
    if (event.key === "Tab" && plain) {
      const entry = isGroupItemValue(context.highlightedValue)
        ? entryByValue.get(context.highlightedValue)
        : undefined;
      if (entry === undefined) return false;
      consume();
      setScopeKey(entry.group.key);
      context.clearQuery();
      return true;
    }
    if (event.key === "Backspace" && plain && context.query === "" && scope !== null) {
      consume();
      setScopeKey(null);
      return true;
    }
    const primaryModifier = isMacPlatform(navigator.platform)
      ? event.metaKey && !event.ctrlKey
      : event.ctrlKey && !event.metaKey;
    if (event.key === "Enter" && primaryModifier && !event.altKey && !event.shiftKey) {
      const target = newChatTargetFor(context.highlightedValue);
      const item = target === null ? null : newChatItemFor(target);
      if (item === null) return false;
      consume();
      context.execute(item);
      return true;
    }
    return false;
  };

  const footerHints = (highlightedValue: string | null): ReactNode => {
    if (!enabled) return null;
    const onGroup = isGroupItemValue(highlightedValue) && entryByValue.has(highlightedValue);
    const canStartChat = newChatTargetFor(highlightedValue) !== null;
    if (!onGroup && !canStartChat) return null;
    return (
      <>
        {onGroup ? (
          <KbdGroup>
            <Kbd>Tab</Kbd>
            <span>Scope</span>
          </KbdGroup>
        ) : null}
        {canStartChat ? (
          <KbdGroup>
            <Kbd>{isMacPlatform(navigator.platform) ? "⌘↵" : "Ctrl\u00a0↵"}</Kbd>
            <span>New chat here</span>
          </KbdGroup>
        ) : null}
      </>
    );
  };

  return {
    scopedThreads,
    groupPathOf: tree.groupPathOf,
    actionItems,
    arrangeGroups,
    inputProps,
    handleKeyDown,
    footerHints,
  };
}
