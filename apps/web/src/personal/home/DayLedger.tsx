import {
  buildDayLedger,
  buildDayTodos,
  parseIso,
  formatAge,
  gutterTime,
  type DayTodo,
  type LedgerEntry,
} from "@t3tools/client-runtime/personal/daybook";
import {
  delegationState,
  findCronRunThreadId,
  type WorkingItem,
} from "@t3tools/client-runtime/personal/today";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  type EnvironmentId,
  type ModelSelection,
  type PersonalTodayBrief,
  type PersonalTodaySnapshot,
} from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { PlusIcon } from "lucide-react";
import { useMemo, useRef, useState, type KeyboardEvent } from "react";

import ChatMarkdown from "../../components/ChatMarkdown";
import { Button, InlineButton } from "../../components/ui/button";
import { Checkbox } from "../../components/ui/checkbox";
import { Input } from "../../components/ui/input";
import { Popover, PopoverPopup, PopoverTrigger } from "../../components/ui/popover";
import { ScrollArea } from "../../components/ui/scroll-area";
import {
  Sheet,
  SheetDescription,
  SheetHeader,
  SheetPopup,
  SheetTitle,
} from "../../components/ui/sheet";
import { stackedThreadToast, toastManager } from "../../components/ui/toast";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { personalTodayEnvironment } from "../personalToday";

const GUTTER_ROW = "grid grid-cols-[56px_minmax(0,1fr)_auto] items-baseline gap-x-6";

function reportError(title: string, error: unknown) {
  toastManager.add(
    stackedThreadToast({
      type: "error",
      title,
      description: error instanceof Error ? error.message : "Something went wrong.",
    }),
  );
}

function briefLabel(brief: PersonalTodayBrief): string {
  const at = parseIso(brief.runAt);
  return at !== null && at.getHours() < 12 ? "Morning brief" : brief.jobName;
}

function BriefSheet({
  brief,
  threadIds,
  environmentId,
  open,
  onOpenChange,
}: {
  readonly brief: PersonalTodayBrief;
  readonly threadIds: ReadonlyArray<string>;
  readonly environmentId: EnvironmentId;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}) {
  const navigate = useNavigate();
  const at = parseIso(brief.runAt);
  const chatId = findCronRunThreadId({ threadIds, jobId: brief.jobId, runStamp: brief.runStamp });
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetPopup side="right" className="max-w-xl">
        <SheetHeader>
          <SheetTitle>{briefLabel(brief)}</SheetTitle>
          <SheetDescription>
            {at === null ? brief.jobName : `${brief.jobName}, ${gutterTime(at)}`}
          </SheetDescription>
          {chatId !== null ? (
            <div>
              <InlineButton
                tone="muted"
                onClick={() => {
                  onOpenChange(false);
                  void navigate({
                    to: "/$environmentId/$threadId",
                    params: { environmentId, threadId: chatId },
                  });
                }}
              >
                Open chat
              </InlineButton>
            </div>
          ) : null}
        </SheetHeader>
        <ScrollArea className="min-h-0 flex-1">
          <div className="px-6 pb-8">
            <ChatMarkdown text={brief.markdown} cwd={undefined} environmentId={environmentId} />
          </div>
        </ScrollArea>
      </SheetPopup>
    </Sheet>
  );
}

function LedgerRow({
  entry,
  onReadBrief,
}: {
  readonly entry: LedgerEntry;
  readonly onReadBrief: () => void;
}) {
  const navigate = useNavigate();
  const time = gutterTime(new Date(entry.at));
  if (entry.kind === "brief") {
    return (
      <li className={`${GUTTER_ROW} py-1.5`}>
        <span className="text-sm tabular-nums text-muted-foreground">{time}</span>
        <span className="truncate text-base text-foreground">{briefLabel(entry.brief)}</span>
        <InlineButton tone="muted" onClick={onReadBrief}>
          Read
        </InlineButton>
      </li>
    );
  }
  if (entry.kind === "routine") {
    return (
      <li className={`${GUTTER_ROW} py-1.5`}>
        <span className="text-sm tabular-nums text-muted-foreground">{time}</span>
        <span className="truncate text-base text-foreground">
          {entry.routine.name} {entry.failed ? "failed" : "ran"}
        </span>
        <span />
      </li>
    );
  }
  const thread = entry.thread;
  return (
    <li className={`${GUTTER_ROW} py-1.5`}>
      <span className="text-sm tabular-nums text-muted-foreground">{time}</span>
      <span className="truncate text-base text-foreground">{thread.title} finished</span>
      <InlineButton
        tone="muted"
        onClick={() =>
          void navigate({
            to: "/$environmentId/$threadId",
            params: { environmentId: thread.environmentId, threadId: thread.id },
          })
        }
      >
        Open
      </InlineButton>
    </li>
  );
}

