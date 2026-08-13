/**
 * Pi RPC transport — JSONL over `effect/Stdio` with id correlation.
 *
 * This is the Pi-flavoured port of `effect-codex-app-server/src/protocol.ts`.
 * The Pi is a pure responder: the host writes commands on stdin and reads
 * responses + session events on stdout. There are no server-initiated
 * requests, so unlike the codex protocol there is no inbound-request router —
 * every line is either a correlated response or an event.
 *
 * Framing is LF with a `\r` tolerance and a carry-over remainder. Responses
 * are correlated by their `id` into a pending map of deferreds; events are
 * pushed to a queue. EOF or stream death fails every pending request exactly
 * once (idempotent via a `terminationHandled` ref) and ends the writer queue,
 * so an unexpected child exit cannot leave callers hanging.
 */
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Sink from "effect/Sink";
import * as Stdio from "effect/Stdio";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/unstable/process";

import {
  classifyRecord,
  decodeWireRecordOption,
  type PiRpcCommand,
  type PiRpcEvent,
  type PiRpcExtensionUiResponse,
  type PiRpcResponse,
} from "./PiRpcContract.ts";
import {
  PiRpcRequestError,
  PiRpcRequestTimeoutError,
  PiRpcTransportError,
  PiRpcTerminatedError,
} from "./PiRpcErrors.ts";
import type * as PiRpcErrors from "./PiRpcErrors.ts";

const decoder = new TextDecoder();
const encoder = new TextEncoder();

const decodeJsonLine = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));
const encodeCommandLine = Schema.encodeUnknownSync(Schema.fromJsonString(Schema.Unknown));

export interface PiRpcProtocolOptions {
  readonly stdio: Stdio.Stdio;
  /**
   * When the input stream ends cleanly (EOF or peer death), prefer this error
   * over the generic {@link PiRpcTerminatedError}. The connection layer feeds
   * a classified exit-code error here so pending requests fail with the real
   * reason instead of a generic "stream ended".
   */
  readonly terminationError?: PiRpcErrors.PiRpcError;
  /**
   * Per-request deadline. A request that does not receive its correlated
   * response within this window fails with {@link PiRpcRequestTimeoutError}
   * instead of hanging forever. The connection layer sets a default so a
   * wedged Pi can never strand a turn.
   */
  readonly requestTimeout?: Duration.Input;
}

export interface PiRpcProtocol {
  /**
   * Send a command with an id and wait for the correlated response. The
   * pending entry is removed on success, failure, or interruption.
   */
  readonly request: (
    command: PiRpcCommand,
    id: string,
  ) => Effect.Effect<PiRpcResponse, PiRpcErrors.PiRpcError>;
  /** Send a host message that has no correlated response. */
  readonly send: (message: PiRpcExtensionUiResponse) => Effect.Effect<void, PiRpcErrors.PiRpcError>;
  /** Stream of session/extension events, in arrival order. */
  readonly events: Stream.Stream<PiRpcEvent>;
  /** Close the protocol: fail pending, end the writer, stop the reader. */
  readonly close: Effect.Effect<void>;
}

interface PendingRequest {
  readonly deferred: Deferred.Deferred<PiRpcResponse, PiRpcErrors.PiRpcError>;
}

