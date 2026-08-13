// @effect-diagnostics nodeBuiltinImport:off
/**
 * Per-thread lifecycle for the Pi RPC process.
 *
 * A Pi session is durable state identified by a deterministic session id. The
 * RPC process is only a leased execution resource: it is created on demand,
 * reused while active, and owned by a child Scope that can be closed by the
 * reaper or by the provider instance. The adapter sees this module's small
 * interface and never has to own process cleanup itself.
 */
import * as NodePath from "node:path";

import { ThreadId } from "@t3tools/contracts";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import * as FileSystem from "effect/FileSystem";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";

import * as McpProviderSession from "../../mcp/McpProviderSession.ts";
import * as PiCompatibility from "./PiCompatibility.ts";
import { makePiMcpSessionLease, type PiMcpSessionLease } from "./PiMcpSession.ts";
import { connectPiRpc, type PiRpcConnection } from "./PiRpcConnection.ts";
import { decodeGetStateResponse, type PiRpcGetStateResponse } from "./PiRpcContract.ts";
import * as PiRpcErrors from "./PiRpcErrors.ts";
import { PiSessionLifecycleError } from "./PiSessionErrors.ts";

export const PI_RESUME_CURSOR_SCHEMA_VERSION = 1 as const;

const PiResumeCursor = Schema.Struct({
  schemaVersion: Schema.Literal(PI_RESUME_CURSOR_SCHEMA_VERSION),
  threadId: Schema.String,
  sessionId: Schema.String,
  sessionDir: Schema.String,
  sessionFile: Schema.optional(Schema.String),
  cwd: Schema.String,
  piVersion: Schema.String,
  messageCount: Schema.optional(Schema.Number),
});

export type PiResumeCursor = typeof PiResumeCursor.Type;

const decodePiResumeCursor = Schema.decodeUnknownOption(PiResumeCursor);

/**
 * Encode a T3 thread id into the restricted identifier alphabet accepted by
 * Pi. Hex keeps the mapping deterministic and collision-free without exposing
 * arbitrary thread-id punctuation to the Pi CLI.
 */
export function piSessionIdForThread(threadId: string): string {
  const bytes = new TextEncoder().encode(threadId);
  const encoded = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `t3-${encoded}`;
}

export type PiRpcConnector = typeof connectPiRpc;

export interface PiSessionManagerOptions {
  readonly binaryPath: string;
  readonly cwd: string;
  readonly sessionDir: string;
  /** Version read by the provider probe before this manager is created. */
  readonly piVersion: string;
  /** Extra CLI flags such as `--extension`; session flags are appended here. */
  readonly args?: ReadonlyArray<string>;
  readonly environment?: NodeJS.ProcessEnv;
  readonly connect?: PiRpcConnector;
  /** Injectable for lifecycle tests; production revokes through the active registry. */
  readonly revokeMcpProviderSession?: (providerSessionId: string) => Effect.Effect<void>;
}

export interface PiSessionStartInput {
  readonly threadId: ThreadId;
  readonly cwd?: string;
  readonly resumeCursor?: unknown;
}

export interface PiSession {
  readonly threadId: ThreadId;
  readonly sessionId: string;
  readonly cwd: string;
  readonly sessionDir: string;
  readonly request: PiRpcConnection["request"];
  readonly send: PiRpcConnection["send"];
  readonly events: PiRpcConnection["events"];
  readonly stderr: PiRpcConnection["stderr"];
  /** Read the latest durable cursor without starting another process. */
  readonly getResumeCursor: () => Effect.Effect<PiResumeCursor>;
  /** Revalidate get_state and refresh the cursor after a completed turn. */
  readonly refresh: () => Effect.Effect<PiResumeCursor, PiSessionManagerError>;
  /** Stop this thread's process and release its child scope. */
  readonly close: Effect.Effect<void>;
}

export interface PiSessionManager {
  readonly start: (input: PiSessionStartInput) => Effect.Effect<PiSession, PiSessionManagerError>;
  readonly get: (threadId: ThreadId) => Effect.Effect<Option.Option<PiSession>>;
  readonly has: (threadId: ThreadId) => Effect.Effect<boolean>;
  readonly list: () => Effect.Effect<ReadonlyArray<PiSession>>;
  readonly stop: (threadId: ThreadId) => Effect.Effect<void>;
  readonly stopAll: () => Effect.Effect<void>;
}

export type PiSessionManagerError = PiRpcErrors.PiRpcError | PiSessionLifecycleError;

interface PiSessionContext {
  readonly threadId: ThreadId;
  readonly sessionScope: Scope.Closeable;
  readonly connection: PiRpcConnection;
  readonly cursor: Ref.Ref<PiResumeCursor>;
  readonly closed: Ref.Ref<boolean>;
  readonly mcpProviderSessionId: string | undefined;
  readonly mcpLease: PiMcpSessionLease | undefined;
  readonly handle: PiSession;
}