function WorkingLine({
  working,
  nowMs,
}: {
  readonly working: ReadonlyArray<WorkingItem>;
  readonly nowMs: number;
}) {
  const navigate = useNavigate();
  const interrupt = useAtomCommand(threadEnvironment.interruptTurn, { reportFailure: false });
  if (working.length === 0) return null;
  const names = working.map((item) => item.thread.title).join(", ");
  return (
    <div className={GUTTER_ROW}>
      <span />
      <Popover>
        <PopoverTrigger
          render={
            <button
              type="button"
              className="flex min-w-0 items-center gap-2 py-1 text-left text-xs text-muted-foreground hover:text-foreground"
            />
          }
        >
          <span aria-hidden="true" className="size-1.5 shrink-0 rounded-full bg-success" />
          <span className="truncate">
            {working.length === 1 ? "1 agent working" : `${working.length} agents working`}: {names}
          </span>
        </PopoverTrigger>
        <PopoverPopup align="start" side="bottom">
          <ul className="flex w-80 flex-col gap-1 py-1">
            {working.map((item) => (
              <li
                key={`${item.thread.environmentId}:${item.thread.id}`}
                className="flex items-center gap-3"
              >
                <button
                  type="button"
                  className="min-w-0 flex-1 text-left"
                  onClick={() =>
                    void navigate({
                      to: "/$environmentId/$threadId",
                      params: {
                        environmentId: item.thread.environmentId,
                        threadId: item.thread.id,
                      },
                    })
                  }
                >
                  <span className="block truncate text-sm text-foreground">
                    {item.thread.title}
                  </span>
                  {item.activity ? (
                    <span className="block truncate text-xs text-muted-foreground">
                      {item.activity}
                    </span>
                  ) : null}
                </button>
                {item.startedAt ? (
                  <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                    {formatAge(Date.parse(item.startedAt), nowMs)}
                  </span>
                ) : null}
                <Button
                  size="xs"
                  variant="ghost-muted"
                  onClick={() => {
                    void interrupt({
                      environmentId: item.thread.environmentId,
                      input: { threadId: item.thread.id },
                    }).then((result) => {
                      if (result._tag === "Failure") {
                        reportError("Could not stop the agent", squashAtomCommandFailure(result));
                      }
                    });
                  }}
                >
                  Stop
                </Button>
              </li>
            ))}
          </ul>
        </PopoverPopup>
      </Popover>
      <span />
    </div>
  );
}

const DELEGATION_WORDS = {
  working: "with Hermes",
  needs_you: "Hermes has a question",
  review: "ready for review",
  failed: "Hermes stopped with an error",
  missing: "with Hermes",
} as const;

function RescheduleControl({
  onReschedule,
}: {
  readonly onReschedule: (dueString: string) => void;
}) {
  const [value, setValue] = useState("");
  const [open, setOpen] = useState(false);
  const choose = (dueString: string) => {
    setOpen(false);
    setValue("");
    onReschedule(dueString);
  };
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger render={<InlineButton tone="muted" />}>Reschedule</PopoverTrigger>
      <PopoverPopup align="end" side="bottom">
        <div className="flex w-64 flex-col gap-2 py-1">
          <Input
            autoFocus
            size="sm"
            value={value}
            placeholder="tomorrow 9am"
            aria-label="New due date"
            onChange={(event) => setValue(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && value.trim()) choose(value.trim());
            }}
          />
          <div className="flex gap-4 text-sm">
            <InlineButton tone="muted" onClick={() => choose("tomorrow")}>
              Tomorrow
            </InlineButton>
            <InlineButton tone="muted" onClick={() => choose("next week")}>
              Next week
            </InlineButton>
          </div>
        </div>
      </PopoverPopup>
    </Popover>
  );
}

