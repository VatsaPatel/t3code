/**
 * HermesGateway — one Hermes Agent `tui_gateway` process per T3 provider
 * instance, speaking newline-delimited JSON-RPC 2.0 over stdio.
 *
 * The gateway multiplexes many Hermes runtime sessions (the Hermes desktop app
 * runs every chat through one backend the same way), so T3 threads share the
 * instance's process. Frames are routed by the runtime `session_id` they
 * carry: an adapter session binds its runtime id to a queue, and the reader
 * binds the id returned by `session.create`/`resume`/`branch_stored` before it
 * reads the next line, so no event can arrive for an id nobody owns yet.
 *
 * Server→client requests other than `approval` and `clarify`, and requests for
 * an unbound session, are answered `-32601` immediately: Hermes then withdraws
 * them instead of parking the agent until its own timeout.
 *
 * The process is started lazily, restarted on the next use after a crash, and
 * shut down after a period with no bound sessions or in-flight requests.
 * Runtime session ids do not survive a restart; bound sessions receive a
 * `lost` frame and re-resume their stored session on next use.
 */
import * as NodeOS from "node:os";

import type { HermesSettings } from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import type * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import type * as Path from "effect/Path";
import * as Predicate from "effect/Predicate";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { signalProcessGroup } from "../../process/processGroup.ts";
import { HermesRpcErrorBody, HermesEventFrameParams } from "./HermesProtocol.ts";

