import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/unstable/http/HttpClient";
import type * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import * as UrlParams from "effect/unstable/http/UrlParams";

import { makeTodoistSource, PersonalTaskSourceError } from "./TaskSource.ts";

const TOKEN = "todoist-SECRET-token-0123456789";
const toJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const fromJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));

interface Recorded {
  readonly method: string;
  readonly url: string;
  readonly query: string;
  readonly body: unknown;
  readonly authorization: string | undefined;
}

function bodyOf(request: HttpClientRequest.HttpClientRequest): unknown {
  if (request.body._tag !== "Uint8Array") return undefined;
  return fromJson(new TextDecoder().decode(request.body.body));
}

/** A fake Todoist API that records requests and answers from `respond`. */
const fakeTodoist = (
  respond: (request: Recorded) => { readonly status: number; readonly body?: unknown },
) =>
  Effect.gen(function* () {
    const requests = yield* Ref.make<ReadonlyArray<Recorded>>([]);
    const tokenInvalidations = yield* Ref.make(0);
    const http = HttpClient.make((request) =>
      Effect.gen(function* () {
        const recorded: Recorded = {
          method: request.method,
          url: request.url,
          query: UrlParams.toString(request.urlParams),
          body: bodyOf(request),
          authorization: request.headers.authorization,
        };
        yield* Ref.update(requests, (all) => [...all, recorded]);
        const answer = respond(recorded);
        return HttpClientResponse.fromWeb(
          request,
          new Response(
            answer.body === undefined
              ? null
              : typeof answer.body === "string"
                ? answer.body
                : toJson(answer.body),
            { status: answer.status },
          ),
        );
      }),
    );
    const source = makeTodoistSource({
      http,
      token: Effect.succeed(TOKEN),
      invalidateToken: Ref.update(tokenInvalidations, (count) => count + 1),
    });
    return { source, requests, tokenInvalidations };
  });

it.effect("quick add sends the natural-language text to Todoist's quick-add parser", () =>
  Effect.gen(function* () {
    const { source, requests } = yield* fakeTodoist((request) =>
      request.url.endsWith("/projects")
        ? { status: 200, body: { results: [{ id: "p1", name: "Personal" }] } }
        : {
            status: 200,
            body: {
              id: "t1",
              content: "call dentist",
              project_id: "p1",
              priority: 1,
              due: { date: "2026-10-06T09:00:00", string: "tomorrow 9am", is_recurring: false },
            },
          },
    );

    const task = yield* source.quickAdd("call dentist tomorrow 9am #Personal");

    const add = (yield* Ref.get(requests)).find((request) => request.url.endsWith("/tasks/quick"));
    assert.equal(add?.method, "POST");
    // The whole phrase goes to Todoist unparsed: it owns dates, projects and labels.
    assert.deepEqual(add?.body, { text: "call dentist tomorrow 9am #Personal" });
    assert.equal(add?.authorization, `Bearer ${TOKEN}`);
    assert.equal(task.projectName, "Personal");
    assert.deepEqual(task.due, {
      date: "2026-10-06",
      datetime: "2026-10-06T09:00:00",
      label: "tomorrow 9am",
      isRecurring: false,
    });
  }),
);

it.effect("complete closes and reopen reopens the same task", () =>
  Effect.gen(function* () {
    const { source, requests } = yield* fakeTodoist(() => ({ status: 204 }));

    yield* source.complete("t 1");
    yield* source.reopen("t 1");
    yield* source.reschedule("t 1", "next monday");

    assert.deepEqual(
      (yield* Ref.get(requests)).map((request) => [request.method, request.url, request.body]),
      [
        ["POST", "https://api.todoist.com/api/v1/tasks/t%201/close", undefined],
        ["POST", "https://api.todoist.com/api/v1/tasks/t%201/reopen", undefined],
        ["POST", "https://api.todoist.com/api/v1/tasks/t%201", { due_string: "next monday" }],
      ],
    );
  }),
);

it.effect("lists overdue and upcoming open tasks across pages", () =>
  Effect.gen(function* () {
    const { source, requests } = yield* fakeTodoist((request) => {
      if (request.url.endsWith("/projects")) return { status: 200, body: { results: [] } };
      return request.query.includes("cursor=")
        ? { status: 200, body: { results: [{ id: "b", content: "second" }], next_cursor: null } }
        : {
            status: 200,
            body: {
              results: [
                { id: "a", content: "first", due: { date: "2026-10-04" } },
                { id: "done", content: "already done", checked: true },
              ],
              next_cursor: "page-2",
            },
          };
    });

    const tasks = yield* source.listUpcoming;

    assert.deepEqual(
      tasks.map((task) => task.id),
      ["a", "b"],
    );
    const firstPage = (yield* Ref.get(requests)).find((request) =>
      request.url.endsWith("/tasks/filter"),
    );
    assert.include(decodeURIComponent(firstPage?.query ?? "").replaceAll("+", " "), "overdue");
  }),
);

it.effect("never echoes the token in errors, and drops it when Todoist rejects it", () =>
  Effect.gen(function* () {
    const { source, tokenInvalidations } = yield* fakeTodoist((request) =>
      request.url.includes("/close")
        ? { status: 401, body: `invalid token ${TOKEN}` }
        : { status: 500, body: `upstream said: Bearer ${TOKEN} is broken` },
    );

    const serverError = yield* Effect.flip(source.reopen("t1"));
    const authError = yield* Effect.flip(source.complete("t1"));

    for (const error of [serverError, authError]) {
      assert.instanceOf(error, PersonalTaskSourceError);
      assert.notInclude(error.message, TOKEN);
      assert.notInclude(toJson(error), TOKEN);
    }
    assert.equal(serverError.status, 500);
    assert.equal(authError.status, 401);
    assert.equal(yield* Ref.get(tokenInvalidations), 1);
  }),
);