function TodoRow({
  todo,
  thread,
  onComplete,
  onDelegate,
  onReschedule,
}: {
  readonly todo: DayTodo;
  readonly thread: EnvironmentThreadShell | undefined;
  readonly onComplete: () => void;
  readonly onDelegate: () => void;
  readonly onReschedule: (dueString: string) => void;
}) {
  const navigate = useNavigate();
  const delegation = todo.task.delegation;
  const state = delegation === null ? null : delegationState(thread);
  return (
    <li className={`group ${GUTTER_ROW} py-1.5`}>
      <span className="text-sm tabular-nums text-muted-foreground">{todo.gutter}</span>
      <label className="flex min-w-0 items-center gap-3">
        <Checkbox aria-label={`Complete ${todo.task.content}`} onCheckedChange={onComplete} />
        <span className="truncate text-base text-foreground">{todo.task.content}</span>
        {state !== null ? (
          <span
            className={
              state === "needs_you" || state === "review"
                ? "shrink-0 text-xs text-warning-foreground"
                : "shrink-0 text-xs text-muted-foreground"
            }
          >
            {DELEGATION_WORDS[state]}
          </span>
        ) : null}
      </label>
      <div className="hidden items-baseline gap-4 text-sm group-focus-within:flex group-hover:flex">
        {delegation !== null && thread !== undefined ? (
          <InlineButton
            tone="muted"
            onClick={() =>
              void navigate({
                to: "/$environmentId/$threadId",
                params: { environmentId: thread.environmentId, threadId: thread.id },
              })
            }
          >
            Open
          </InlineButton>
        ) : delegation === null ? (
          <InlineButton tone="muted" onClick={onDelegate}>
            Ask Hermes
          </InlineButton>
        ) : null}
        <RescheduleControl onReschedule={onReschedule} />
      </div>
    </li>
  );
}

function AddTodo({ onAdd }: { readonly onAdd: (text: string) => Promise<boolean> }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const onKeyDown = async (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Escape") {
      setEditing(false);
      setValue("");
      return;
    }
    if (event.key !== "Enter" || !value.trim() || busy) return;
    setBusy(true);
    const added = await onAdd(value.trim());
    setBusy(false);
    if (added) setValue("");
    inputRef.current?.focus();
  };
  return (
    <div className={`${GUTTER_ROW} py-1.5`}>
      <span />
      {editing ? (
        <Input
          ref={inputRef}
          autoFocus
          size="sm"
          value={value}
          disabled={busy}
          placeholder="Call dentist tomorrow 9am"
          aria-label="New to-do"
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={(event) => void onKeyDown(event)}
          onBlur={() => {
            if (!value.trim()) setEditing(false);
          }}
        />
      ) : (
        <InlineButton tone="muted" onClick={() => setEditing(true)}>
          <PlusIcon className="size-3.5" />
          Add to-do
        </InlineButton>
      )}
      <span />
    </div>
  );
}

/**
 * The day ledger: what happened today above a thin "now" rule, open to-dos
 * below it. Sections with nothing to show disappear.
 */
