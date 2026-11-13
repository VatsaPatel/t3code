import { memo, useState } from "react";

import { Button } from "~/components/ui/button";

import { personalApi, useResource, type PersonalRoutine, type PersonalRoutineAction } from "./api";
import { Markdown, Muted, PersonalPage, relative, until } from "./PersonalPage";

/** "3:00 PM" today, "Sat 9:00 AM" this week, else "Nov 20". Full timestamp lives in the tooltip. */
function shortTime(iso: string): string {
  const date = new Date(iso);
  const days = (date.getTime() - Date.now()) / 86_400_000;
  if (date.toDateString() === new Date().toDateString())
    return date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  if (days < 6)
    return date.toLocaleString(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" });
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function statusWord(routine: PersonalRoutine): string {
  if (!routine.enabled || routine.state === "paused") return "paused";
  if (routine.state === "completed") return "completed";
  if (routine.lastStatus === "error" || routine.lastStatus === "failed" || routine.lastError)
    return "failed";
  return routine.lastStatus ?? routine.state;
}

const failedCount = (routines: ReadonlyArray<PersonalRoutine>) =>
  routines.filter((routine) => statusWord(routine) === "failed").length;

function byNextRun(a: PersonalRoutine, b: PersonalRoutine): number {
  if (!a.nextRunAt) return b.nextRunAt ? 1 : a.name.localeCompare(b.name);
  if (!b.nextRunAt) return -1;
  return a.nextRunAt.localeCompare(b.nextRunAt);
}

export function RoutinesPage() {
  const { data, error, refetch } = useResource(personalApi.routines, 60_000);
  const [expanded, setExpanded] = useState<string | null>(null);
  return (
    <PersonalPage>
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold">Routines</h1>
        {data?.available ? (
          <Muted>
            Hermes cron jobs, soonest first
            {failedCount(data.routines) ? ` · ${failedCount(data.routines)} failed` : ""}
          </Muted>
        ) : null}
      </div>
      {error ? <Muted>{error}</Muted> : null}
      {data && !data.available ? (
        <Muted>Hermes cron unavailable{data.error ? `: ${data.error}` : ""}</Muted>
      ) : null}
      {data?.available ? (
        <ul className="flex flex-col divide-y">
          {data.routines.toSorted(byNextRun).map((routine) => (
            <RoutineRow
              key={routine.id}
              routine={routine}
              expanded={expanded === routine.id}
              onToggle={setExpanded}
              onChanged={refetch}
            />
          ))}
        </ul>
      ) : null}
    </PersonalPage>
  );
}

const RoutineRow = memo(function RoutineRow({
  routine,
  expanded,
  onToggle,
  onChanged,
}: {
  readonly routine: PersonalRoutine;
  readonly expanded: boolean;
  readonly onToggle: (id: string | null) => void;
  readonly onChanged: () => Promise<void>;
}) {
  const status = statusWord(routine);
  return (
    <li className="flex flex-col gap-3 py-3">
      <button
        type="button"
        className="flex w-full items-baseline gap-3 text-left"
        aria-expanded={expanded}
        onClick={() => onToggle(expanded ? null : routine.id)}
      >
        <span className="min-w-0 flex-1 truncate font-medium">{routine.name}</span>
        <span className="hidden w-32 shrink-0 truncate text-xs text-muted-foreground sm:block">
          {routine.schedule}
        </span>
        <span className="w-44 shrink-0 text-right text-xs text-muted-foreground tabular-nums">
          {routine.nextRunAt
            ? `${until(routine.nextRunAt)} · ${shortTime(routine.nextRunAt)}`
            : "not scheduled"}
        </span>
        <span
          className={
            status === "failed"
              ? "w-20 shrink-0 text-right text-xs text-destructive-foreground"
              : "w-20 shrink-0 text-right text-xs text-muted-foreground"
          }
        >
          {/* Healthy is the default; only exceptions earn a word. */}
          {status === "ok" || status === "scheduled" ? "" : status}
        </span>
      </button>
      {expanded ? <RoutineDetail routine={routine} onChanged={onChanged} /> : null}
    </li>
  );
});

function RoutineDetail({
  routine,
  onChanged,
}: {
  readonly routine: PersonalRoutine;
  readonly onChanged: () => Promise<void>;
}) {
  const output = useResource(() => personalApi.routineOutput(routine.id));
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const paused = !routine.enabled || routine.state === "paused";

  const act = async (action: PersonalRoutineAction) => {
    setBusy(true);
    try {
      setMessage((await personalApi.routineAction(routine.id, action)).message);
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : String(cause));
    }
    await onChanged();
    if (action === "run") await output.refetch();
    setBusy(false);
  };

  return (
    <div className="flex flex-col gap-3 ps-1">
      {routine.lastError ? <Muted>Last error: {routine.lastError}</Muted> : null}
      {routine.lastRunAt ? (
        <Muted>
          Last run {relative(routine.lastRunAt)}
          {routine.deliver ? ` · delivers to ${routine.deliver}` : ""}
        </Muted>
      ) : null}
      {output.data?.markdown ? (
        <Markdown text={output.data.markdown} />
      ) : output.loading ? null : (
        <Muted>{output.error ?? "No output yet."}</Muted>
      )}
      <div className="flex gap-2">
        <Button size="compact" variant="outline" disabled={busy} onClick={() => act("run")}>
          Run now
        </Button>
        <Button
          size="compact"
          variant="ghost-muted"
          disabled={busy}
          onClick={() => act(paused ? "resume" : "pause")}
        >
          {paused ? "Resume" : "Pause"}
        </Button>
      </div>
      {message ? <Muted>{message}</Muted> : null}
    </div>
  );
}
