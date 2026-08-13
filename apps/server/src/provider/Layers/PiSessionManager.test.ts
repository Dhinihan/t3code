// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import { connectPiRpc, type PiRpcConnection } from "./PiRpcConnection.ts";
import * as McpProviderSession from "../../mcp/McpProviderSession.ts";
import {
  makePiSessionManager,
  piSessionIdForThread,
  type PiRpcConnector,
} from "./PiSessionManager.ts";

const run = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.provide(NodeServices.layer), Effect.scoped);

const PEER_PATH = NodePath.join(import.meta.dirname, "../testFixtures/piRpcMockPeer.mjs");
let peerScriptCounter = 0;

const makeState = (input: {
  readonly sessionId: string;
  readonly sessionFile: string;
  readonly messageCount?: number;
}) => ({
  sessionId: input.sessionId,
  sessionFile: input.sessionFile,
  messageCount: input.messageCount ?? 0,
});

const makeFakeConnector = (input: {
  readonly states: ReadonlyArray<Record<string, unknown>>;
  readonly calls?: Array<Parameters<PiRpcConnector>[0]>;
}) => {
  const states = [...input.states];
  const calls = input.calls ?? [];
  const connections: Array<{
    readonly connection: PiRpcConnection;
    readonly exit: Deferred.Deferred<ChildProcessSpawner.ExitCode, never>;
    readonly closeCalls: number[];
  }> = [];

  const connect: PiRpcConnector = (options) =>
    Effect.gen(function* () {
      calls.push(options);
      const exit = yield* Deferred.make<ChildProcessSpawner.ExitCode, never>();
      const closeCalls: number[] = [];
      let closed = false;
      const close = Effect.gen(function* () {
        if (closed) return;
        closed = true;
        closeCalls.push(1);
        yield* Deferred.succeed(exit, ChildProcessSpawner.ExitCode(0));
      });
      const connection: PiRpcConnection = {
        pid: connections.length + 1,
        events: Stream.empty,
        request: (_command, id) =>
          Effect.succeed({
            id,
            type: "response",
            command: "get_state",
            success: true,
            data: states.shift() ?? states.at(-1),
          }),
        send: () => Effect.void,
        stderr: Effect.succeed(""),
        close,
        exitCode: Deferred.await(exit),
      };
      const runtimeScope = yield* Scope.Scope;
      yield* Scope.addFinalizer(runtimeScope, close);
      connections.push({ connection, exit, closeCalls });
      return connection;
    });

  return { connect, calls, connections };
};

it.effect("derives a stable Pi session id accepted by the Pi CLI", () =>
  Effect.sync(() => {
    const first = piSessionIdForThread(ThreadId.make("thread/with spaces"));
    const second = piSessionIdForThread(ThreadId.make("thread/with spaces"));
    assert.equal(first, second);
    assert.match(first, /^t3-[A-Za-z0-9]+$/);
  }),
);

it.effect("handshakes once and reuses the active process for a thread", () =>
  run(
    Effect.gen(function* () {
      const threadId = ThreadId.make("thread-1");
      const sessionDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "pi-session-manager-"));
      const sessionFile = NodePath.join(sessionDir, "session.jsonl");
      const calls: Array<Parameters<PiRpcConnector>[0]> = [];
      const fake = makeFakeConnector({
        calls,
        states: [makeState({ sessionId: piSessionIdForThread(threadId), sessionFile })],
      });
      const manager = yield* makePiSessionManager({
        binaryPath: "pi",
        cwd: "/repo",
        sessionDir,
        piVersion: "0.84.1",
        connect: fake.connect,
      });

      const first = yield* manager.start({ threadId });
      const second = yield* manager.start({ threadId });
      const cursor = yield* first.getResumeCursor();

      assert.strictEqual(first, second);
      assert.equal(fake.calls.length, 1);
      assert.deepEqual(cursor, {
        schemaVersion: 1,
        threadId,
        sessionId: piSessionIdForThread(threadId),
        sessionDir: NodePath.resolve(sessionDir),
        sessionFile: NodePath.resolve(sessionFile),
        cwd: "/repo",
        piVersion: "0.84.1",
        messageCount: 0,
      });
      assert.deepEqual(fake.calls[0]?.args, [
        "--approve",
        "--mode",
        "rpc",
        "--session-dir",
        NodePath.resolve(sessionDir),
        "--session-id",
        piSessionIdForThread(threadId),
      ]);
      yield* manager.stop(threadId);
      assert.equal(fake.connections[0]?.closeCalls.length, 1);
    }),
  ),
);