export function DayLedger({
  environmentId,
  snapshot,
  threads,
  working,
  now,
  fallbackModelSelection,
}: {
  readonly environmentId: EnvironmentId;
  readonly snapshot: PersonalTodaySnapshot | null;
  readonly threads: ReadonlyArray<EnvironmentThreadShell>;
  readonly working: ReadonlyArray<WorkingItem>;
  readonly now: Date;
  readonly fallbackModelSelection: ModelSelection | null;
}) {
  const navigate = useNavigate();
  const [briefOpen, setBriefOpen] = useState(false);
  const [hidden, setHidden] = useState<ReadonlySet<string>>(new Set());
  const taskAction = useAtomCommand(personalTodayEnvironment.taskAction, { reportFailure: false });
  const environmentThreads = useMemo(
    () => threads.filter((thread) => thread.environmentId === environmentId),
    [environmentId, threads],
  );
  const threadById = useMemo(
    () => new Map(environmentThreads.map((thread) => [thread.id as string, thread])),
    [environmentThreads],
  );
  const ledger = useMemo(
    () =>
      buildDayLedger({
        now,
        brief: snapshot?.cron.brief ?? null,
        routines: snapshot?.cron.routines ?? [],
        threads,
      }),
    [now, snapshot, threads],
  );
  const todos = useMemo(
    () =>
      buildDayTodos(snapshot?.tasks.tasks ?? [], now).filter((todo) => !hidden.has(todo.task.id)),
    [hidden, now, snapshot],
  );
  const tasksState = snapshot?.tasks.status ?? "loading";
  const brief = snapshot?.cron.brief ?? null;
  const nowMs = now.getTime();

  const run = async (
    input: Parameters<typeof taskAction>[0]["input"],
    failureTitle: string,
  ): Promise<boolean> => {
    const result = await taskAction({ environmentId, input });
    if (result._tag === "Failure") {
      reportError(failureTitle, squashAtomCommandFailure(result));
      return false;
    }
    return true;
  };

  const complete = (todo: DayTodo) => {
    const id = todo.task.id;
    setHidden((current) => new Set(current).add(id));
    void run({ type: "complete", taskId: id }, "Could not complete the to-do").then((done) => {
      if (!done) {
        setHidden((current) => {
          const next = new Set(current);
          next.delete(id);
          return next;
        });
        return;
      }
      const toastId = toastManager.add({
        type: "success",
        title: "Done",
        description: todo.task.content,
        actionProps: {
          children: "Undo",
          onClick: () => {
            toastManager.close(toastId);
            void run({ type: "reopen", taskId: id }, "Could not reopen the to-do").then(() =>
              setHidden((current) => {
                const next = new Set(current);
                next.delete(id);
                return next;
              }),
            );
          },
        },
      });
    });
  };

  const delegate = (todo: DayTodo) => {
    void taskAction({
      environmentId,
      input: {
        type: "delegate",
        taskId: todo.task.id,
        ...(fallbackModelSelection ? { fallbackModelSelection } : {}),
      },
    }).then((result) => {
      if (result._tag === "Failure") {
        reportError("Could not hand the to-do to Hermes", squashAtomCommandFailure(result));
        return;
      }
      const threadId = result.value.threadId;
      const toastId = toastManager.add({
        type: "success",
        title: "Hermes is on it",
        description: todo.task.content,
        ...(threadId
          ? {
              actionProps: {
                children: "Open",
                onClick: () => {
                  toastManager.close(toastId);
                  void navigate({
                    to: "/$environmentId/$threadId",
                    params: { environmentId, threadId },
                  });
                },
              },
            }
          : {}),
      });
    });
  };

  const hasPast = ledger.length > 0;
  const hasFuture = todos.length > 0;
  const showRule = hasPast || hasFuture || working.length > 0;

  return (
    <section aria-label="Today" className="flex flex-col">
      {hasPast ? (
        <ul>
          {ledger.map((entry) => (
            <LedgerRow key={entry.key} entry={entry} onReadBrief={() => setBriefOpen(true)} />
          ))}
        </ul>
      ) : null}
      {showRule ? (
        <div className="my-2 flex items-center gap-3" role="separator" aria-label="Now">
          <span className="text-sm font-semibold tabular-nums text-primary">
            now {gutterTime(now)}
          </span>
          <span aria-hidden="true" className="h-0.5 flex-1 rounded-full bg-primary" />
        </div>
      ) : null}
      <WorkingLine working={working} nowMs={nowMs} />
      {hasFuture ? (
        <ul className="mt-1">
          {todos.map((todo) => (
            <TodoRow
              key={todo.task.id}
              todo={todo}
              thread={
                todo.task.delegation ? threadById.get(todo.task.delegation.threadId) : undefined
              }
              onComplete={() => complete(todo)}
              onDelegate={() => delegate(todo)}
              onReschedule={(dueString) =>
                void run(
                  { type: "reschedule", taskId: todo.task.id, dueString },
                  "Could not reschedule the to-do",
                )
              }
            />
          ))}
        </ul>
      ) : null}
      {tasksState === "disabled" ? null : (
        <AddTodo onAdd={(text) => run({ type: "add", text }, "Could not add the to-do")} />
      )}
      {tasksState === "error" ? (
        <p className={`${GUTTER_ROW} text-xs text-muted-foreground`}>
          <span />
          <span>Todoist did not answer, so this is the last list it sent.</span>
        </p>
      ) : null}
      {brief !== null ? (
        <BriefSheet
          brief={brief}
          threadIds={environmentThreads.map((thread) => thread.id)}
          environmentId={environmentId}
          open={briefOpen}
          onOpenChange={setBriefOpen}
        />
      ) : null}
    </section>
  );
}