function lifecycleError(input: {
  readonly operation: string;
  readonly threadId: ThreadId;
  readonly detail: string;
  readonly cause?: unknown;
}): PiSessionLifecycleError {
  return new PiSessionLifecycleError({
    operation: input.operation,
    threadId: input.threadId,
    detail: input.detail,
    ...(input.cause === undefined ? {} : { cause: input.cause }),
  });
}

function normalizedPath(path: string): string {
  return NodePath.resolve(path);
}

function isWithinDirectory(directory: string, path: string): boolean {
  const normalizedDirectory = normalizedPath(directory);
  const normalizedFile = normalizedPath(path);
  return (
    normalizedFile === normalizedDirectory ||
    normalizedFile.startsWith(`${normalizedDirectory}${NodePath.sep}`)
  );
}

function stateSessionFile(state: PiRpcGetStateResponse): string | undefined {
  const value = state.data.sessionFile;
  return typeof value === "string" && value.trim().length > 0
    ? normalizedPath(value.trim())
    : undefined;
}

function stateMessageCount(state: PiRpcGetStateResponse): number | undefined {
  const value = state.data.messageCount;
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

const makePiSessionManager = Effect.fn("makePiSessionManager")(function* (
  options: PiSessionManagerOptions,
): Effect.fn.Return<
  PiSessionManager,
  PiSessionManagerError,
  FileSystem.FileSystem | ChildProcessSpawner.ChildProcessSpawner | Scope.Scope
> {
  const fileSystem = yield* FileSystem.FileSystem;
  const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const managerScope = yield* Scope.Scope;
  const sessionDir = normalizedPath(options.sessionDir);
  const defaultCwd = normalizedPath(options.cwd);
  const connector = options.connect ?? connectPiRpc;
  const lifecycleLock = yield* Semaphore.make(1);
  const requestCounter = yield* Ref.make(0);
  const sessions = new Map<ThreadId, PiSessionContext>();
  const ownedSessions = new Set<PiSessionContext>();

  const nextRequestId = Effect.fn("PiSessionManager.nextRequestId")(function* (
    threadId: ThreadId,
    command: string,
  ) {
    const sequence = yield* Ref.getAndUpdate(requestCounter, (current) => current + 1);
    return `pi-session-${threadId}-${command}-${sequence}`;
  });

  const readState = Effect.fn("PiSessionManager.readState")(function* (
    threadId: ThreadId,
    connection: PiRpcConnection,
    expectedSessionId: string,
  ): Effect.fn.Return<PiRpcGetStateResponse, PiSessionManagerError> {
    const requestId = yield* nextRequestId(threadId, "get_state");
    const response = yield* connection.request({ type: "get_state" }, requestId);
    const decoded = decodeGetStateResponse(response);
    if (Option.isNone(decoded)) {
      return yield* new PiRpcErrors.PiRpcCompatibilityError({
        operation: "get_state",
        piVersion: options.piVersion,
        missingRequirement: "data.sessionId",
      });
    }

    const compatibility = PiCompatibility.assessPiCompatibility({
      version: options.piVersion,
      state: decoded.value,
    });
    if (Result.isFailure(compatibility)) {
      return yield* compatibility.failure;
    }
    if (compatibility.success !== expectedSessionId) {
      return yield* lifecycleError({
        operation: "handshake",
        threadId,
        detail: `Pi confirmed session '${compatibility.success}', expected '${expectedSessionId}'.`,
      });
    }
    return decoded.value;
  });

  const decodeResumeCursor = Effect.fn("PiSessionManager.decodeResumeCursor")(function* (
    input: PiSessionStartInput,
    cwd: string,
  ): Effect.fn.Return<PiResumeCursor | undefined, PiSessionManagerError> {
    if (input.resumeCursor === undefined) {
      return undefined;
    }
    const decoded = decodePiResumeCursor(input.resumeCursor);
    if (Option.isNone(decoded)) {
      return yield* lifecycleError({
        operation: "resume",
        threadId: input.threadId,
        detail: `resume cursor is not schema version ${PI_RESUME_CURSOR_SCHEMA_VERSION}.`,
      });
    }
    const cursor = decoded.value;
    const expectedSessionId = piSessionIdForThread(input.threadId);
    if (cursor.threadId !== input.threadId) {
      return yield* lifecycleError({
        operation: "resume",
        threadId: input.threadId,
        detail: `resume cursor belongs to thread '${cursor.threadId}'.`,
      });
    }
    if (cursor.sessionId !== expectedSessionId) {
      return yield* lifecycleError({
        operation: "resume",
        threadId: input.threadId,
        detail: `resume cursor names session '${cursor.sessionId}', expected '${expectedSessionId}'.`,
      });
    }
    if (cursor.sessionDir !== sessionDir) {
      return yield* lifecycleError({
        operation: "resume",
        threadId: input.threadId,
        detail: `resume cursor belongs to session directory '${cursor.sessionDir}', not '${sessionDir}'.`,
      });
    }
    if (cursor.cwd !== cwd) {
      return yield* lifecycleError({
        operation: "resume",
        threadId: input.threadId,
        detail: `resume cursor belongs to cwd '${cursor.cwd}', not '${cwd}'.`,
      });
    }
    if (cursor.sessionFile !== undefined && !isWithinDirectory(sessionDir, cursor.sessionFile)) {
      return yield* lifecycleError({
        operation: "resume",
        threadId: input.threadId,
        detail: `resume cursor session file '${cursor.sessionFile}' is outside '${sessionDir}'.`,
      });
    }

    // A brand-new Pi session has a path before its first assistant message but
    // may not have flushed a file yet. Once the cursor says there is history,
    // absence is a real loss and must not be replaced by --session-id's
    // "create if missing" behaviour.
    const requiresPersistedFile = cursor.messageCount === undefined || cursor.messageCount > 0;
    if (requiresPersistedFile) {
      if (cursor.sessionFile === undefined) {
        return yield* lifecycleError({
          operation: "resume",
          threadId: input.threadId,
          detail: "persisted session history has no session file in the cursor.",
        });
      }
      const exists = yield* fileSystem.exists(cursor.sessionFile).pipe(
        Effect.mapError((cause) =>
          lifecycleError({
            operation: "resume",
            threadId: input.threadId,
            detail: `could not inspect session file '${cursor.sessionFile}'.`,
            cause,
          }),
        ),
      );
      if (!exists) {
        return yield* lifecycleError({
          operation: "resume",
          threadId: input.threadId,
          detail: `session file '${cursor.sessionFile}' is missing; automatic reconstruction is disabled.`,
        });
      }
    }
    return cursor;
  });

  const makeCursor = (input: {
    readonly threadId: ThreadId;
    readonly cwd: string;
    readonly previous: PiResumeCursor | undefined;
    readonly state: PiRpcGetStateResponse;
  }): Effect.Effect<PiResumeCursor, PiSessionManagerError> => {
    const stateFile = stateSessionFile(input.state);
    if (stateFile !== undefined && !isWithinDirectory(sessionDir, stateFile)) {
      return Effect.fail(
        lifecycleError({
          operation: "handshake",
          threadId: input.threadId,
          detail: `Pi reported session file '${stateFile}' outside '${sessionDir}'.`,
        }),
      );
    }
    if (
      input.previous?.sessionFile !== undefined &&
      stateFile !== undefined &&
      input.previous.sessionFile !== stateFile
    ) {
      return Effect.fail(
        lifecycleError({
          operation: "resume",
          threadId: input.threadId,
          detail: `Pi reopened '${stateFile}', not the cursor's '${input.previous.sessionFile}'.`,
        }),
      );
    }

    const sessionFile = stateFile ?? input.previous?.sessionFile;
    return Effect.succeed({
      schemaVersion: PI_RESUME_CURSOR_SCHEMA_VERSION,
      threadId: input.threadId,
      sessionId: piSessionIdForThread(input.threadId),
      sessionDir,
      ...(sessionFile === undefined ? {} : { sessionFile }),
      cwd: input.cwd,
      piVersion: options.piVersion,
      ...(stateMessageCount(input.state) === undefined
        ? input.previous?.messageCount === undefined
          ? {}
          : { messageCount: input.previous.messageCount }
        : { messageCount: stateMessageCount(input.state) }),
    });
  };

  const closeContext = Effect.fn("PiSessionManager.closeContext")(function* (
    context: PiSessionContext,
  ) {
    if (yield* Ref.getAndSet(context.closed, true)) {
      return;
    }
    yield* context.connection.close;
    if (sessions.get(context.threadId) === context) {
      sessions.delete(context.threadId);
    }
    ownedSessions.delete(context);
    if (context.mcpLease) {
      yield* context.mcpLease.close;
    }
    yield* Scope.close(context.sessionScope, Exit.void);
  });

  const refreshContext = Effect.fn("PiSessionManager.refreshContext")(function* (
    context: PiSessionContext,
  ): Effect.fn.Return<PiResumeCursor, PiSessionManagerError> {
    if (yield* Ref.get(context.closed)) {
      return yield* lifecycleError({
        operation: "refresh",
        threadId: context.threadId,
        detail: "session process is closed.",
      });
    }
    const previous = yield* Ref.get(context.cursor);
    const state = yield* readState(context.threadId, context.connection, context.handle.sessionId);
    const next = yield* makeCursor({
      threadId: context.threadId,
      cwd: previous.cwd,
      previous,
      state,
    });
    yield* Ref.set(context.cursor, next);
    return next;
  });

  const start = Effect.fn("PiSessionManager.start")(function* (
    input: PiSessionStartInput,
  ): Effect.fn.Return<PiSession, PiSessionManagerError> {
    const cwd = normalizedPath(input.cwd ?? defaultCwd);
    const resumeCursor = yield* decodeResumeCursor(input, cwd);
    const expectedSessionId = resumeCursor?.sessionId ?? piSessionIdForThread(input.threadId);
    const mcpProviderSession = McpProviderSession.readMcpProviderSession(input.threadId);
    const mcpProviderSessionId = mcpProviderSession?.providerSessionId;
    const existing = sessions.get(input.threadId);
    if (
      existing &&
      (resumeCursor === undefined || existing.handle.sessionId === expectedSessionId) &&
      existing.mcpProviderSessionId === mcpProviderSessionId
    ) {
      return existing.handle;
    }
    if (existing) {
      yield* closeContext(existing);
    }

    const sessionScope = yield* Scope.make("sequential");
    const started = Effect.gen(function* () {
      const mcpLease = mcpProviderSession
        ? yield* (
            options.revokeMcpProviderSession === undefined
              ? makePiMcpSessionLease(mcpProviderSession)
              : makePiMcpSessionLease(mcpProviderSession, {
                  revokeProviderSession: options.revokeMcpProviderSession,
                })
          ).pipe(
            Effect.provideService(FileSystem.FileSystem, fileSystem),
            Effect.provideService(Scope.Scope, sessionScope),
          )
        : undefined;
      const args = [
        ...(options.args ?? ["--approve"]),
        ...(mcpLease === undefined ? [] : ["--extension", mcpLease.extensionPath]),
        "--mode",
        "rpc",
        "--session-dir",
        sessionDir,
        "--session-id",
        expectedSessionId,
      ];
      const connection = yield* connector({
        binaryPath: options.binaryPath,
        cwd,
        args,
        ...(options.environment === undefined ? {} : { environment: options.environment }),
      }).pipe(
        Effect.provideService(Scope.Scope, sessionScope),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, childProcessSpawner),
      );
      const state = yield* readState(input.threadId, connection, expectedSessionId);
      const cursor = yield* makeCursor({
        threadId: input.threadId,
        cwd,
        previous: resumeCursor,
        state,
      });
      const closed = yield* Ref.make(false);
      const cursorRef = yield* Ref.make(cursor);
      const context = {
        threadId: input.threadId,
        sessionScope,
        connection,
        cursor: cursorRef,
        closed,
        mcpProviderSessionId,
        mcpLease,
        handle: undefined as unknown as PiSession,
      } satisfies PiSessionContext;
      const handle: PiSession = {
        threadId: input.threadId,
        sessionId: expectedSessionId,
        cwd,
        sessionDir,
        request: connection.request,
        send: connection.send,
        events: connection.events,
        stderr: connection.stderr,
        getResumeCursor: () => Ref.get(cursorRef),
        refresh: () => refreshContext(context),
        close: closeContext(context),
      };
      context.handle = handle;
      return context;
    }).pipe(Effect.onError(() => Scope.close(sessionScope, Exit.void).pipe(Effect.ignore)));
    const context = yield* started;
    sessions.set(input.threadId, context);
    ownedSessions.add(context);
    yield* context.connection.exitCode.pipe(
      Effect.flatMap(() => lifecycleLock.withPermit(closeContext(context))),
      Effect.forkIn(managerScope),
    );
    return context.handle;
  });

  const stopAllDirect = () =>
    Effect.forEach([...ownedSessions], (context) => closeContext(context), { discard: true });
  yield* Scope.addFinalizer(managerScope, Effect.suspend(stopAllDirect));

  const manager: PiSessionManager = {
    start: (input) => lifecycleLock.withPermit(start(input)),
    get: (threadId) => Effect.succeed(Option.fromUndefinedOr(sessions.get(threadId)?.handle)),
    has: (threadId) => Effect.succeed(sessions.has(threadId)),
    list: () => Effect.succeed([...sessions.values()].map((context) => context.handle)),
    stop: (threadId) =>
      lifecycleLock.withPermit(
        Effect.flatMap(Effect.succeed(sessions.get(threadId)), (context) =>
          context === undefined ? Effect.void : closeContext(context),
        ),
      ),
    stopAll: () => lifecycleLock.withPermit(stopAllDirect()),
  };
  return manager;
});

export { makePiSessionManager };