it.effect("gives only the main Pi process an ephemeral T3 MCP extension", () =>
  run(
    Effect.gen(function* () {
      const threadId = ThreadId.make("thread-mcp");
      const sessionDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "pi-session-mcp-"));
      const config = {
        environmentId: EnvironmentId.make("environment-pi"),
        threadId,
        providerSessionId: "provider-session-mcp",
        providerInstanceId: ProviderInstanceId.make("pi"),
        endpoint: "http://127.0.0.1:43123/mcp",
        authorizationHeader: "Bearer main-pi-only-secret",
      };
      const revoked: string[] = [];
      McpProviderSession.setMcpProviderSession(config);
      const fake = makeFakeConnector({
        states: [
          makeState({
            sessionId: piSessionIdForThread(threadId),
            sessionFile: NodePath.join(sessionDir, "session.jsonl"),
          }),
        ],
      });

      try {
        const manager = yield* makePiSessionManager({
          binaryPath: "pi",
          cwd: "/repo",
          sessionDir,
          piVersion: "0.84.1",
          args: ["--extension", "/home/user/.pi/agent/extensions/personal.ts"],
          connect: fake.connect,
          revokeMcpProviderSession: (providerSessionId) =>
            Effect.sync(() => {
              revoked.push(providerSessionId);
            }),
        });
        yield* manager.start({ threadId });

        const call = fake.calls[0];
        assert.isDefined(call);
        if (!call) return;
        const args = call.args;
        assert.isDefined(args);
        if (!args) return;
        const extensionIndex = args.lastIndexOf("--extension");
        assert.isAtLeast(extensionIndex, 0);
        const extensionPath = args[extensionIndex + 1];
        assert.isString(extensionPath);
        if (typeof extensionPath !== "string") return;
        assert.notInclude(args, config.authorizationHeader);
        assert.notEqual(call.environment?.T3_MCP_BEARER_TOKEN, "main-pi-only-secret");
        assert.include(NodeFS.readFileSync(extensionPath, "utf8"), config.authorizationHeader);
        assert.include(args, "/home/user/.pi/agent/extensions/personal.ts");
        assert.notEqual(NodePath.dirname(extensionPath), NodePath.resolve("/repo"));
        assert.notEqual(NodePath.dirname(extensionPath), NodePath.resolve(sessionDir));
        assert.equal(NodeFS.existsSync(extensionPath), true);

        yield* manager.stop(threadId);
        assert.equal(NodeFS.existsSync(extensionPath), false);
        assert.deepEqual(revoked, [config.providerSessionId]);
        assert.equal(McpProviderSession.readMcpProviderSession(threadId), undefined);
      } finally {
        McpProviderSession.clearAllMcpProviderSessions();
        NodeFS.rmSync(sessionDir, { recursive: true, force: true });
      }
    }),
  ),
);

