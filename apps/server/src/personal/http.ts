import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  type PersonalRoutineAction,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerConfig from "../config.ts";
import { PersonalService } from "./PersonalService.ts";

const PERSONAL_ROUTE_PREFIX = "/api/personal";

const json = (body: unknown, status = 200) => HttpServerResponse.jsonUnsafe(body, { status });

type Body = Record<string, unknown>;
const str = (body: Body, key: string) => (typeof body[key] === "string" ? body[key] : undefined);

/** Thin transport: authenticate, decode, call one service method. */
const handle = async (
  service: PersonalService,
  method: string,
  path: string,
  query: URLSearchParams,
  body: Body,
): Promise<unknown> => {
  switch (`${method} ${path}`) {
    case "GET /waiting":
      return service.waiting();
    case "POST /waiting/dismiss": {
      const key = str(body, "key");
      if (!key) throw new Error("key is required");
      service.setDismissed(key, body.dismissed !== false);
      return { ok: true };
    }
    case "GET /digest":
      return service.digest();
    case "POST /digest/refresh":
      await service.refreshDigest();
      return service.digest();
    case "GET /todos":
      return service.todos();
    case "POST /todos/done":
      await service.todoDone(str(body, "id") ?? "");
      return { ok: true };
    case "POST /todos/add":
      return { ok: true, id: await service.todoAdd(str(body, "text") ?? "", str(body, "due")) };
    case "GET /brief":
      return service.brief();
    case "GET /routines":
      return service.routines();
    case "GET /routines/output":
      return service.routineOutput(query.get("id") ?? "");
    case "POST /routines/action": {
      const action = str(body, "action");
      if (action !== "run" && action !== "pause" && action !== "resume")
        throw new Error("action must be run, pause or resume");
      return {
        ok: true,
        message: await service.routineAction(
          str(body, "id") ?? "",
          action as PersonalRoutineAction,
        ),
      };
    }
    default:
      return undefined;
  }
};

export const layer = Layer.unwrap(
  Effect.gen(function* () {
    const auth = yield* EnvironmentAuth.EnvironmentAuth;
    const config = yield* ServerConfig.ServerConfig;
    const service = new PersonalService(config.stateDir);
    yield* Effect.acquireRelease(
      Effect.sync(() => service.start()),
      () => Effect.sync(() => service.stop()),
    );
    return HttpRouter.add(
      "*",
      `${PERSONAL_ROUTE_PREFIX}/*`,
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const session = yield* auth.authenticateHttpRequest(request).pipe(Effect.result);
        if (session._tag === "Failure") return json({ error: "Unauthorized" }, 401);
        const needed =
          request.method === "GET" ? AuthOrchestrationReadScope : AuthOrchestrationOperateScope;
        if (!session.success.scopes.includes(needed)) return json({ error: "Forbidden" }, 403);
        const url = new URL(request.url, "http://local");
        const path = url.pathname.slice(PERSONAL_ROUTE_PREFIX.length);
        const body =
          request.method === "POST"
            ? yield* request.json.pipe(
                Effect.map((value) => (value && typeof value === "object" ? (value as Body) : {})),
                Effect.orElseSucceed((): Body => ({})),
              )
            : {};
        const result = yield* Effect.tryPromise({
          try: () => handle(service, request.method, path, url.searchParams, body),
          catch: (cause) => (cause instanceof Error ? cause.message : String(cause)),
        }).pipe(Effect.result);
        if (result._tag === "Failure") return json({ error: result.failure }, 500);
        if (result.success === undefined) return json({ error: "Not found" }, 404);
        return json(result.success);
      }),
    );
  }),
);
