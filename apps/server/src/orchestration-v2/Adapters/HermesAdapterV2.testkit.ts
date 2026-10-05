// @effect-diagnostics nodeBuiltinImport:off - the fake gateway is a plain Node socket server the relay process connects to.
/**
 * Fake Hermes `tui_gateway` for adapter tests.
 *
 * The adapter spawns a real process: `pythonPath` points at a tiny relay
 * script that pipes its stdio to a Unix socket owned by the test, where this
 * in-process fake speaks the gateway's newline-delimited JSON-RPC. Tests
 * script replies per method and await the requests the adapter sends.
 */
import * as NodeFS from "node:fs";
import * as NodeNet from "node:net";
import * as NodePath from "node:path";

export interface FakeGatewayRequest {
  readonly id: string;
  readonly method: string;
  readonly params: Record<string, unknown>;
}

export interface FakeGatewayReply {
  readonly id: string;
  readonly result?: Record<string, unknown>;
  readonly error?: { readonly code: number; readonly message: string };
}

export interface FakeGatewayPeer {
  readonly result: (result: Record<string, unknown>) => void;
  readonly error: (code: number, message: string, data?: Record<string, unknown>) => void;
  readonly event: (type: string, sessionId: string, payload?: unknown) => void;
  /** Send a server→client request; resolves with the client's reply. */
  readonly serverRequest: (
    method: string,
    params: Record<string, unknown>,
  ) => Promise<FakeGatewayReply>;
}

export type FakeGatewayHandler = (request: FakeGatewayRequest, peer: FakeGatewayPeer) => void;

export interface FakeHermesGateway {
  readonly socketPath: string;
  readonly relayPath: string;
  readonly hermesHome: string;
  readonly on: (method: string, handler: FakeGatewayHandler) => void;
  /** Resolves with the first not-yet-taken request for `method` (already received or future). */
  readonly nextRequest: (method: string) => Promise<FakeGatewayRequest>;
  readonly requests: () => ReadonlyArray<FakeGatewayRequest>;
  readonly close: () => Promise<void>;
}

export function startFakeHermesGateway(baseDir: string): Promise<FakeHermesGateway> {
  const root = NodeFS.mkdtempSync(NodePath.join(baseDir, "hermes-fake-"));
  const hermesHome = NodePath.join(root, "home");
  NodeFS.mkdirSync(NodePath.join(hermesHome, "hermes-agent", "tui_gateway"), { recursive: true });
  const socketPath = NodePath.join(root, "gw.sock");
  const relayPath = NodePath.join(root, "relay.cjs");
  NodeFS.writeFileSync(
    relayPath,
    [
      `#!${process.execPath}`,
      `const socket = require("node:net").connect(process.env.HERMES_FAKE_SOCKET);`,
      `process.stdin.pipe(socket);`,
      `socket.pipe(process.stdout);`,
      `socket.on("close", () => process.exit(0));`,
      `socket.on("error", () => process.exit(1));`,
      "",
    ].join("\n"),
    { mode: 0o755 },
  );

  const handlers = new Map<string, FakeGatewayHandler>();
  const received: Array<FakeGatewayRequest> = [];
  const taken = new Set<FakeGatewayRequest>();
  const waiters: Array<{ method: string; resolve: (request: FakeGatewayRequest) => void }> = [];
  const sockets = new Set<NodeNet.Socket>();
  let serverRequestId = 0;

  const deliver = (request: FakeGatewayRequest) => {
    const index = waiters.findIndex((waiter) => waiter.method === request.method);
    if (index >= 0) {
      taken.add(request);
      waiters.splice(index, 1)[0]!.resolve(request);
    }
  };

  const server = NodeNet.createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => {});
    const write = (frame: Record<string, unknown>) => {
      if (!socket.destroyed) socket.write(`${JSON.stringify({ jsonrpc: "2.0", ...frame })}\n`);
    };
    const event = (type: string, sessionId: string, payload?: unknown) =>
      write({
        method: "event",
        params: { type, session_id: sessionId, ...(payload === undefined ? {} : { payload }) },
      });
    const pendingServerRequests = new Map<string, (reply: FakeGatewayReply) => void>();
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf("\n");
        if (line.trim() === "") continue;
        const frame = JSON.parse(line) as Record<string, unknown>;
        if (typeof frame.method !== "string") {
          const reply = pendingServerRequests.get(String(frame.id));
          pendingServerRequests.delete(String(frame.id));
          reply?.(frame as unknown as FakeGatewayReply);
          continue;
        }
        const request: FakeGatewayRequest = {
          id: String(frame.id),
          method: frame.method,
          params: (frame.params as Record<string, unknown>) ?? {},
        };
        received.push(request);
        const peer: FakeGatewayPeer = {
          result: (result) => write({ id: request.id, result }),
          error: (code, message, data) =>
            write({ id: request.id, error: { code, message, ...(data ? { data } : {}) } }),
          event,
          serverRequest: (method, params) =>
            new Promise((resolve) => {
              const id = `srq-${++serverRequestId}`;
              pendingServerRequests.set(id, resolve);
              write({ id, method, params });
            }),
        };
        const handler = handlers.get(request.method);
        if (handler === undefined) peer.error(-32601, `unknown method: ${request.method}`);
        else handler(request, peer);
        deliver(request);
      }
    });
    event("gateway.ready", "", { skin: {}, change_events: true, replay_epoch: "test" });
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () =>
      resolve({
        socketPath,
        relayPath,
        hermesHome,
        on: (method, handler) => {
          handlers.set(method, handler);
        },
        nextRequest: (method) => {
          const existing = received.find(
            (request) => request.method === method && !taken.has(request),
          );
          if (existing !== undefined) {
            taken.add(existing);
            return Promise.resolve(existing);
          }
          return new Promise((resolveRequest) => waiters.push({ method, resolve: resolveRequest }));
        },
        requests: () => [...received],
        close: () =>
          new Promise<void>((resolveClose) => {
            for (const socket of sockets) socket.destroy();
            server.close(() => {
              NodeFS.rmSync(root, { recursive: true, force: true });
              resolveClose();
            });
          }),
      }),
    );
  });
}
