import { memo, useState, type FormEvent } from "react";

import { Button } from "~/components/ui/button";
import { Checkbox } from "~/components/ui/checkbox";
import { Input } from "~/components/ui/input";
import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";

import {
  personalApi,
  useResource,
  type PersonalTodo,
  type PersonalWaitingItem,
  type PersonalWaitingResult,
} from "./api";
import {
  CollapsedMarkdown,
  Markdown,
  Muted,
  PersonalPage,
  Section,
  relative,
} from "./PersonalPage";

const SOURCE_LABEL = { hermes: "Hermes", codex: "Codex", claude: "Claude Code" } as const;

export function HomePage() {
  const [today] = useState(() =>
    new Date().toLocaleDateString(undefined, {
      weekday: "long",
      month: "long",
      day: "numeric",
    }),
  );
  return (
    <PersonalPage>
      <h1 className="text-2xl font-semibold">{today}</h1>
      <WaitingSection />
      <TodaySection />
      <DigestSection />
      <BriefSection />
    </PersonalPage>
  );
}

function WaitingSection() {
  const { data, error, refetch } = useResource(personalApi.waiting, 60_000);
  const [showDismissed, setShowDismissed] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const setDismissed = async (key: string, dismissed: boolean) => {
    try {
      await personalApi.dismiss(key, dismissed);
      setActionError(null);
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : String(cause));
    }
    await refetch();
  };

  if (!data)
    return error ? (
      <Section title="Waiting on you">
        <Muted>{error}</Muted>
      </Section>
    ) : null;
  const active = data.items.filter((item) => !item.dismissed);
  const dismissed = data.items.filter((item) => item.dismissed);
  const notes = waitingNotes(data);
  if (active.length === 0 && dismissed.length === 0 && notes.length === 0 && !error) return null;

  return (
    <Section
      title="Waiting on you"
      count={active.length}
      aside={
        dismissed.length > 0 ? (
          <Button size="compact" variant="ghost-muted" onClick={() => setShowDismissed((v) => !v)}>
            {showDismissed ? "Hide dismissed" : `Show dismissed (${dismissed.length})`}
          </Button>
        ) : null
      }
    >
      {active.length === 0 ? <Muted>Nothing is waiting on you.</Muted> : null}
      <ul className="flex flex-col gap-5">
        {active.map((item) => (
          <WaitingRow key={item.key} item={item} onDismiss={setDismissed} />
        ))}
        {showDismissed
          ? dismissed.map((item) => (
              <WaitingRow key={item.key} item={item} onDismiss={setDismissed} />
            ))
          : null}
      </ul>
      {[error, actionError, ...notes].filter(Boolean).map((note) => (
        <Muted key={note}>{note}</Muted>
      ))}
    </Section>
  );
}

function waitingNotes(data: PersonalWaitingResult): string[] {
  const notes = data.sources
    .filter((source) => !source.available)
    .map(
      (source) =>
        `${SOURCE_LABEL[source.kind]} history unavailable${source.detail ? `: ${source.detail}` : ""}`,
    );
  if (!data.curatorAvailable) notes.push("Curation off: set OPENROUTER_API_KEY");
  return notes;
}