export const makePiRpcProtocol = Effect.fn("makePiRpcProtocol")(function* (
  options: PiRpcProtocolOptions,
): Effect.fn.Return<PiRpcProtocol, never, import("effect/Scope").Scope> {
  const outgoing = yield* Queue.unbounded<Uint8Array, Cause.Done<void>>();
  const incomingEvents = yield* Queue.unbounded<PiRpcEvent, Cause.Done<void>>();
  const pending = yield* Ref.make(new Map<string, PendingRequest>());
  const remainder = yield* Ref.make("");
  const terminationHandled = yield* Ref.make(false);
  const closedRef = yield* Ref.make(false);

  const failAllPending = (error: PiRpcErrors.PiRpcError) =>
    Ref.get(pending).pipe(
      Effect.flatMap((current) =>
        Effect.forEach([...current.values()], ({ deferred }) => Deferred.fail(deferred, error), {
          discard: true,
        }),
      ),
      Effect.andThen(Ref.set(pending, new Map())),
    );

  const handleTermination = (error: PiRpcErrors.PiRpcError) =>
    Ref.modify(terminationHandled, (handled) => {
      if (handled) {
        return [Effect.void, true] as const;
      }
      return [
        Effect.gen(function* () {
          yield* failAllPending(error);
          yield* Queue.end(outgoing);
        }),
        true,
      ] as const;
    }).pipe(Effect.flatten);

  const resolvePending = (id: string, handler: (request: PendingRequest) => Effect.Effect<void>) =>
    Ref.modify(pending, (current) => {
      const request = current.get(id);
      if (!request) {
        return [Effect.void, current] as const;
      }
      const next = new Map(current);
      next.delete(id);
      return [handler(request), next] as const;
    }).pipe(Effect.flatten);

  const handleResponse = (response: PiRpcResponse) =>
    resolvePending(response.id, ({ deferred }) =>
      response.success === true
        ? Deferred.succeed(deferred, response)
        : Deferred.fail(deferred, PiRpcRequestError.fromResponse(response)),
    );

  const handleLine = (line: string): Effect.Effect<void, never> => {
    if (line.trim().length === 0) {
      return Effect.void;
    }
    const parsed = decodeJsonLine(line);
    if (parsed._tag === "None") {
      // Unparseable line — not part of the protocol. Tolerate and move on.
      return Effect.void;
    }
    const record = decodeWireRecordOption(parsed.value);
    if (record._tag === "None") {
      // Not a response or an event envelope. Tolerate and move on.
      return Effect.void;
    }
    if (classifyRecord(record.value) === "response") {
      return handleResponse(record.value as PiRpcResponse);
    }
    return Queue.offer(incomingEvents, record.value as PiRpcEvent).pipe(Effect.asVoid);
  };

  yield* options.stdio.stdin.pipe(
    Stream.decodeText(),
    Stream.runForEach((chunk) =>
      Ref.modify(remainder, (current) => {
        const combined = current + chunk;
        const lines = combined.split("\n");
        const nextRemainder = lines.pop() ?? "";
        return [lines.map((line) => line.replace(/\r$/, "")), nextRemainder] as const;
      }).pipe(Effect.flatMap((lines) => Effect.forEach(lines, handleLine, { discard: true }))),
    ),
    Effect.tapError((cause) => Effect.logError("PiRpcProtocol stdin stream error", { cause })),
    Effect.matchEffect({
      onFailure: (cause) => handleTermination(new PiRpcTransportError({ cause })),
      onSuccess: () =>
        Ref.get(remainder).pipe(
          Effect.flatMap((line) => (line.trim().length === 0 ? Effect.void : handleLine(line))),
          Effect.matchEffect({
            onFailure: () =>
              handleTermination(options.terminationError ?? new PiRpcTerminatedError({})),
            onSuccess: () =>
              handleTermination(options.terminationError ?? new PiRpcTerminatedError({})),
          }),
        ),
    }),
    Effect.forkScoped,
  );

  yield* Stream.fromQueue(outgoing).pipe(Stream.run(options.stdio.stdout()), Effect.forkScoped);

  const close = Effect.gen(function* () {
    const alreadyClosed = yield* Ref.getAndSet(closedRef, true);
    if (alreadyClosed) {
      return;
    }
    yield* handleTermination(new PiRpcTerminatedError({}));
    // `end` (not `shutdown`) so already-queued events drain to consumers and
    // the stream terminates normally instead of interrupting mid-tail.
    yield* Queue.end(outgoing);
    yield* Queue.end(incomingEvents);
  });

  const writeRecord = Effect.fn("PiRpcProtocol.writeRecord")(function* (
    record: unknown,
  ): Effect.fn.Return<void, PiRpcErrors.PiRpcError> {
    const terminated = yield* Ref.get(terminationHandled);
    if (terminated) {
      return yield* new PiRpcTerminatedError({});
    }
    const offered = yield* Queue.offer(outgoing, encoder.encode(`${encodeCommandLine(record)}\n`));
    if (!offered) {
      return yield* new PiRpcTerminatedError({});
    }
  });

  const requestCommand = Effect.fn("PiRpcProtocol.request")(function* (
    command: PiRpcCommand,
    id: string,
  ): Effect.fn.Return<PiRpcResponse, PiRpcErrors.PiRpcError> {
    // If the transport already terminated, fail immediately instead of
    // registering a pending request that can never resolve.
    const terminated = yield* Ref.get(terminationHandled);
    if (terminated) {
      return yield* new PiRpcTerminatedError({});
    }
    const deferred = yield* Deferred.make<PiRpcResponse, PiRpcErrors.PiRpcError>();
    yield* Ref.update(pending, (current) => new Map(current).set(id, { deferred }));
    const offered = yield* writeRecord({ ...command, id }).pipe(Effect.exit);
    if (offered._tag === "Failure") {
      // Queue is closed (terminated between the check and the offer). Clean
      // up and fail.
      yield* Ref.update(pending, (current) => {
        const next = new Map(current);
        next.delete(id);
        return next;
      });
      return yield* Effect.failCause(offered.cause);
    }
    const timeoutInput = options.requestTimeout ?? "30 seconds";
    const awaited = yield* Deferred.await(deferred).pipe(
      Effect.onInterrupt(() =>
        Ref.update(pending, (current) => {
          const next = new Map(current);
          next.delete(id);
          return next;
        }),
      ),
      Effect.timeoutOption(timeoutInput),
    );
    if (awaited._tag === "None") {
      // Clean the pending entry and surface a typed timeout.
      yield* Ref.update(pending, (current) => {
        const next = new Map(current);
        next.delete(id);
        return next;
      });
      return yield* new PiRpcRequestTimeoutError({
        command: command.type,
        timeoutMs: Duration.toMillis(Duration.fromInputUnsafe(timeoutInput)),
      });
    }
    return awaited.value;
  });

  return {
    request: requestCommand,
    send: writeRecord,
    events: Stream.fromQueue(incomingEvents).pipe(Stream.catchCause(() => Stream.empty)),
    close,
  } satisfies PiRpcProtocol;
});