it.effect("revokes and removes the Pi MCP lease after an unexpected process exit", () =>
  run(
    Effect.gen(function* () {
      const threadId = ThreadId.make("thread-mcp-crash");
      const sessionDir = NodeFS.mkdtempSync(
        NodePath.join(NodeOS.tmpdir(), "pi-session-mcp-crash-"),
      );
      const config = {
        environmentId: EnvironmentId.make("environment-pi"),
        threadId,
        providerSessionId: "provider-session-mcp-crash",
        providerInstanceId: ProviderInstanceId.make("pi"),
        endpoint: "http://127.0.0.1:43123/mcp",
        authorizationHeader: "Bearer crash-only-secret",
      };
      const revoked: string[] = [];
      const cleanupStarted = yield* Deferred.make<void, never>();
      McpProviderSession.setMcpProviderSession(config);
      const fake = makeFakeConnector({
        states: [
          makeState({
            sessionId: piSessionIdForThread(threadId),
            sessionFile: NodePath.join(sessionDir, "session.jsonl"),
          }),
        ],
      });

      try {
        const manager = yield* makePiSessionManager({
          binaryPath: "pi",
          cwd: "/repo",
          sessionDir,
          piVersion: "0.84.1",
          connect: fake.connect,
          revokeMcpProviderSession: (providerSessionId) =>
            Effect.gen(function* () {
              revoked.push(providerSessionId);
              yield* Deferred.succeed(cleanupStarted, undefined);
            }),
        });
        yield* manager.start({ threadId });
        const call = fake.calls[0];
        assert.isDefined(call);
        if (!call) return;
        const args = call.args;
        assert.isDefined(args);
        if (!args) return;
        const extensionIndex = args.lastIndexOf("--extension");
        const extensionPath = extensionIndex < 0 ? undefined : args[extensionIndex + 1];
        assert.isString(extensionPath);
        if (typeof extensionPath !== "string") return;

        const connection = fake.connections[0];
        assert.isDefined(connection);
        if (!connection) return;
        yield* Deferred.succeed(connection.exit, ChildProcessSpawner.ExitCode(9));
        yield* Deferred.await(cleanupStarted);

        assert.equal(yield* manager.has(threadId), false);
        assert.equal(NodeFS.existsSync(extensionPath), false);
        assert.deepEqual(revoked, [config.providerSessionId]);
        assert.equal(McpProviderSession.readMcpProviderSession(threadId), undefined);
      } finally {
        McpProviderSession.clearAllMcpProviderSessions();
        NodeFS.rmSync(sessionDir, { recursive: true, force: true });
      }
    }),
  ),
);

it.effect("closes the child scope when the Pi handshake is incompatible", () =>
  run(
    Effect.gen(function* () {
      const threadId = ThreadId.make("thread-incompatible");
      const sessionDir = NodeFS.mkdtempSync(
        NodePath.join(NodeOS.tmpdir(), "pi-session-incompatible-"),
      );
      const fake = makeFakeConnector({
        states: [
          makeState({
            sessionId: piSessionIdForThread(threadId),
            sessionFile: NodePath.join(sessionDir, "session.jsonl"),
          }),
        ],
      });
      const manager = yield* makePiSessionManager({
        binaryPath: "pi",
        cwd: "/repo",
        sessionDir,
        piVersion: "0.84.0",
        connect: fake.connect,
      });

      const result = yield* manager.start({ threadId }).pipe(Effect.exit);

      assert.equal(result._tag, "Failure");
      assert.equal(fake.connections.length, 1);
      assert.equal(fake.connections[0]?.closeCalls.length, 1);
      if (result._tag === "Failure") {
        assert.include(String(result.cause), "incompatible");
      }
    }),
  ),
);

it.effect("resumes the same persisted session after the manager is rebuilt", () =>
  run(
    Effect.gen(function* () {
      const threadId = ThreadId.make("thread-resume");
      const sessionDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "pi-session-resume-"));
      const sessionFile = NodePath.join(sessionDir, "session.jsonl");
      NodeFS.writeFileSync(sessionFile, '{"type":"session"}\n', "utf8");
      const sessionId = piSessionIdForThread(threadId);

      const firstFake = makeFakeConnector({
        states: [makeState({ sessionId, sessionFile, messageCount: 1 })],
      });
      const firstManager = yield* makePiSessionManager({
        binaryPath: "pi",
        cwd: "/repo",
        sessionDir,
        piVersion: "0.84.1",
        connect: firstFake.connect,
      });
      const first = yield* firstManager.start({ threadId });
      const cursor = yield* first.getResumeCursor();
      yield* firstManager.stop(threadId);

      const secondFake = makeFakeConnector({
        states: [makeState({ sessionId, sessionFile, messageCount: 1 })],
      });
      const secondManager = yield* makePiSessionManager({
        binaryPath: "pi",
        cwd: "/repo",
        sessionDir,
        piVersion: "0.84.1",
        connect: secondFake.connect,
      });
      const resumed = yield* secondManager.start({ threadId, resumeCursor: cursor });

      assert.equal(resumed.sessionId, sessionId);
      assert.equal(secondFake.calls.length, 1);
      yield* secondManager.stop(threadId);
    }),
  ),
);