const WaitingRow = memo(function WaitingRow({
  item,
  onDismiss,
}: {
  readonly item: PersonalWaitingItem;
  readonly onDismiss: (key: string, dismissed: boolean) => void;
}) {
  const { copyToClipboard, isCopied } = useCopyToClipboard();
  const preview =
    item.lastAgentText.length > 160 ? `${item.lastAgentText.slice(0, 160)}…` : item.lastAgentText;
  // Origin may already name the agent ("Claude Code", "Codex CLI"); avoid saying it twice.
  const agent = SOURCE_LABEL[item.source];
  const where = item.origin.startsWith(agent.split(" ")[0]!)
    ? item.origin
    : `${agent} · ${item.origin}`;
  return (
    <li
      className={`group relative flex flex-col gap-0.5 ps-4 ${item.stale || item.dismissed ? "opacity-70" : ""}`}
    >
      {item.dismissed ? null : (
        <span
          aria-hidden
          className={`absolute start-0 top-2 size-1.5 rounded-full ${item.stale ? "bg-muted-foreground/50" : "bg-warning"}`}
        />
      )}
      <div className="flex items-baseline gap-2">
        <span className="min-w-0 truncate font-medium">{item.title}</span>
        <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
          {where} · {relative(item.lastAgentAt)}
          {item.stale ? " · stale" : ""}
        </span>
      </div>
      <p className="text-sm">
        {item.ask ?? (
          <>
            <span className="text-muted-foreground">{preview}</span>{" "}
            <span className="text-xs text-muted-foreground">checking…</span>
          </>
        )}
      </p>
      <div className="-ms-2 flex gap-1 opacity-60 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
        <Button
          size="compact"
          variant="ghost-muted"
          onClick={() => copyToClipboard(item.resumeCommand, undefined)}
        >
          {isCopied ? "Copied" : "Copy resume command"}
        </Button>
        <Button
          size="compact"
          variant="ghost-muted"
          onClick={() => onDismiss(item.key, !item.dismissed)}
        >
          {item.dismissed ? "Restore" : "Dismiss"}
        </Button>
      </div>
    </li>
  );
});

type TodoGroup = "Overdue" | "Today" | "Next 3 days";

function groupTodo(todo: PersonalTodo, now: Date): TodoGroup | null {
  if (!todo.due) return null;
  const due = new Date(todo.due.replace(" ", "T"));
  if (Number.isNaN(due.getTime())) return null;
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const dayMs = 86_400_000;
  if (due < now) return "Overdue";
  if (due.getTime() < startOfToday.getTime() + dayMs) return "Today";
  if (due.getTime() < startOfToday.getTime() + 4 * dayMs) return "Next 3 days";
  return null;
}

function groupTodos(todos: ReadonlyArray<PersonalTodo>) {
  const now = new Date();
  const groups = new Map<TodoGroup, PersonalTodo[]>();
  let someday = 0;
  for (const todo of todos) {
    const group = groupTodo(todo, now);
    if (!group) {
      someday += 1;
      continue;
    }
    groups.set(group, [...(groups.get(group) ?? []), todo]);
  }
  for (const list of groups.values())
    list.sort((a, b) => (a.due ?? "").localeCompare(b.due ?? "") || a.priority - b.priority);
  return { groups, someday };
}