const encoder_ = new TextEncoder();

export const makeChildStdio = (handle: ChildProcessSpawner.ChildProcessHandle) =>
  Stdio.make({
    args: Effect.succeed([]),
    stdin: handle.stdout,
    stdout: () =>
      Sink.mapInput(handle.stdin, (chunk: string | Uint8Array) =>
        typeof chunk === "string" ? encoder_.encode(chunk) : chunk,
      ),
    stderr: () => Sink.drain,
  });

export interface PiStdioPeer {
  /**
   * Wait for the correlated outgoing request line, then push one record into
   * the Pi's stdin. Use this for the FIRST record after a request so ordering
   * is deterministic.
   */
  readonly receive: (requestId: string, record: unknown) => Effect.Effect<void, never>;
  /** Push a record into the Pi's stdin without waiting for outgoing. */
  readonly push: (record: unknown) => Effect.Effect<void, never>;
  readonly terminate: () => Effect.Effect<void, never>;
}

/** In-memory stdio + a peer that can push records and terminate — the hermetic
 * seam for protocol tests (no process, no timer). */
export const makeInMemoryPiStdio = Effect.fn("makeInMemoryPiStdio")(function* () {
  const input = yield* Queue.unbounded<Uint8Array, Cause.Done<void>>();
  const output = yield* Queue.unbounded<string>();

  const stdio = Stdio.make({
    args: Effect.succeed([]),
    stdin: Stream.fromQueue(input),
    stdout: () =>
      Sink.forEach((chunk: string | Uint8Array) =>
        Queue.offer(
          output,
          typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true }),
        ).pipe(Effect.asVoid),
      ),
    stderr: () => Sink.drain,
  });

  const readOutgoing = (requestId: string) =>
    Stream.fromQueue(output).pipe(
      Stream.filter((line) => line.includes(`"${requestId}"`)),
      Stream.take(1),
      Stream.runHead,
    );

  return {
    stdio,
    input,
    output,
    peer: {
      receive: (requestId, record) =>
        Effect.gen(function* () {
          // Wait for the host to write the correlated request first, then
          // respond, so the test's send/receive order is deterministic.
          yield* readOutgoing(requestId);
          yield* Queue.offer(input, encodePeerRecord(record));
        }),
      push: (record) => Queue.offer(input, encodePeerRecord(record)),
      terminate: () =>
        Effect.gen(function* () {
          yield* Queue.end(input);
          yield* Queue.shutdown(output);
        }),
    } satisfies PiStdioPeer,
  };
});

const encodePeerRecord = (record: unknown): Uint8Array =>
  typeof record === "string"
    ? encoder.encode(`${record}\n`)
    : encoder.encode(`${encodeCommandLine(record)}\n`);