export class HermesGatewayError extends Schema.TaggedError<HermesGatewayError>()(
  "HermesGatewayError",
  {
    operation: Schema.String,
    detail: Schema.optional(Schema.String),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Hermes gateway ${this.operation} failed${this.detail === undefined ? "" : `: ${this.detail}`}.`;
  }
}

export class HermesRpcError extends Schema.TaggedError<HermesRpcError>()("HermesRpcError", {
  method: Schema.String,
  code: Schema.Number,
  detail: Schema.String,
  /** `error.data.reason` (for example `SESSION_NOT_OWNED` on 4090). */
  reason: Schema.optional(Schema.String),
}) {
  override get message(): string {
    return `Hermes ${this.method} failed (${this.code}): ${this.detail}`;
  }
}

export type HermesGatewayRequestError = HermesGatewayError | HermesRpcError;

/** Frames routed to one adapter session. `lost` means its runtime id is gone. */
export type HermesInbound =
  | {
      readonly kind: "event";
      readonly type: string;
      readonly sessionId: string;
      readonly payload: unknown;
    }
  | {
      readonly kind: "request";
      readonly id: string;
      readonly method: string;
      readonly sessionId: string;
      readonly params: Record<string, unknown>;
    }
  | { readonly kind: "lost"; readonly sessionId: string; readonly detail: string };

export type HermesSessionSink = Queue.Queue<HermesInbound>;

/** Server requests T3 answers; everything else is declined so Hermes does not wait. */
const ROUTED_SERVER_REQUESTS: ReadonlySet<string> = new Set(["approval", "clarify"]);

export interface HermesLaunch {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  /** Root Hermes home (`~/.hermes`): owns the agent checkout and named profiles. */
  readonly hermesHome: string;
  /** `HERMES_HOME` the gateway runs with: the root home or `profiles/<name>`. */
  readonly profileHome: string;
  readonly agentRoot: string;
}

function expandHome(path: Path.Path, value: string, home: string): string {
  if (value === "~") return home;
  if (value.startsWith("~/")) return path.join(home, value.slice(2));
  return value;
}

/**
 * Resolve how to start the gateway for an instance. The interpreter defaults
 * to the agent checkout's stable `venv/bin/python`; Hermes' own bootstrap
 * re-execs it into the managed interpreter of the current dependency
 * generation, exactly as the `hermes` launcher does, so update-specific paths
 * are never hardcoded here.
 */
export function resolveHermesLaunch(
  path: Path.Path,
  settings: Pick<HermesSettings, "hermesHome" | "profile" | "pythonPath">,
  environment: NodeJS.ProcessEnv,
): HermesLaunch {
  const userHome = environment.HOME || NodeOS.homedir();
  const hermesHome = path.resolve(
    expandHome(path, settings.hermesHome || path.join(userHome, ".hermes"), userHome),
  );
  const profile = settings.profile.trim();
  const profileHome =
    profile === "" || profile === "default"
      ? hermesHome
      : path.join(hermesHome, "profiles", profile);
  const agentRoot = path.join(hermesHome, "hermes-agent");
  const command = settings.pythonPath
    ? expandHome(path, settings.pythonPath, userHome)
    : path.join(agentRoot, "venv", "bin", "python");
  const env: NodeJS.ProcessEnv = { ...environment };
  delete env.PYTHONHOME;
  env.PYTHONPATH = agentRoot;
  env.HERMES_PYTHON_SRC_ROOT = agentRoot;
  env.HERMES_HOME = profileHome;
  env.PYTHONUNBUFFERED = "1";
  // Tool start/complete events for every tool, independent of the user's
  // display.tool_progress setting (which only the TUI renders).
  env.HERMES_TUI_TOOL_PROGRESS = "all";
  return {
    command,
    args: ["-m", "tui_gateway.entry"],
    cwd: agentRoot,
    env,
    hermesHome,
    profileHome,
    agentRoot,
  };
}

export interface HermesGatewayConnection {
  /** Increments per spawned process; runtime ids are only valid for one generation. */
  readonly generation: number;
  readonly request: (
    method: string,
    params: Record<string, unknown>,
    options?: {
      readonly timeoutMs?: number;
      /** Route the result's `session_id` to this sink before any later frame is read. */
      readonly bindSessionTo?: HermesSessionSink;
    },
  ) => Effect.Effect<unknown, HermesGatewayRequestError>;
  /** Answer a server→client request (`srq-…` id). */
  readonly respond: (
    id: string,
    body:
      | { readonly result: Record<string, unknown> }
      | { readonly error: { readonly code: number; readonly message: string } },
  ) => Effect.Effect<void, HermesGatewayError>;
  readonly bind: (sessionId: string, sink: HermesSessionSink) => void;
  readonly unbind: (sessionId: string, sink: HermesSessionSink) => void;
  readonly isAlive: () => boolean;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 120_000;
const READY_TIMEOUT_MS = 90_000;
const SHUTDOWN_GRACE = Duration.seconds(3);
const TERMINATION_GRACE = Duration.seconds(1);
const MAX_FRAME_CHARS = 64 * 1024 * 1024;

const decodeJsonLine = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));
const encodeJsonLine = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeEventParams = Schema.decodeUnknownOption(HermesEventFrameParams);
const decodeRpcError = Schema.decodeUnknownOption(HermesRpcErrorBody);

function makeLineFramer() {
  let buffer = "";
  let dropping = false;
  return (chunk: string): ReadonlyArray<string> => {
    const lines: Array<string> = [];
    let start = 0;
    while (start < chunk.length) {
      const newline = chunk.indexOf("\n", start);
      const end = newline < 0 ? chunk.length : newline;
      if (!dropping) {
        if (buffer.length + end - start > MAX_FRAME_CHARS) {
          buffer = "";
          dropping = true;
        } else {
          buffer += chunk.slice(start, end);
        }
      }
      if (newline < 0) break;
      if (!dropping && buffer.length > 0) {
        lines.push(buffer.endsWith("\r") ? buffer.slice(0, -1) : buffer);
      }
      buffer = "";
      dropping = false;
      start = newline + 1;
    }
    return lines;
  };
}

interface PendingRequest {
  readonly method: string;
  readonly deferred: Deferred.Deferred<unknown, HermesGatewayRequestError>;
  readonly bindSessionTo: HermesSessionSink | undefined;
}

/**
 * Spawn one gateway process in the current scope and wait for `gateway.ready`.
 * Closing the scope ends stdin (Hermes flushes sessions on EOF), then
 * terminates the process group if it has not exited.
 */
export const makeHermesGatewayConnection = Effect.fnUntraced(function* (input: {
  readonly launch: HermesLaunch;
  readonly generation: number;
  readonly onClosed?: () => void;
}) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const platform = yield* HostProcessPlatform;
  const scope = yield* Effect.scope;
  const { launch } = input;

  const child = yield* spawner
    .spawn(
      ChildProcess.make(launch.command, [...launch.args], {
        cwd: launch.cwd,
        env: launch.env,
        extendEnv: false,
        detached: platform !== "win32",
      }),
    )
    .pipe(Effect.mapError((cause) => new HermesGatewayError({ operation: "spawn", cause })));

  let exited = false;
  const killGroup = (signal: NodeJS.Signals | 0): boolean => {
    try {
      if (platform === "win32") process.kill(Number(child.pid), signal);
      else signalProcessGroup(Number(child.pid), signal);
      return true;
    } catch {
      return false;
    }
  };
  const hasExited = () => exited || !killGroup(0);
  const exitDeferred = yield* Deferred.make<number>();
  const outgoing = yield* Queue.unbounded<Uint8Array, HermesGatewayError | Cause.Done>();
  const down = yield* Deferred.make<never, HermesGatewayError>();
  const ready = yield* Deferred.make<void, HermesGatewayError>();
  const pending = new Map<string, PendingRequest>();
  const sessions = new Map<string, HermesSessionSink>();
  let nextId = 0;
  let alive = true;

  const terminate = Effect.gen(function* () {
    alive = false;
    // EOF first: the gateway flushes live transcripts and releases leases.
    yield* Queue.end(outgoing).pipe(Effect.ignore);
    // Interruptible so the timeout can abandon the wait inside a finalizer.
    yield* Effect.interruptible(
      Deferred.await(exitDeferred).pipe(Effect.timeoutOption(SHUTDOWN_GRACE)),
    );
    if (!hasExited() && killGroup("SIGTERM")) {
      yield* Effect.sleep(TERMINATION_GRACE);
      if (!hasExited()) killGroup("SIGKILL");
    }
    // Settle anything still waiting on this process.
    yield* fail(new HermesGatewayError({ operation: "close", detail: "gateway stopped" }));
  });
  // Backstop for an interruption before the graceful finalizer below exists.
  yield* Scope.addFinalizer(
    scope,
    Effect.sync(() => {
      if (!hasExited()) killGroup("SIGKILL");
    }),
  );

  const fail = (error: HermesGatewayError) =>
    Effect.gen(function* () {
      if (!(yield* Deferred.fail(down, error))) return;
      alive = false;
      yield* Deferred.fail(ready, error);
      for (const [id, request] of pending) {
        pending.delete(id);
        yield* Deferred.fail(request.deferred, error);
      }
      const bound = Array.from(sessions.entries());
      sessions.clear();
      for (const [sessionId, sink] of bound) {
        yield* Queue.offer(sink, { kind: "lost", sessionId, detail: error.message });
      }
      yield* Queue.fail(outgoing, error).pipe(Effect.ignore);
      input.onClosed?.();
    });

  const write = (frame: Record<string, unknown>): Effect.Effect<void, HermesGatewayError> =>
    Effect.gen(function* () {
      const accepted = yield* Queue.offer(
        outgoing,
        new TextEncoder().encode(`${encodeJsonLine(frame)}\n`),
      );
      if (!accepted) {
        return yield* new HermesGatewayError({ operation: "write", detail: "gateway stopped" });
      }
    });

  const declineRequest = (id: string, method: string) =>
    write({
      jsonrpc: "2.0",
      id,
      error: { code: -32601, message: `T3 Code does not handle ${method} requests` },
    }).pipe(Effect.ignore);

  const routeFrame = (frame: Record<string, unknown>) =>
    Effect.gen(function* () {
      const id = frame["id"];
      const method = frame["method"];
      if (method === "event") {
        const params = decodeEventParams(frame["params"]);
        if (Option.isNone(params)) return;
        const { type, session_id: sessionId, payload } = params.value;
        if (type === "gateway.ready") {
          yield* Deferred.succeed(ready, undefined);
          return;
        }
        if (!sessionId) return;
        const sink = sessions.get(sessionId);
        if (sink !== undefined)
          yield* Queue.offer(sink, { kind: "event", type, sessionId, payload });
        return;
      }
      if (typeof id === "string" && typeof method === "string") {
        const params = Predicate.isObject(frame["params"])
          ? (frame["params"] as Record<string, unknown>)
          : {};
        const sessionId = typeof params["session_id"] === "string" ? params["session_id"] : "";
        const sink = sessions.get(sessionId);
        if (sink === undefined || !ROUTED_SERVER_REQUESTS.has(method)) {
          yield* declineRequest(id, method);
          return;
        }
        yield* Queue.offer(sink, { kind: "request", id, method, sessionId, params });
        return;
      }
      if (typeof id !== "string") return;
      const request = pending.get(id);
      if (request === undefined) return;
      pending.delete(id);
      if ("error" in frame) {
        const body = decodeRpcError(frame["error"]);
        const reason = Option.isSome(body)
          ? (body.value.data as { readonly reason?: unknown } | undefined)?.reason
          : undefined;
        yield* Deferred.fail(
          request.deferred,
          new HermesRpcError({
            method: request.method,
            code: Option.isSome(body) ? body.value.code : -32000,
            detail: Option.isSome(body) ? body.value.message.slice(0, 2_000) : "unknown error",
            ...(typeof reason === "string" ? { reason } : {}),
          }),
        );
        return;
      }
      const result = frame["result"];
      const boundId =
        request.bindSessionTo !== undefined && Predicate.isObject(result)
          ? (result as Record<string, unknown>)["session_id"]
          : undefined;
      if (typeof boundId === "string" && request.bindSessionTo !== undefined) {
        sessions.set(boundId, request.bindSessionTo);
      }
      yield* Deferred.succeed(request.deferred, result);
    });

  yield* child.exitCode.pipe(
    Effect.exit,
    Effect.flatMap((exit) =>
      Effect.suspend(() => {
        exited = true;
        return Deferred.succeed(exitDeferred, Exit.isSuccess(exit) ? Number(exit.value) : -1);
      }),
    ),
    Effect.forkIn(scope),
  );

  yield* Effect.gen(function* () {
    const frame = makeLineFramer();
    yield* child.stdout.pipe(
      Stream.decodeText(),
      Stream.runForEach((chunk) =>
        Effect.forEach(
          frame(chunk),
          (line) => {
            const parsed = decodeJsonLine(line);
            if (Option.isNone(parsed) || !Predicate.isObject(parsed.value)) {
              return Effect.logDebug("Dropping non-JSON Hermes gateway stdout line.", {
                lineLength: line.length,
              });
            }
            return routeFrame(parsed.value as Record<string, unknown>);
          },
          { discard: true },
        ),
      ),
    );
  }).pipe(
    Effect.matchCauseEffect({
      onFailure: (cause) => fail(new HermesGatewayError({ operation: "read", cause })),
      onSuccess: () =>
        Effect.gen(function* () {
          const code = yield* Deferred.await(exitDeferred).pipe(
            Effect.timeoutOption(Duration.millis(500)),
          );
          yield* fail(
            new HermesGatewayError({
              operation: "read",
              detail: Option.isSome(code)
                ? `gateway exited with code ${code.value}`
                : "gateway closed stdout",
            }),
          );
        }),
    }),
    Effect.forkIn(scope),
  );

  // stderr is free-form progress text and can carry prompt content: length only.
  yield* child.stderr.pipe(
    Stream.decodeText(),
    Stream.runForEach((chunk) =>
      chunk.trim().length === 0
        ? Effect.void
        : Effect.logDebug("hermes gateway stderr", { stderrLength: chunk.length }),
    ),
    Effect.ignore,
    Effect.forkIn(scope),
  );

  yield* Stream.fromQueue(outgoing).pipe(
    Stream.run(child.stdin),
    Effect.catchCause((cause) => fail(new HermesGatewayError({ operation: "write", cause }))),
    Effect.forkIn(scope),
  );

  // Registered after the reader, writer, and exit watcher so it runs before
  // they are interrupted: stdin EOF must reach the process and its exit be seen.
  yield* Scope.addFinalizer(scope, terminate.pipe(Effect.ignore, Effect.uninterruptible));

  const request: HermesGatewayConnection["request"] = (method, params, options) =>
    Effect.gen(function* () {
      const id = `t3-${++nextId}`;
      const deferred = yield* Deferred.make<unknown, HermesGatewayRequestError>();
      pending.set(id, { method, deferred, bindSessionTo: options?.bindSessionTo });
      yield* write({ jsonrpc: "2.0", id, method, params }).pipe(
        Effect.tapError(() => Effect.sync(() => pending.delete(id))),
      );
      const timeoutMs = options?.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
      return yield* Effect.raceFirst(Deferred.await(deferred), Deferred.await(down)).pipe(
        Effect.timeoutOrElse({
          duration: Duration.millis(timeoutMs),
          orElse: () =>
            Effect.fail(
              new HermesGatewayError({
                operation: method,
                detail: `timed out after ${timeoutMs}ms`,
              }),
            ),
        }),
        // Waiting is always safe to abandon; this keeps the race usable from
        // finalizers (session.close on scope release), which are uninterruptible.
        Effect.interruptible,
        Effect.ensuring(Effect.sync(() => pending.delete(id))),
      );
    });

  const connection: HermesGatewayConnection = {
    generation: input.generation,
    request,
    respond: (id, body) => write({ jsonrpc: "2.0", id, ...body }),
    bind: (sessionId, sink) => {
      sessions.set(sessionId, sink);
    },
    unbind: (sessionId, sink) => {
      if (sessions.get(sessionId) === sink) sessions.delete(sessionId);
    },
    isAlive: () => alive,
  };

  yield* Effect.raceFirst(Deferred.await(ready), Deferred.await(down)).pipe(
    Effect.timeoutOrElse({
      duration: Duration.millis(READY_TIMEOUT_MS),
      orElse: () =>
        Effect.fail(
          new HermesGatewayError({
            operation: "start",
            detail: `no gateway.ready within ${READY_TIMEOUT_MS / 1000}s`,
          }),
        ),
    }),
  );
  // Only stdio clients that advertise it are guaranteed server requests.
  yield* request("client.capabilities", { server_requests: true }, { timeoutMs: 15_000 }).pipe(
    Effect.ignore,
  );
  return {
    connection,
    boundSessionCount: () => sessions.size,
    inFlightRequestCount: () => pending.size,
  };
});

export interface HermesGateway {
  readonly launch: HermesLaunch;
  /** The live connection, spawning the gateway and awaiting readiness when needed. */
  readonly connection: Effect.Effect<HermesGatewayConnection, HermesGatewayError>;
  /** Re-arm idle shutdown after a session unbinds or a one-off request finishes. */
  readonly touch: Effect.Effect<void>;
}

const DEFAULT_IDLE_SHUTDOWN_MS = 5 * 60 * 1_000;

/**
 * Instance-owned gateway lifecycle. The returned value is safe to share
 * between the adapter and the provider probe of one instance.
 */
export const makeHermesGateway = Effect.fnUntraced(function* (input: {
  readonly launch: HermesLaunch;
  readonly spawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly idleShutdownMs?: number;
}) {
  const ownerScope = yield* Effect.scope;
  const platform = yield* HostProcessPlatform;
  const lock = yield* Semaphore.make(1);
  const idleShutdownMs = input.idleShutdownMs ?? DEFAULT_IDLE_SHUTDOWN_MS;
  let generation = 0;
  let current: {
    readonly connection: HermesGatewayConnection;
    readonly scope: Scope.Closeable;
    readonly boundSessionCount: () => number;
    readonly inFlightRequestCount: () => number;
  } | null = null;
  let idleFiber: Fiber.Fiber<void> | null = null;

  const closeCurrent = Effect.gen(function* () {
    const live = current;
    current = null;
    if (live !== null) yield* Scope.close(live.scope, Exit.void);
  });

  const scheduleIdleShutdown: Effect.Effect<void> = Effect.gen(function* () {
    if (idleFiber !== null) {
      const previous = idleFiber;
      idleFiber = null;
      yield* Fiber.interrupt(previous);
    }
    if (current === null) return;
    const scheduledFor = current;
    idleFiber = yield* Effect.sleep(Duration.millis(idleShutdownMs)).pipe(
      Effect.andThen(
        lock.withPermits(1)(
          Effect.suspend(() =>
            current === scheduledFor &&
            scheduledFor.boundSessionCount() === 0 &&
            scheduledFor.inFlightRequestCount() === 0
              ? closeCurrent
              : Effect.void,
          ),
        ),
      ),
      Effect.forkIn(ownerScope),
    );
  });

  const connection: HermesGateway["connection"] = lock
    .withPermits(1)(
      Effect.gen(function* () {
        if (current !== null && current.connection.isAlive()) return current.connection;
        yield* closeCurrent;
        const scope = yield* Scope.fork(ownerScope);
        generation += 1;
        const started = yield* makeHermesGatewayConnection({
          launch: input.launch,
          generation,
        }).pipe(
          Scope.provide(scope),
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, input.spawner),
          Effect.provideService(HostProcessPlatform, platform),
          Effect.tapCause(() => Scope.close(scope, Exit.void)),
        );
        current = { ...started, scope };
        return started.connection;
      }),
    )
    .pipe(Effect.tap(() => scheduleIdleShutdown));

  yield* Scope.addFinalizer(
    ownerScope,
    Effect.suspend(() => (idleFiber === null ? Effect.void : Fiber.interrupt(idleFiber))).pipe(
      Effect.andThen(closeCurrent),
    ),
  );

  return {
    launch: input.launch,
    connection,
    touch: scheduleIdleShutdown,
  } satisfies HermesGateway;
});