function TodaySection() {
  const { data, error, refetch } = useResource(personalApi.todos);
  const [actionError, setActionError] = useState<string | null>(null);
  const [completing, setCompleting] = useState<ReadonlySet<string>>(new Set());

  const run = async (action: () => Promise<unknown>) => {
    try {
      await action();
      setActionError(null);
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : String(cause));
    }
    await refetch();
  };

  const complete = async (id: string) => {
    setCompleting((prev) => new Set(prev).add(id));
    await run(() => personalApi.completeTodo(id));
    setCompleting((prev) => {
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
  };

  const { groups, someday } = groupTodos(data?.todos ?? []);
  const notes = [
    error,
    actionError,
    data && !data.available ? (data.error ?? "To-dos unavailable") : null,
  ];

  return (
    <Section title="To-dos">
      {(["Overdue", "Today", "Next 3 days"] as const).map((group) => {
        const todos = groups.get(group);
        if (!todos) return null;
        return (
          <div key={group} className="flex flex-col gap-2">
            <h3 className="text-xs text-muted-foreground">{group}</h3>
            <ul className="flex flex-col gap-2">
              {todos.map((todo) => (
                <TodoRow
                  key={todo.id}
                  todo={todo}
                  pending={completing.has(todo.id)}
                  onComplete={complete}
                />
              ))}
            </ul>
          </div>
        );
      })}
      {data?.available && groups.size === 0 ? (
        <Muted>Nothing due in the next few days.</Muted>
      ) : null}
      {someday > 0 ? <Muted>{someday} without a near due date</Muted> : null}
      {notes.filter(Boolean).map((note) => (
        <Muted key={note}>{note}</Muted>
      ))}
      <AddTodo onAdd={(text, due) => run(() => personalApi.addTodo(text, due))} />
    </Section>
  );
}

const TodoRow = memo(function TodoRow({
  todo,
  pending,
  onComplete,
}: {
  readonly todo: PersonalTodo;
  readonly pending: boolean;
  readonly onComplete: (id: string) => void;
}) {
  return (
    <li className="flex items-center gap-3 text-sm">
      <Checkbox
        checked={pending}
        disabled={pending}
        onCheckedChange={() => onComplete(todo.id)}
        aria-label={`Complete ${todo.text}`}
      />
      <span className="min-w-0 flex-1">{todo.text}</span>
      <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
        {todo.priority === 1 ? "P1 · " : ""}
        {todo.due?.split(" ")[1] ?? ""}
      </span>
    </li>
  );
});

function AddTodo({ onAdd }: { readonly onAdd: (text: string, due?: string) => Promise<void> }) {
  const [text, setText] = useState("");
  const [due, setDue] = useState("");
  const [saving, setSaving] = useState(false);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!text.trim()) return;
    setSaving(true);
    // datetime-local yields "YYYY-MM-DDTHH:MM"; the API wants a space.
    await onAdd(text.trim(), due ? due.replace("T", " ") : undefined);
    setSaving(false);
    setText("");
    setDue("");
  };
  return (
    <form className="flex items-center gap-2" onSubmit={submit}>
      <Input
        placeholder="Add to-do"
        value={text}
        onChange={(event) => setText(event.target.value)}
        disabled={saving}
      />
      <Input
        type="datetime-local"
        aria-label="Due"
        value={due}
        onChange={(event) => setDue(event.target.value)}
        disabled={saving}
      />
      <Button type="submit" variant="outline" disabled={saving || !text.trim()}>
        Add
      </Button>
    </form>
  );
}

function DigestSection() {
  const { data, error, refetch } = useResource(personalApi.digest);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const refresh = async () => {
    setRefreshing(true);
    try {
      await personalApi.refreshDigest();
      setRefreshError(null);
    } catch (cause) {
      setRefreshError(cause instanceof Error ? cause.message : String(cause));
    }
    await refetch();
    setRefreshing(false);
  };
  if (!data)
    return error ? (
      <Section title="Agent digest">
        <Muted>{error}</Muted>
      </Section>
    ) : null;
  const generating = refreshing || data.generating;
  const digest = data.digest;
  if (!digest && !data.curatorAvailable && !data.error) return null;
  return (
    <Section
      title="Agent digest"
      aside={
        data.curatorAvailable ? (
          <Button size="compact" variant="ghost-muted" disabled={generating} onClick={refresh}>
            {generating ? "Generating…" : "Refresh"}
          </Button>
        ) : null
      }
    >
      {digest ? (
        <>
          <Muted>
            Generated {relative(digest.generatedAt)} from {digest.sessionCount} sessions ·{" "}
            {digest.model}
          </Muted>
          <Markdown text={digest.markdown} />
        </>
      ) : generating ? null : (
        <Muted>No digest yet.</Muted>
      )}
      {[data.error, refreshError, error].filter(Boolean).map((note) => (
        <Muted key={note}>{note}</Muted>
      ))}
    </Section>
  );
}

function BriefSection() {
  const { data } = useResource(personalApi.brief);
  if (!data) return null;
  return (
    <Section title="Morning brief">
      <Muted>
        {data.jobName} · {relative(data.ranAt)}
      </Muted>
      <CollapsedMarkdown text={data.markdown} />
    </Section>
  );
}
