import type { PersonalTodayTask, PersonalTodayTaskSourceKind } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";

/** A task as its source reports it, before delegation links are joined in. */
export type SourceTask = Omit<PersonalTodayTask, "delegation">;

export class PersonalTaskSourceError extends Schema.TaggedError<PersonalTaskSourceError>()(
  "PersonalTaskSourceError",
  {
    source: Schema.String,
    operation: Schema.String,
    /** HTTP status when the source answered; absent for network or auth setup failures. */
    status: Schema.optional(Schema.Number),
    /** Already redacted: never contains a credential. */
    detail: Schema.String,
  },
) {
  override get message(): string {
    return this.status === undefined
      ? `${this.source} ${this.operation} failed: ${this.detail}`
      : `${this.source} ${this.operation} failed (HTTP ${this.status}): ${this.detail}`;
  }
}

/**
 * Where to-dos live. Todoist is the only implementation; another store plugs
 * in by implementing this interface, and the Today service stays unchanged.
 */
export interface PersonalTaskSource {
  readonly kind: PersonalTodayTaskSourceKind;
  /** Open tasks that are overdue or due within the next week. */
  readonly listUpcoming: Effect.Effect<ReadonlyArray<SourceTask>, PersonalTaskSourceError>;
  /** An open task, or null when it was completed or deleted. */
  readonly get: (taskId: string) => Effect.Effect<SourceTask | null, PersonalTaskSourceError>;
  /** Adds a task from natural language, such as "call dentist tomorrow 9am #Personal". */
  readonly quickAdd: (text: string) => Effect.Effect<SourceTask, PersonalTaskSourceError>;
  readonly complete: (taskId: string) => Effect.Effect<void, PersonalTaskSourceError>;
  readonly reopen: (taskId: string) => Effect.Effect<void, PersonalTaskSourceError>;
  readonly reschedule: (
    taskId: string,
    dueString: string,
  ) => Effect.Effect<void, PersonalTaskSourceError>;
}

const TODOIST_API = "https://api.todoist.com/api/v1/";
const MAX_LIST_PAGES = 5;
const PROJECT_CACHE_MS = 10 * 60_000;
const decodeJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));

interface TodoistTaskJson {
  readonly id?: unknown;
  readonly checked?: unknown;
  readonly is_deleted?: unknown;
  readonly content?: unknown;
  readonly description?: unknown;
  readonly project_id?: unknown;
  readonly priority?: unknown;
  readonly labels?: unknown;
  readonly due?: {
    readonly date?: unknown;
    readonly datetime?: unknown;
    readonly string?: unknown;
    readonly is_recurring?: unknown;
  } | null;
}

function redact(text: string, secret: string | null): string {
  return secret === null || secret.length === 0 ? text : text.split(secret).join("[redacted]");
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : typeof value === "number" ? String(value) : null;
}

/** Todoist reports a timed due date as `date: "YYYY-MM-DDTHH:MM:SS"` in v1. */
function mapDue(due: TodoistTaskJson["due"]): SourceTask["due"] {
  if (due === null || due === undefined) return null;
  const rawDate = asString(due.date);
  if (rawDate === null) return null;
  const datetime = asString(due.datetime) ?? (rawDate.length > 10 ? rawDate : null);
  return {
    date: rawDate.slice(0, 10),
    datetime,
    label: asString(due.string),
    isRecurring: due.is_recurring === true,
  };
}

