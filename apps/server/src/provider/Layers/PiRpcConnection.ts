/**
 * Pi RPC connection — a scoped child-process handle speaking the Pi JSONL
 * protocol (ticket 14). Owns the process, drains stderr away from the
 * protocol stream, classifies exit as a typed termination that fails pending
 * requests, and kills the whole POSIX process group on close so subagent
 * descendants cannot survive their owner.
 *
 * Lifecycle: the child is spawned `detached` on POSIX so the group kill works;
 * the scope that `connectPiRpc` runs in owns the process. On `close` we kill
 * the group (SIGTERM, then SIGKILL after a deadline) and WAIT for the child to
 * exit instead of sleeping a fixed amount — no orphan, no fixed sleep. We do
 * NOT close the caller's scope: the connection registers its cleanup as a
 * finalizer so multiple connections can share an outer scope (ticket 16) and
 * closing one cannot tear down its neighbours.
 *
 * Topology ownership is deliberately NOT here: ticket 16 decides per-thread
 * session lifecycle on top of this seam.
 */
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { resolveSpawnCommand } from "@t3tools/shared/shell";

import * as PiRpcErrors from "./PiRpcErrors.ts";
import * as PiRpcProtocol from "./PiRpcProtocol.ts";

const PI_FORCE_KILL_AFTER = "2 seconds";
const PI_GROUP_KILL_GRACE_MS = 500;

export interface PiRpcConnectionOptions {
  readonly binaryPath: string;
  readonly cwd: string;
  readonly args?: ReadonlyArray<string>;
  readonly environment?: NodeJS.ProcessEnv;
}

export interface PiRpcConnection {
  readonly pid: number;
  readonly events: PiRpcProtocol.PiRpcProtocol["events"];
  readonly request: PiRpcProtocol.PiRpcProtocol["request"];
  /** Last captured stderr diagnostic lines (best-effort, bounded). */
  readonly stderr: Effect.Effect<string>;
  /** Close the process (and its group) and wait for it to exit. Idempotent. */
  readonly close: Effect.Effect<void>;
}

export const connectPiRpc = Effect.fn("connectPiRpc")(function* (
  options: PiRpcConnectionOptions,
): Effect.fn.Return<
  PiRpcConnection,
  PiRpcErrors.PiRpcSpawnError | PiRpcErrors.PiRpcTransportError,
  ChildProcessSpawner.ChildProcessSpawner | typeof HostProcessPlatform | Scope.Scope
> {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const hostPlatform = yield* HostProcessPlatform;
  const runtimeScope = yield* Scope.Scope;

  const env = options.environment;
  const extendEnv = env === undefined;
  const resolved = yield* resolveSpawnCommand(options.binaryPath, options.args ?? [], {
    env: env ?? {},
    extendEnv,
  });

  const child = yield* spawner
    .spawn(
      ChildProcess.make(resolved.command, resolved.args, {
        cwd: options.cwd,
        ...(env ? { env, extendEnv } : { extendEnv: true }),
        forceKillAfter: PI_FORCE_KILL_AFTER,
        // `detached` on POSIX gives the child its own process group, so a
        // negative-pid kill reaches the Pi AND any subagent descendants.
        detached: hostPlatform !== "win32",
        shell: resolved.shell,
      }),
    )
    .pipe(
      Effect.provideService(Scope.Scope, runtimeScope),
      Effect.mapError(
        (cause) =>
          new PiRpcErrors.PiRpcSpawnError({
            command: `${options.binaryPath} ${options.args?.join(" ") ?? ""}`.trim(),
            cause,
          }),
      ),
    );

  // Capture stderr (bounded) for diagnostics and keep it away from the
  // protocol stream. The Pi writes diagnostics here; it must never block the
  // JSONL responses.
  const stderrRef = yield* Ref.make("");
  yield* child.stderr.pipe(
    Stream.decodeText(),
    Stream.runForEach((chunk) =>
      Ref.update(stderrRef, (current) => (current + chunk).slice(-64 * 1024)),
    ),
    Effect.ignore,
    Effect.forkIn(runtimeScope),
  );

  // A deferred the exit watcher resolves once, so close can WAIT for the
  // child to actually exit instead of sleeping a fixed amount.
  const exitedDeferred = yield* Deferred.make<void, never>();

  // Classify process death as a typed termination that fails any pending
  // request through the protocol's terminationError path.
  yield* child.exitCode.pipe(
    Effect.flatMap((_code) => Deferred.succeed(exitedDeferred, undefined).pipe(Effect.ignore)),
    Effect.ignore,
    Effect.forkIn(runtimeScope),
  );

  const stdio = yield* Effect.sync(() => PiRpcProtocol.makeChildStdio(child));
  const protocol = yield* PiRpcProtocol.makePiRpcProtocol({
    stdio,
    // Prefer the classified exit error over the generic stream-ended error so
    // a dead Pi surfaces "process exited with code N" instead of a generic EOF.
    terminationError: new PiRpcErrors.PiRpcTerminatedError({}),
    // A wedged Pi must never strand a turn: every request has a bounded wait.
    requestTimeout: "30 seconds",
  });

  const killProcessGroup = (signal: "SIGTERM" | "SIGKILL") =>
    hostPlatform === "win32"
      ? child.kill({ killSignal: signal, forceKillAfter: PI_FORCE_KILL_AFTER }).pipe(Effect.asVoid)
      : Effect.gen(function* () {
          // Signal the direct child first so the handle's exitCode emits, then
          // the whole group (detached spawn) so subagent descendants die too.
          yield* child
            .kill({ killSignal: signal, forceKillAfter: PI_FORCE_KILL_AFTER })
            .pipe(Effect.ignore);
          try {
            process.kill(-Number(child.pid), signal);
          } catch {
            // The process group may already be gone; best-effort.
          }
        });

  const closedRef = yield* Ref.make(false);
  const close = Effect.gen(function* () {
    const already = yield* Ref.getAndSet(closedRef, true);
    if (already) return;
    yield* protocol.close;
    // EOF on stdin (via the protocol writer's sink finalization) makes the Pi
    // shut down cleanly. Kill the group, then wait for the child to exit;
    // SIGKILL is the fallback if the grace period expires.
    yield* killProcessGroup("SIGTERM");
    yield* Deferred.await(exitedDeferred).pipe(
      Effect.timeout(`${PI_GROUP_KILL_GRACE_MS} millis`),
      Effect.catch(() => killProcessGroup("SIGKILL")),
    );
  });

  // The scope owns the process: if the caller's scope closes without an
  // explicit `close`, the finalizer still kills the group.
  yield* Scope.addFinalizer(runtimeScope, close);

  return {
    pid: Number(child.pid),
    events: protocol.events,
    request: protocol.request,
    stderr: Ref.get(stderrRef),
    close,
  } satisfies PiRpcConnection;
});
