/**
 * Pure arrangement for the personal additions to the ⌘K palette: the Groups
 * section, the scope's contextual actions, and sentence-case chat labels.
 */
import {
  filterCommandPaletteGroups,
  type CommandPaletteActionItem,
  type CommandPaletteGroup,
} from "../../components/CommandPalette.logic";
import { normalizeSearchText } from "../../lib/utils";

export const GROUPS_SECTION = "personal-groups";
export const CONTEXT_SECTION = "personal-context";
const GROUP_VALUE_PREFIX = "personal-group:";

export const groupItemValue = (groupKey: string) => `${GROUP_VALUE_PREFIX}${groupKey}`;
export const isGroupItemValue = (value: string | null | undefined): value is string =>
  value?.startsWith(GROUP_VALUE_PREFIX) ?? false;

const LABELS: Record<string, string> = {
  "threads-search": "Chats",
  "recent-threads": "Recent chats",
};

const relabel = (group: CommandPaletteGroup): CommandPaletteGroup => {
  const label = LABELS[group.value];
  return label === undefined ? group : { ...group, label };
};

/**
 * Lays the personal sections into the palette's filtered root groups.
 *
 * - Groups sit right after Actions. With an empty query they appear only while
 *   scoped (the scope's sub-groups).
 * - "New chat in …" targets the scope, else the only matching group. While
 *   typing it (and "Move current chat to…") trails the results so the first
 *   row, which Enter runs, stays the best match. With an empty query and a
 *   scope it leads, like upstream's "New thread in <project>".
 */
export function arrangePersonalPaletteGroups(input: {
  readonly groups: ReadonlyArray<CommandPaletteGroup>;
  readonly query: string;
  /** Group rows the user may reach: the scope's descendants while scoped, else every group. */
  readonly groupItems: ReadonlyArray<CommandPaletteActionItem>;
  /** Value of the scoped group's row, or null when unscoped. */
  readonly scopeValue: string | null;
  readonly newChatItemFor: (groupValue: string) => CommandPaletteActionItem | null;
  readonly moveItem: CommandPaletteActionItem | null;
}): CommandPaletteGroup[] {
  const actionsOnly = input.query.startsWith(">");
  const hasQuery = normalizeSearchText(actionsOnly ? input.query.slice(1) : input.query) !== "";
  let groups = input.groups.map(relabel);
  if (actionsOnly) return groups;
  // A scope narrows the palette to chats in that group: projects and
  // settings results would only be noise.
  if (input.scopeValue !== null) {
    groups = groups.filter(
      (group) => group.value !== "projects-search" && group.value !== "settings-search",
    );
  }

  const matchedGroups =
    (hasQuery || input.scopeValue !== null) && input.groupItems.length > 0
      ? filterCommandPaletteGroups({
          activeGroups: [{ value: GROUPS_SECTION, label: "Groups", items: input.groupItems }],
          query: input.query,
          isInSubmenu: true,
          projectSearchItems: [],
          threadSearchItems: [],
        })
      : [];
  // Scoped, chats lead and the scope's groups follow them. Unscoped, groups
  // come first (a short list) so a group stays reachable above many chats.
  const chatsIndex = groups.findIndex((group) => group.value === "threads-search");
  const insertAt =
    input.scopeValue !== null && chatsIndex !== -1
      ? chatsIndex + 1
      : groups.findIndex((group) => group.value === "actions") + 1;
  groups.splice(insertAt, 0, ...matchedGroups);
  const actionsIndex = groups.findIndex((group) => group.value === "actions");

  const matchedItems = matchedGroups[0]?.items ?? [];
  const target =
    input.scopeValue ?? (hasQuery && matchedItems.length === 1 ? matchedItems[0]!.value : null);
  const newChat = target === null ? null : input.newChatItemFor(target);

  if (!hasQuery) {
    if (newChat === null) return groups;
    const actions = groups[actionsIndex];
    return actions === undefined
      ? [{ value: "actions", label: "Actions", items: [newChat] }, ...groups]
      : groups.with(actionsIndex, { ...actions, items: [newChat, ...actions.items] });
  }

  const present = new Set(groups.flatMap((group) => group.items.map((item) => item.value)));
  const contextual = [newChat, input.moveItem].filter(
    (item): item is CommandPaletteActionItem => item !== null && !present.has(item.value),
  );
  if (contextual.length === 0) return groups;
  const actions = groups[actionsIndex];
  if (actions !== undefined) {
    groups = groups.with(actionsIndex, { ...actions, items: [...actions.items, ...contextual] });
    return groups;
  }
  return [...groups, { value: CONTEXT_SECTION, label: "Actions", items: contextual }];
}
