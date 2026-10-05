/**
 * "Move to…": a searchable picker over the groups of the chat's repo. Typing
 * a name that matches nothing offers to create it as a new workstream. Moves
 * are labels only and lock the chat against the organizer.
 */
import { useMemo, useState } from "react";

import {
  Command,
  CommandDialog,
  CommandDialogPopup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandPanel,
} from "../../components/ui/command";
import { readThreadShell } from "../../state/entities";
import { useMoveThreadDialogStore, useOrganizationActions } from "./organizationActions";
import { useWorkspaceTree } from "./workspaceTree";

interface Option {
  readonly value: string;
  readonly label: string;
  readonly detail?: string;
  readonly path: ReadonlyArray<string>;
}

export function MoveThreadDialog() {
  const threads = useMoveThreadDialogStore((state) => state.threads);
  const close = useMoveThreadDialogStore((state) => state.close);
  const open = threads.length > 0;
  return (
    <CommandDialog open={open} onOpenChange={(next) => (next ? undefined : close())}>
      {open ? <MoveThreadPicker onDone={close} /> : null}
    </CommandDialog>
  );
}

function MoveThreadPicker(props: { readonly onDone: () => void }) {
  const threads = useMoveThreadDialogStore((state) => state.threads);
  const tree = useWorkspaceTree();
  const { moveThread } = useOrganizationActions();
  const [query, setQuery] = useState("");

  const first = threads[0] ? readThreadShell(threads[0]) : null;
  const repo = first ? tree.repoOf(first) : null;
  const currentPath = first ? tree.groupPathOf(first).join("\u0000") : null;

  const options = useMemo((): ReadonlyArray<Option> => {
    if (repo === null) return [];
    const list: Option[] = [];
    const visit = (group: (typeof repo.children)[number]) => {
      list.push({
        value: group.key,
        label: group.path.join(" › "),
        path: group.path,
        ...(group.path.join("\u0000") === currentPath ? { detail: "Current" } : {}),
      });
      for (const child of group.children) visit(child);
    };
    for (const group of repo.children) visit(group);
    list.push({ value: "unsorted", label: "Unsorted", path: [] });
    return list;
  }, [currentPath, repo]);

  const trimmed = query.trim();
  const filtered = useMemo(() => {
    const needle = trimmed.toLocaleLowerCase();
    const matches =
      needle.length === 0
        ? options
        : options.filter((option) => option.label.toLocaleLowerCase().includes(needle));
    const exact = options.some((option) => option.label.toLocaleLowerCase() === needle);
    return trimmed.length > 0 && !exact && trimmed.length <= 40
      ? [
          ...matches,
          {
            value: `create:${trimmed}`,
            label: `New workstream “${trimmed}”`,
            path: [trimmed],
          },
        ]
      : matches;
  }, [options, trimmed]);

  const choose = async (option: Option) => {
    props.onDone();
    for (const thread of threads) await moveThread(thread, option.path);
  };

  return (
    <CommandDialogPopup aria-label="Move to">
      <Command
        mode="none"
        items={filtered.map((option) => option.value)}
        value={query}
        onValueChange={(value) => setQuery(value)}
      >
        <CommandInput
          placeholder={threads.length > 1 ? `Move ${threads.length} chats to…` : "Move to…"}
          onKeyDown={(event) => {
            if (event.key !== "Enter") return;
            const highlighted = document.querySelector<HTMLElement>(
              "[data-slot=command-item][data-highlighted]",
            );
            const option = filtered.find((entry) => entry.value === highlighted?.dataset.value);
            if (option) {
              event.preventDefault();
              void choose(option);
            }
          }}
        />
        <CommandPanel className="max-h-[min(24rem,60vh)]">
          {filtered.length === 0 ? (
            <p className="px-4 py-6 text-center text-muted-foreground text-sm">
              {repo === null ? "This chat has no workspace." : "No matching groups."}
            </p>
          ) : (
            <CommandList>
              {filtered.map((option) => (
                <CommandItem
                  key={option.value}
                  value={option.value}
                  data-value={option.value}
                  onClick={() => void choose(option)}
                >
                  <span className="min-w-0 flex-1 truncate text-sm">{option.label}</span>
                  {option.detail ? (
                    <span className="text-muted-foreground text-xs">{option.detail}</span>
                  ) : null}
                </CommandItem>
              ))}
            </CommandList>
          )}
        </CommandPanel>
      </Command>
    </CommandDialogPopup>
  );
}
