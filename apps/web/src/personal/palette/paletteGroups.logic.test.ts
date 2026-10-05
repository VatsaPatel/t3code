import { describe, expect, it } from "vite-plus/test";

import type {
  CommandPaletteActionItem,
  CommandPaletteGroup,
} from "../../components/CommandPalette.logic";
import { arrangePersonalPaletteGroups, groupItemValue } from "./paletteGroups.logic";

const item = (value: string, ...searchTerms: string[]): CommandPaletteActionItem => ({
  kind: "action",
  value,
  searchTerms,
  title: value,
  icon: null,
  run: async () => {},
});

const jobSearch = item(groupItemValue("job"), "Job search");
const applications = item(groupItemValue("job/apps"), "Job search Applications");
const health = item(groupItemValue("health"), "Health");
const groupItems = [jobSearch, applications, health];
const newChatItemFor = (value: string) => item(`new-chat:${value}`, "new chat");
const moveItem = item("move", "move current chat to");
const chats: CommandPaletteGroup = {
  value: "threads-search",
  label: "Threads",
  items: [item("thread:1", "Goodfire cover letter")],
};

const shape = (groups: ReadonlyArray<CommandPaletteGroup>) =>
  groups.map((group) => [group.label, group.items.map((entry) => entry.value)]);

describe("arrangePersonalPaletteGroups", () => {
  it("keeps the best chat match first and trails the scope's new chat action", () => {
    const groups = arrangePersonalPaletteGroups({
      groups: [chats],
      query: "cover letter",
      groupItems: [applications],
      scopeValue: jobSearch.value,
      newChatItemFor,
      moveItem,
    });
    expect(shape(groups)).toEqual([
      ["Chats", ["thread:1"]],
      ["Actions", [`new-chat:${jobSearch.value}`, "move"]],
    ]);
  });

  it("lists matching groups after upstream actions and targets a sole match", () => {
    const actions: CommandPaletteGroup = {
      value: "actions",
      label: "Actions",
      items: [item("action:x", "applications export")],
    };
    const groups = arrangePersonalPaletteGroups({
      groups: [actions, chats],
      query: "applications",
      groupItems,
      scopeValue: null,
      newChatItemFor,
      moveItem: null,
    });
    expect(shape(groups)).toEqual([
      ["Actions", ["action:x", `new-chat:${applications.value}`]],
      ["Groups", [applications.value]],
      ["Chats", ["thread:1"]],
    ]);
  });

  it("offers no new chat target when several groups match and nothing is scoped", () => {
    const groups = arrangePersonalPaletteGroups({
      groups: [],
      query: "job",
      groupItems,
      scopeValue: null,
      newChatItemFor,
      moveItem: null,
    });
    expect(shape(groups)).toEqual([["Groups", [jobSearch.value, applications.value]]]);
  });

  it("with an empty query shows groups only while scoped, leading with the scope's new chat", () => {
    const recent: CommandPaletteGroup = {
      value: "recent-threads",
      label: "Recent Threads",
      items: [item("thread:1")],
    };
    const actions: CommandPaletteGroup = {
      value: "actions",
      label: "Actions",
      items: [item("action:x")],
    };
    const unscoped = arrangePersonalPaletteGroups({
      groups: [actions, recent],
      query: "",
      groupItems,
      scopeValue: null,
      newChatItemFor,
      moveItem,
    });
    expect(shape(unscoped)).toEqual([
      ["Actions", ["action:x"]],
      ["Recent chats", ["thread:1"]],
    ]);

    const scoped = arrangePersonalPaletteGroups({
      groups: [actions, recent],
      query: "",
      groupItems: [applications],
      scopeValue: jobSearch.value,
      newChatItemFor,
      moveItem,
    });
    expect(shape(scoped)).toEqual([
      ["Actions", [`new-chat:${jobSearch.value}`, "action:x"]],
      ["Groups", [applications.value]],
      ["Recent chats", ["thread:1"]],
    ]);
  });

  it("leaves the actions-only filter to upstream", () => {
    const groups = arrangePersonalPaletteGroups({
      groups: [],
      query: ">job",
      groupItems,
      scopeValue: jobSearch.value,
      newChatItemFor,
      moveItem,
    });
    expect(groups).toEqual([]);
  });
});