it.effect("refuses a resume cursor whose persisted history disappeared", () =>
  run(
    Effect.gen(function* () {
      const threadId = ThreadId.make("thread-missing-session");
      const sessionDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "pi-session-missing-"));
      const sessionFile = NodePath.join(sessionDir, "deleted-session.jsonl");
      const sessionId = piSessionIdForThread(threadId);
      const fake = makeFakeConnector({
        states: [makeState({ sessionId, sessionFile, messageCount: 1 })],
      });
      const manager = yield* makePiSessionManager({
        binaryPath: "pi",
        cwd: "/repo",
        sessionDir,
        piVersion: "0.84.1",
        connect: fake.connect,
      });
      const cursor = {
        schemaVersion: 1,
        threadId,
        sessionId,
        sessionDir: NodePath.resolve(sessionDir),
        sessionFile: NodePath.resolve(sessionFile),
        cwd: "/repo",
        piVersion: "0.84.1",
        messageCount: 1,
      } as const;

      const result = yield* manager.start({ threadId, resumeCursor: cursor }).pipe(Effect.exit);
      assert.equal(result._tag, "Failure");
      assert.equal(fake.calls.length, 0);
      if (result._tag === "Failure") {
        assert.include(String(result.cause), "cannot be resumed");
      }
    }),
  ),
);

it.effect("drops a crashed process from the active thread map", () =>
  run(
    Effect.gen(function* () {
      const threadId = ThreadId.make("thread-crash");
      const sessionDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "pi-session-crash-"));
      const fake = makeFakeConnector({
        states: [
          makeState({
            sessionId: piSessionIdForThread(threadId),
            sessionFile: NodePath.join(sessionDir, "session.jsonl"),
          }),
        ],
      });
      const manager = yield* makePiSessionManager({
        binaryPath: "pi",
        cwd: "/repo",
        sessionDir,
        piVersion: "0.84.1",
        connect: fake.connect,
      });
      yield* manager.start({ threadId });
      assert.equal(yield* manager.has(threadId), true);

      yield* Deferred.succeed(fake.connections[0]!.exit, ChildProcessSpawner.ExitCode(9));
      yield* Effect.yieldNow;
      yield* Effect.yieldNow;

      assert.equal(yield* manager.has(threadId), false);
    }),
  ),
);

it.live("reuses the lifecycle seam against the real hermetic Pi peer", () =>
  run(
    Effect.gen(function* () {
      const threadId = ThreadId.make("thread-peer");
      const sessionDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "pi-session-peer-"));
      const sessionFile = NodePath.join(sessionDir, "peer-session.jsonl");
      const sessionId = piSessionIdForThread(threadId);
      peerScriptCounter += 1;
      const scriptPath = NodePath.join(
        NodeOS.tmpdir(),
        `pi-session-peer-script-${process.pid}-${peerScriptCounter}.json`,
      );
      NodeFS.writeFileSync(
        scriptPath,
        // @effect-diagnostics-next-line preferSchemaOverJson:off
        JSON.stringify({ sessionId, sessionFile, messageCount: 0 }),
        "utf8",
      );

      const manager = yield* makePiSessionManager({
        binaryPath: process.execPath,
        cwd: process.cwd(),
        sessionDir,
        piVersion: "0.84.1",
        args: [PEER_PATH],
        environment: {
          ...process.env,
          PI_RPC_PEER_SCRIPT: scriptPath,
        },
        connect: connectPiRpc,
      });
      const first = yield* manager.start({ threadId });
      const settledFiber = yield* first.events.pipe(
        Stream.filter((event) => event.type === "agent_settled"),
        Stream.take(1),
        Stream.runCollect,
        Effect.forkScoped,
      );
      const response = yield* first.request({ type: "prompt", message: "hello" }, "prompt-1");
      const settled = yield* Fiber.join(settledFiber);
      const second = yield* manager.start({ threadId });

      assert.equal(response.success, true);
      assert.equal(settled.length, 1);
      assert.strictEqual(first, second);
      yield* manager.stop(threadId);
      NodeFS.rmSync(scriptPath, { force: true });
      NodeFS.rmSync(sessionDir, { recursive: true, force: true });
    }),
  ),
);