export function makeTodoistSource(options: {
  readonly http: HttpClient.HttpClient;
  /** Resolves the API token; never logged or echoed in errors. */
  readonly token: Effect.Effect<string, PersonalTaskSourceError>;
  /** Drops a cached token after the API rejects it. */
  readonly invalidateToken: Effect.Effect<void>;
}): PersonalTaskSource {
  let projectNames: { readonly at: number; readonly names: ReadonlyMap<string, string> } | null =
    null;

  const call = (
    operation: string,
    path: string,
    init?: {
      readonly method?: "GET" | "POST";
      readonly body?: unknown;
      readonly query?: Readonly<Record<string, string>>;
    },
  ): Effect.Effect<unknown, PersonalTaskSourceError> =>
    Effect.gen(function* () {
      const token = yield* options.token;
      const base =
        init?.method === "POST"
          ? HttpClientRequest.post(`${TODOIST_API}${path}`)
          : HttpClientRequest.get(`${TODOIST_API}${path}`);
      const request = base.pipe(
        HttpClientRequest.setHeader("authorization", `Bearer ${token}`),
        HttpClientRequest.setUrlParams(init?.query ?? {}),
        init?.body === undefined
          ? (request: HttpClientRequest.HttpClientRequest) => request
          : HttpClientRequest.bodyJsonUnsafe(init.body),
      );
      const failure = (detail: string, status?: number) =>
        new PersonalTaskSourceError({
          source: "Todoist",
          operation,
          ...(status === undefined ? {} : { status }),
          detail: redact(detail, token),
        });
      const response = yield* options.http.execute(request).pipe(
        Effect.timeout("15 seconds"),
        Effect.mapError((cause) =>
          failure(cause._tag === "TimeoutError" ? "the request timed out" : "network error"),
        ),
      );
      if (response.status === 401 || response.status === 403) {
        yield* options.invalidateToken;
        return yield* failure("the API token was rejected", response.status);
      }
      const text = yield* response.text.pipe(
        Effect.mapError(() => failure("could not read the response", response.status)),
      );
      if (response.status < 200 || response.status >= 300) {
        return yield* failure(text.slice(0, 200) || "request failed", response.status);
      }
      if (text.length === 0) return null;
      return yield* decodeJson(text).pipe(
        Effect.mapError(() => failure("the response was not JSON", response.status)),
      );
    });

  const loadProjectNames = Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    if (projectNames !== null && now - projectNames.at < PROJECT_CACHE_MS) {
      return projectNames.names;
    }
    const body = (yield* call("list projects", "projects", { query: { limit: "200" } })) as {
      readonly results?: ReadonlyArray<{ readonly id?: unknown; readonly name?: unknown }>;
    } | null;
    const names = new Map<string, string>();
    for (const project of body?.results ?? []) {
      const id = asString(project.id);
      const name = asString(project.name);
      if (id !== null && name !== null) names.set(id, name);
    }
    projectNames = { at: now, names };
    return names;
  });

  const mapTask = (raw: TodoistTaskJson, names: ReadonlyMap<string, string>): SourceTask | null => {
    const id = asString(raw.id);
    if (id === null || id.length === 0) return null;
    const projectId = asString(raw.project_id);
    return {
      id,
      source: "todoist",
      content: asString(raw.content) ?? "",
      description: asString(raw.description) ?? "",
      url: `https://app.todoist.com/app/task/${encodeURIComponent(id)}`,
      projectName: projectId === null ? null : (names.get(projectId) ?? null),
      priority: typeof raw.priority === "number" ? raw.priority : 1,
      due: mapDue(raw.due),
      labels: Array.isArray(raw.labels)
        ? raw.labels.filter((label): label is string => typeof label === "string")
        : [],
    };
  };

  // Project names are decoration; a failure there must not hide the tasks.
  const projectNamesOrEmpty = loadProjectNames.pipe(
    Effect.orElseSucceed((): ReadonlyMap<string, string> => new Map()),
  );

  const listUpcoming: PersonalTaskSource["listUpcoming"] = Effect.gen(function* () {
    const tasks: SourceTask[] = [];
    const names = yield* projectNamesOrEmpty;
    let cursor: string | null = null;
    for (let page = 0; page < MAX_LIST_PAGES; page += 1) {
      const body = (yield* call("list tasks", "tasks/filter", {
        query: {
          query: "overdue | next 7 days",
          limit: "200",
          ...(cursor === null ? {} : { cursor }),
        },
      })) as {
        readonly results?: ReadonlyArray<TodoistTaskJson>;
        readonly next_cursor?: unknown;
      } | null;
      for (const raw of body?.results ?? []) {
        if (raw.checked === true) continue;
        const task = mapTask(raw, names);
        if (task !== null) tasks.push(task);
      }
      cursor = asString(body?.next_cursor);
      if (cursor === null) break;
    }
    return tasks;
  });

  const get: PersonalTaskSource["get"] = (taskId) =>
    Effect.gen(function* () {
      const names = yield* projectNamesOrEmpty;
      const body = yield* call("read task", `tasks/${encodeURIComponent(taskId)}`).pipe(
        Effect.catchIf(
          (error) => error.status === 404,
          () => Effect.succeed(null),
        ),
      );
      const raw = (body ?? {}) as TodoistTaskJson;
      if (raw.checked === true || raw.is_deleted === true) return null;
      return mapTask(raw, names);
    });

  const quickAdd: PersonalTaskSource["quickAdd"] = (text) =>
    Effect.gen(function* () {
      const body = yield* call("add task", "tasks/quick", { method: "POST", body: { text } });
      const names = yield* projectNamesOrEmpty;
      const task = mapTask((body ?? {}) as TodoistTaskJson, names);
      if (task === null) {
        return yield* new PersonalTaskSourceError({
          source: "Todoist",
          operation: "add task",
          detail: "the response had no task",
        });
      }
      return task;
    });

  return {
    kind: "todoist",
    listUpcoming,
    get,
    quickAdd,
    complete: (taskId) =>
      call("complete task", `tasks/${encodeURIComponent(taskId)}/close`, {
        method: "POST",
      }).pipe(Effect.asVoid),
    reopen: (taskId) =>
      call("reopen task", `tasks/${encodeURIComponent(taskId)}/reopen`, {
        method: "POST",
      }).pipe(Effect.asVoid),
    reschedule: (taskId, dueString) =>
      call("reschedule task", `tasks/${encodeURIComponent(taskId)}`, {
        method: "POST",
        body: { due_string: dueString },
      }).pipe(Effect.asVoid),
  };
}
