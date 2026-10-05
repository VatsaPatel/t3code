import { useAtomValue } from "@effect/atom-react";
import { resolveGroupPath } from "@t3tools/client-runtime/personal/organizationTree";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  type EnvironmentId,
  type ModelSelection,
  type PersonalGroup,
  type PersonalGroupId,
  type ProviderInstanceId,
} from "@t3tools/contracts";
import { truncate } from "@t3tools/shared/String";
import { useNavigate } from "@tanstack/react-router";
import { CheckIcon, ChevronDownIcon } from "lucide-react";
import { useCallback, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from "react";

import { ComposerControl } from "../../components/chat/ComposerControl";
import { ComposerSurface } from "../../components/chat/ComposerSurface";
import { ProviderModelPicker } from "../../components/chat/ProviderModelPicker";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "../../components/ui/menu";
import { Spinner } from "../../components/ui/spinner";
import { stackedThreadToast, toastManager } from "../../components/ui/toast";
import { useEnvironmentSettings } from "../../hooks/useSettings";
import { useScratchProject } from "../../hooks/useScratchProject";
import { newMessageId, newThreadId } from "../../lib/utils";
import { getCustomModelOptionsByInstance } from "../../modelSelection";
import {
  applyProviderInstanceSettings,
  deriveProviderInstanceEntries,
  getDefaultProviderInstanceModel,
  sortProviderInstanceEntries,
} from "../../providerInstances";
import { useEnvironmentQuery } from "../../state/query";
import { EMPTY_SERVER_PROVIDERS, serverEnvironment } from "../../state/server";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { ComposerDictationButton } from "../ComposerDictationButton";
import type { ComposerDictationDraft } from "../useComposerDictation";
import { personalOrganizationEnvironment } from "../personalOrganization";

const HERMES = "hermes";

/** Hermes when this machine has it, else the user's default model. */
export function useDefaultSelection(environmentId: EnvironmentId) {
  const settings = useEnvironmentSettings(environmentId);
  const providers =
    useAtomValue(serverEnvironment.providersValueAtom(environmentId)) ?? EMPTY_SERVER_PROVIDERS;
  const instanceEntries = useMemo(
    () =>
      sortProviderInstanceEntries(
        applyProviderInstanceSettings(deriveProviderInstanceEntries(providers), settings),
      ),
    [providers, settings],
  );
  const fallback = useMemo((): ModelSelection | null => {
    const hermes =
      instanceEntries.find((entry) => entry.instanceId === HERMES) ??
      instanceEntries.find((entry) => entry.driverKind === HERMES);
    if (hermes) {
      const model = getDefaultProviderInstanceModel(providers, hermes.instanceId);
      if (model) return { instanceId: hermes.instanceId, model };
    }
    if (settings.defaultModelSelection) return settings.defaultModelSelection;
    const first = instanceEntries[0];
    const model = first ? getDefaultProviderInstanceModel(providers, first.instanceId) : undefined;
    return first && model ? { instanceId: first.instanceId, model } : null;
  }, [instanceEntries, providers, settings.defaultModelSelection]);
  return { settings, providers, instanceEntries, fallback };
}

interface GroupChoice {
  readonly id: PersonalGroupId;
  readonly label: string;
  readonly group: PersonalGroup;
}

/**
 * The Home composer: one line that starts a chat, Hermes by default. It uses
 * the same launch path as a draft's first message, in the chosen group's
 * project, or the "No project" scratch space for Personal.
 */
export function HomeComposer({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const navigate = useNavigate();
  const { settings, providers, instanceEntries, fallback } = useDefaultSelection(environmentId);
  const [chosen, setChosen] = useState<ModelSelection | null>(null);
  const selection = chosen ?? fallback;
  const [groupId, setGroupId] = useState<PersonalGroupId | null>(null);
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const { openScratchProject } = useScratchProject();
  const startTurn = useAtomCommand(threadEnvironment.startTurn, { reportFailure: false });
  const moveThread = useAtomCommand(personalOrganizationEnvironment.moveThread, {
    reportFailure: false,
  });
  const organization = useEnvironmentQuery(
    personalOrganizationEnvironment.organizationLive({ environmentId, input: {} }),
  ).data;

  const groups = useMemo((): ReadonlyArray<GroupChoice> => {
    if (organization == null) return [];
    return Object.values(organization.groupsById)
      .map((group) => ({
        id: group.id,
        label: resolveGroupPath(organization, group.id).join(", "),
        group,
      }))
      .sort((left, right) => left.label.localeCompare(right.label));
  }, [organization]);
  const chosenGroup = groups.find((choice) => choice.id === groupId) ?? null;

  const modelOptionsByInstance = useMemo(
    () =>
      getCustomModelOptionsByInstance(
        settings,
        providers,
        selection?.instanceId ?? null,
        selection?.model ?? null,
      ),
    [settings, providers, selection],
  );
  const activeEntry = instanceEntries.find((entry) => entry.instanceId === selection?.instanceId);
  const placeholder = activeEntry ? `Ask ${activeEntry.displayName}` : "Ask Hermes";

  const dictationDraft = useMemo(
    (): ComposerDictationDraft => ({
      ownerKey: `home:${environmentId}`,
      readSnapshot: () => {
        const element = textareaRef.current;
        const value = element?.value ?? "";
        return { value, expandedCursor: element?.selectionStart ?? value.length };
      },
      applyReplacement: (start, end, replacement, options) => {
        const element = textareaRef.current;
        if (!element || element.value.slice(start, end) !== options.expectedText) return false;
        const next = `${element.value.slice(0, start)}${replacement}${element.value.slice(end)}`;
        setText(next);
        requestAnimationFrame(() => {
          element.focus();
          element.setSelectionRange(
            options.expandedCursorAfterReplace,
            options.expandedCursorAfterReplace,
          );
        });
        return true;
      },
    }),
    [environmentId],
  );

  const submit = useCallback(async () => {
    const message = text.trim();
    if (!message || !selection || sending) return;
    setSending(true);
    try {
      const projectId =
        chosenGroup?.group.projectId ??
        (await openScratchProject(environmentId, "Could not start the chat"))?.id;
      if (!projectId) return;
      const threadId = newThreadId();
      const createdAt = new Date().toISOString();
      const title = truncate(message);
      const runtimeMode = settings.defaultRuntimeMode;
      const result = await startTurn({
        environmentId,
        input: {
          threadId,
          message: { messageId: newMessageId(), role: "user", text: message, attachments: [] },
          modelSelection: selection,
          titleSeed: title,
          runtimeMode,
          interactionMode: "default",
          bootstrap: {
            createThread: {
              projectId,
              title,
              modelSelection: selection,
              runtimeMode,
              interactionMode: "default",
              branch: null,
              worktreePath: null,
              createdAt,
            },
          },
          createdAt,
        },
      });
      if (result._tag === "Failure") {
        if (!isAtomCommandInterrupted(result)) {
          const error = squashAtomCommandFailure(result);
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Could not start the chat",
              description: error instanceof Error ? error.message : "The message was not sent.",
            }),
          );
        }
        return;
      }
      setText("");
      if (chosenGroup) {
        await moveThread({
          environmentId,
          input: { threadId, target: { type: "group", groupId: chosenGroup.id } },
        });
      }
      void navigate({ to: "/$environmentId/$threadId", params: { environmentId, threadId } });
    } finally {
      setSending(false);
    }
  }, [
    chosenGroup,
    environmentId,
    moveThread,
    navigate,
    openScratchProject,
    selection,
    sending,
    settings.defaultRuntimeMode,
    startTurn,
    text,
  ]);

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void submit();
    }
  };
  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    void submit();
  };

  return (
    <form onSubmit={onSubmit}>
      <ComposerSurface.Shell className="mx-0 max-w-none">
        <ComposerSurface.Host>
          <ComposerSurface.Main>
            <div className="flex flex-col gap-1 px-3 pt-3 pb-2">
              <textarea
                ref={textareaRef}
                value={text}
                rows={1}
                onChange={(event) => setText(event.target.value)}
                onKeyDown={onKeyDown}
                placeholder={placeholder}
                aria-label={placeholder}
                className="field-sizing-content max-h-40 min-h-7 w-full resize-none bg-transparent px-1 text-base leading-6 text-foreground outline-none placeholder:text-muted-foreground/70"
              />
              <div className="flex items-center gap-1">
                {selection ? (
                  <ProviderModelPicker
                    activeInstanceId={selection.instanceId}
                    model={selection.model}
                    lockedProvider={null}
                    instanceEntries={instanceEntries}
                    modelOptionsByInstance={modelOptionsByInstance}
                    onInstanceModelChange={(instanceId: ProviderInstanceId, model: string) =>
                      setChosen({ instanceId, model })
                    }
                  />
                ) : null}
                <Menu>
                  <MenuTrigger render={<ComposerControl aria-label="Group for the new chat" />}>
                    {chosenGroup?.group.name ?? "Personal"}
                    <ChevronDownIcon />
                  </MenuTrigger>
                  <MenuPopup align="start" side="bottom">
                    <MenuItem onClick={() => setGroupId(null)}>
                      Personal
                      {groupId === null ? <CheckIcon className="ms-auto" /> : null}
                    </MenuItem>
                    {groups.length > 0 ? <MenuSeparator /> : null}
                    {groups.map((choice) => (
                      <MenuItem key={choice.id} onClick={() => setGroupId(choice.id)}>
                        {choice.label}
                        {choice.id === groupId ? <CheckIcon className="ms-auto" /> : null}
                      </MenuItem>
                    ))}
                  </MenuPopup>
                </Menu>
                <div className="ms-auto flex items-center gap-1">
                  <ComposerDictationButton environmentId={environmentId} draft={dictationDraft} />
                  <button
                    type="submit"
                    aria-label="Start chat"
                    disabled={sending || text.trim().length === 0 || selection === null}
                    className="relative isolate flex size-8 items-center justify-center overflow-hidden rounded-full bg-message-action text-message-action-foreground shadow-xs shadow-message-action/24 transition-[scale] duration-150 enabled:cursor-pointer hover:bg-message-action-hover enabled:hover:scale-105 disabled:pointer-events-none disabled:opacity-64 disabled:shadow-none [&_svg]:pointer-events-none"
                  >
                    {sending ? (
                      <Spinner size="sm" aria-hidden="true" />
                    ) : (
                      <svg
                        width="14"
                        height="14"
                        viewBox="0 0 14 14"
                        fill="none"
                        aria-hidden="true"
                      >
                        <path
                          d="M7 11.5V2.5M7 2.5L3 6.5M7 2.5L11 6.5"
                          stroke="currentColor"
                          strokeWidth="1.8"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        />
                      </svg>
                    )}
                  </button>
                </div>
              </div>
            </div>
          </ComposerSurface.Main>
        </ComposerSurface.Host>
      </ComposerSurface.Shell>
    </form>
  );
}
