import { findCronRunThreadId } from "@t3tools/client-runtime/personal/today";
import { gutterTime, parseIso } from "@t3tools/client-runtime/personal/daybook";
import { buildRoutineRows, type RoutineRow } from "@t3tools/client-runtime/personal/routines";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, ScheduledTask } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { PlusIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import ChatMarkdown from "../../components/ChatMarkdown";
import { ScheduledTaskEditorDialog } from "../../components/settings/ScheduledTasksSettings";
import { SettingsScopeProvider } from "../../components/settings/SettingsScopeContext";
import { Button, InlineButton } from "../../components/ui/button";
import { ScrollArea } from "../../components/ui/scroll-area";
import { SidebarInset } from "../../components/ui/sidebar";
import { stackedThreadToast, toastManager } from "../../components/ui/toast";
import { WorkspacePageHeader } from "../../components/WorkspacePageHeader";
import { isElectron } from "../../env";
import { useThreadShells } from "../../state/entities";
import { useEnvironments, usePrimaryEnvironmentId } from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { useNow } from "../home/time";
import { personalTodayEnvironment } from "../personalToday";

type ScheduledEntry = { readonly environmentId: EnvironmentId; readonly task: ScheduledTask };

function reportError(title: string, error: unknown) {
  toastManager.add(
    stackedThreadToast({
      type: "error",
      title,
      description: error instanceof Error ? error.message : "Something went wrong.",
    }),
  );
}

/** Reports one environment's T3 scheduled tasks to the page. */
function ScheduledTasksSource({
  environmentId,
  onTasks,
}: {
  readonly environmentId: EnvironmentId;
  readonly onTasks: (environmentId: EnvironmentId, tasks: ReadonlyArray<ScheduledTask>) => void;
}) {
  const tasks = useEnvironmentQuery(
    serverEnvironment.scheduledTasksLive({ environmentId, input: {} }),
  ).data?.tasks;
  useEffect(() => {
    onTasks(environmentId, tasks ?? []);
  }, [environmentId, onTasks, tasks]);
  return null;
}

const STATUS_CLASS = {
  ok: "text-muted-foreground",
  running: "text-muted-foreground",
  paused: "text-muted-foreground",
  missed: "text-muted-foreground",
  failed: "text-destructive-foreground",
} as const;

function RoutineListRow({
  row,
  selected,
  onSelect,
}: {
  readonly row: RoutineRow;
  readonly selected: boolean;
  readonly onSelect: () => void;
}) {
  return (
    <li>
      <button
        type="button"
        onClick={onSelect}
        aria-current={selected ? "true" : undefined}
        className="grid w-full grid-cols-[5rem_minmax(0,1fr)_auto] items-baseline gap-x-6 rounded-lg px-3 py-3 text-left hover:bg-accent/50 aria-[current=true]:bg-accent/60"
      >
        <span className="text-sm tabular-nums text-muted-foreground">{row.gutter}</span>
        <span className="min-w-0">
          <span className="block truncate text-base font-medium text-foreground">{row.name}</span>
          <span className="block truncate text-xs text-muted-foreground">{row.cadence}</span>
        </span>
        {row.status !== null ? (
          <span className={`flex items-center gap-2 text-sm ${STATUS_CLASS[row.status]}`}>
            {row.status === "missed" ? (
              <span aria-hidden="true" className="size-1.5 rounded-full bg-warning" />
            ) : null}
            {row.status}
          </span>
        ) : (
          <span />
        )}
      </button>
    </li>
  );
}

function deliveryWords(deliver: string | null, notifies: boolean): string | null {
  const targets: string[] = [];
  if (deliver !== null) {
    const kind = deliver.split(":")[0] ?? deliver;
    if (kind === "slack") targets.push("Slack");
    else if (kind === "whatsapp") targets.push("WhatsApp");
    else if (kind === "origin") targets.push("the chat it came from");
    else if (kind !== "local") targets.push(kind);
  }
  if (notifies) targets.push("T3");
  if (targets.length === 0) return null;
  return `Posts to ${targets.join(" and ")}.`;
}

function formatRunDate(iso: string | null): string | null {
  if (iso === null) return null;
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return null;
  const date = new Date(ms);
  return `${date.getDate()} ${date.toLocaleString(undefined, { month: "short" })} ${gutterTime(date)}`;
}

function HermesRoutineDetail({
  environmentId,
  row,
  threadIds,
}: {
  readonly environmentId: EnvironmentId;
  readonly row: Extract<RoutineRow, { source: "hermes" }>;
  readonly threadIds: ReadonlyArray<string>;
}) {
  const navigate = useNavigate();
  const [stamp, setStamp] = useState<string | undefined>(undefined);
  const history = useEnvironmentQuery(
    personalTodayEnvironment.routineHistory({
      environmentId,
      input: stamp === undefined ? { jobId: row.routine.id } : { jobId: row.routine.id, stamp },
    }),
  ).data;
  const routineAction = useAtomCommand(personalTodayEnvironment.routineAction, {
    reportFailure: false,
  });
  const [busy, setBusy] = useState(false);
  const act = (action: "run" | "pause" | "resume") => {
    setBusy(true);
    void routineAction({ environmentId, input: { jobId: row.routine.id, action } }).then(
      (result) => {
        setBusy(false);
        if (result._tag === "Failure") {
          reportError("Hermes did not accept that", squashAtomCommandFailure(result));
        } else if (action === "run") {
          toastManager.add({ type: "success", title: `${row.name} will run on the next tick` });
        }
      },
    );
  };
  const openChat = (outputStamp: string) => {
    const chatId = findCronRunThreadId({ threadIds, jobId: row.routine.id, runStamp: outputStamp });
    return chatId === null
      ? null
      : () =>
          void navigate({
            to: "/$environmentId/$threadId",
            params: { environmentId, threadId: chatId },
          });
  };
  const latestRun = history?.runs[0];
  const shownAt = parseIso(history?.output?.runAt);
  const delivery = deliveryWords(row.routine.deliver, row.routine.notifies);
  const schedule =
    row.routine.intervalMinutes !== null
      ? `Every ${row.gutter.replace(/^every /, "")}`
      : row.cadence.replace(/, Hermes$/, "");

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <h2 className="text-xl font-semibold text-foreground">{row.name}</h2>
        <p className="text-sm text-muted-foreground">
          {schedule}. {delivery ?? ""}
        </p>
      </div>
      <div className="-ms-2.5 flex gap-1">
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => act("run")}>
          Run now
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={busy}
          onClick={() => act(row.enabled ? "pause" : "resume")}
        >
          {row.enabled ? "Pause" : "Resume"}
        </Button>
      </div>
      {history?.output ? (
        <div className="flex flex-col gap-3">
          <p className="text-xs tabular-nums text-muted-foreground">
            {stamp === undefined ? "Last run" : "Run"}
            {shownAt
              ? `, ${shownAt.getDate()} ${shownAt.toLocaleString(undefined, { month: "short" })} ${gutterTime(shownAt)}`
              : ""}
            {stamp === undefined && latestRun?.durationSeconds != null
              ? `, ${latestRun.durationSeconds} s`
              : ""}
          </p>
          <ChatMarkdown
            text={history.output.markdown}
            cwd={undefined}
            environmentId={environmentId}
          />
        </div>
      ) : row.routine.lastRunAt === null ? (
        <p className="text-sm text-muted-foreground">It has not run yet.</p>
      ) : null}
      {history && history.runs.length > 0 ? (
        <div className="flex flex-col gap-2">
          <h3 className="text-sm font-medium text-muted-foreground">History</h3>
          <ul>
            {history.runs.map((run, index) => {
              const when = formatRunDate(run.finishedAt ?? run.startedAt);
              const failed = run.status === "failed";
              const open = run.outputStamp === null ? null : openChat(run.outputStamp);
              return (
                <li
                  key={`${run.startedAt ?? index}`}
                  className="grid grid-cols-[7rem_minmax(0,1fr)_auto] items-baseline gap-x-4 py-1.5 text-sm"
                >
                  <span className="tabular-nums text-muted-foreground">{when ?? ""}</span>
                  <span
                    className={
                      failed ? "truncate text-destructive-foreground" : "truncate text-foreground"
                    }
                  >
                    {failed
                      ? `failed${run.error ? `, ${run.error}` : ""}`
                      : run.status === "completed"
                        ? "ok"
                        : run.status}
                  </span>
                  <span className="flex gap-4">
                    {run.outputStamp !== null && run.outputStamp !== history.output?.stamp ? (
                      <InlineButton
                        tone="muted"
                        onClick={() => setStamp(run.outputStamp ?? undefined)}
                      >
                        Show output
                      </InlineButton>
                    ) : null}
                    {open ? (
                      <InlineButton tone="muted" onClick={open}>
                        Open chat
                      </InlineButton>
                    ) : null}
                  </span>
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

function ScheduledTaskDetail({
  row,
  onEdit,
}: {
  readonly row: Extract<RoutineRow, { source: "t3" }>;
  readonly onEdit: () => void;
}) {
  const navigate = useNavigate();
  const runNow = useAtomCommand(serverEnvironment.runScheduledTaskNow, { reportFailure: false });
  const setEnabled = useAtomCommand(serverEnvironment.setScheduledTaskEnabled, {
    reportFailure: false,
  });
  const [busy, setBusy] = useState(false);
  const { task, environmentId } = row;
  const finish = (result: Awaited<ReturnType<typeof runNow>>, failureTitle: string) => {
    setBusy(false);
    if (result._tag === "Failure") reportError(failureTitle, squashAtomCommandFailure(result));
  };
  const lastRun = formatRunDate(task.lastRunAt);
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <h2 className="text-xl font-semibold text-foreground">{row.name}</h2>
        <p className="text-sm text-muted-foreground">
          {row.cadence.replace(/, T3$/, "")}. Runs in T3.
        </p>
      </div>
      <div className="-ms-2.5 flex gap-1">
        <Button
          size="sm"
          variant="ghost"
          disabled={busy}
          onClick={() => {
            setBusy(true);
            void runNow({ environmentId, input: { id: task.id } }).then((result) =>
              finish(result, "Could not run the routine"),
            );
          }}
        >
          Run now
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={busy}
          onClick={() => {
            setBusy(true);
            void setEnabled({ environmentId, input: { id: task.id, enabled: !task.enabled } }).then(
              (result) => finish(result, "Could not change the routine"),
            );
          }}
        >
          {task.enabled ? "Pause" : "Resume"}
        </Button>
        <Button size="sm" variant="ghost" onClick={onEdit}>
          Edit
        </Button>
      </div>
      <p className="text-sm text-foreground">{task.prompt}</p>
      {lastRun !== null ? (
        <p className="text-xs tabular-nums text-muted-foreground">
          Last run, {lastRun}
          {task.lastRunStatus === "failed" ? ", failed" : ""}
          {task.lastRunError ? `: ${task.lastRunError}` : ""}
        </p>
      ) : (
        <p className="text-sm text-muted-foreground">It has not run yet.</p>
      )}
      {task.threadId !== null ? (
        <div>
          <InlineButton
            tone="muted"
            onClick={() =>
              void navigate({
                to: "/$environmentId/$threadId",
                params: { environmentId, threadId: task.threadId! },
              })
            }
          >
            Open chat
          </InlineButton>
        </div>
      ) : null}
    </div>
  );
}

/**
 * Routines: Hermes cron jobs and T3 scheduled tasks in one list by next run,
 * with the selected routine's output and history beside it.
 */
export function RoutinesPage() {
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const { environments } = useEnvironments();
  const now = useNow(60_000);
  const threads = useThreadShells();
  const snapshot = useEnvironmentQuery(
    primaryEnvironmentId === null
      ? null
      : personalTodayEnvironment.live({ environmentId: primaryEnvironmentId, input: {} }),
  ).data;
  const [scheduledByEnvironment, setScheduledByEnvironment] = useState<
    ReadonlyMap<EnvironmentId, ReadonlyArray<ScheduledTask>>
  >(new Map());
  const onTasks = useCallback(
    (environmentId: EnvironmentId, tasks: ReadonlyArray<ScheduledTask>) =>
      setScheduledByEnvironment((current) => {
        if (current.get(environmentId) === tasks) return current;
        return new Map(current).set(environmentId, tasks);
      }),
    [],
  );
  const connectedIds = environments
    .filter((environment) => environment.connection.phase === "connected")
    .map((environment) => environment.environmentId);
  const rows = useMemo(() => {
    const scheduled: ScheduledEntry[] = [];
    for (const [environmentId, tasks] of scheduledByEnvironment) {
      for (const task of tasks) scheduled.push({ environmentId, task });
    }
    return buildRoutineRows({ now, hermes: snapshot?.cron.routines ?? [], scheduled });
  }, [now, scheduledByEnvironment, snapshot]);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const selected = rows.find((row) => row.key === selectedKey) ?? rows[0] ?? null;
  const [editor, setEditor] = useState<{
    readonly environmentId: EnvironmentId;
    readonly task: ScheduledTask | null;
  } | null>(null);
  const threadIds = useMemo(
    () =>
      threads
        .filter((thread) => thread.environmentId === primaryEnvironmentId)
        .map((thread) => thread.id),
    [primaryEnvironmentId, threads],
  );

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none isolate">
      {connectedIds.map((environmentId) => (
        <ScheduledTasksSource key={environmentId} environmentId={environmentId} onTasks={onTasks} />
      ))}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background text-foreground">
        <WorkspacePageHeader electron={isElectron}>
          <h1 className="text-sm font-medium text-foreground">Routines</h1>
        </WorkspacePageHeader>
        <div className="flex min-h-0 flex-1">
          <ScrollArea className="min-h-0 min-w-0 flex-1 lg:max-w-[44rem]">
            <div className="flex flex-col gap-6 px-6 pt-10 pb-16 sm:px-9">
              <div className="flex items-baseline justify-between ps-3">
                <h2 className="text-2xl leading-tight font-semibold tracking-tight text-foreground">
                  Routines
                </h2>
                {primaryEnvironmentId !== null ? (
                  <InlineButton
                    tone="muted"
                    onClick={() => setEditor({ environmentId: primaryEnvironmentId, task: null })}
                  >
                    <PlusIcon className="size-3.5" />
                    New routine
                  </InlineButton>
                ) : null}
              </div>
              {rows.length > 0 ? (
                <ul className="flex flex-col">
                  {rows.map((row) => (
                    <RoutineListRow
                      key={row.key}
                      row={row}
                      selected={row.key === selected?.key}
                      onSelect={() => setSelectedKey(row.key)}
                    />
                  ))}
                </ul>
              ) : (
                <p className="ps-3 text-sm text-muted-foreground">
                  {snapshot?.cron.error ?? "No routines yet."}
                </p>
              )}
            </div>
          </ScrollArea>
          {selected !== null ? (
            <div className="hidden min-h-0 flex-1 border-s border-border lg:flex">
              <ScrollArea className="min-h-0 flex-1">
                <div className="px-9 pt-10 pb-16">
                  {selected.source === "hermes" && primaryEnvironmentId !== null ? (
                    <HermesRoutineDetail
                      key={selected.key}
                      environmentId={primaryEnvironmentId}
                      row={selected}
                      threadIds={threadIds}
                    />
                  ) : selected.source === "t3" ? (
                    <ScheduledTaskDetail
                      key={selected.key}
                      row={selected}
                      onEdit={() =>
                        setEditor({ environmentId: selected.environmentId, task: selected.task })
                      }
                    />
                  ) : null}
                </div>
              </ScrollArea>
            </div>
          ) : null}
        </div>
      </div>
      {editor ? (
        <SettingsScopeProvider search={{}} onChange={() => undefined}>
          <ScheduledTaskEditorDialog
            key={`${editor.environmentId}:${editor.task?.id ?? "new"}`}
            initialEnvironmentId={editor.environmentId}
            task={editor.task}
            onClose={() => setEditor(null)}
          />
        </SettingsScopeProvider>
      ) : null}
    </SidebarInset>
  );
}
