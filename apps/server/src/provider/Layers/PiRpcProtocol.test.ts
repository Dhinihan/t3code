/**
 * Pi RPC protocol — level 1 transport tests over in-memory stdio. No process,
 * no timer: pins LF framing, correlation, interleaving, tolerance, and the
 * termination path that fails pending requests.
 *
 * The request must be FORKED before the peer responds: `peer.receive` waits
 * for the correlated outgoing line, which is only written while the request
 * effect runs. `Effect.scoped` wraps the whole body so the protocol's
 * `forkScoped` reader/writer fibers stay alive for the duration.
 */
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { assert, it } from "@effect/vitest";

import { decodeGetStateResponse } from "./PiRpcContract.ts";
import * as PiProtocol from "./PiRpcProtocol.ts";
import { PiRpcRequestTimeoutError } from "./PiRpcErrors.ts";

const decodeJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
const isPiRpcRequestTimeoutError = Schema.is(PiRpcRequestTimeoutError);

const makeHarness = () =>
  PiProtocol.makeInMemoryPiStdio().pipe(
    Effect.flatMap(({ stdio, peer }) =>
      PiProtocol.makePiRpcProtocol({ stdio }).pipe(Effect.map((protocol) => ({ protocol, peer }))),
    ),
  );

const makeSendHarness = () =>
  PiProtocol.makeInMemoryPiStdio().pipe(
    Effect.flatMap(({ stdio, output }) =>
      PiProtocol.makePiRpcProtocol({ stdio }).pipe(
        Effect.map((protocol) => ({ protocol, output })),
      ),
    ),
  );

it.effect("correlates a response by id", () =>
  Effect.gen(function* () {
    const { protocol, peer } = yield* makeHarness();
    const responseFiber = yield* Effect.forkScoped(
      protocol.request({ type: "get_state" }, "req-1"),
    );
    yield* peer.receive("req-1", {
      id: "req-1",
      type: "response",
      command: "get_state",
      success: true,
      data: { sessionId: "s-1" },
    });
    const response = yield* Fiber.join(responseFiber);
    const state = decodeGetStateResponse(response);
    assert.equal(state._tag, "Some");
    if (state._tag === "Some") {
      assert.equal(state.value.data.sessionId, "s-1");
    }
  }).pipe(Effect.scoped),
);

it.effect("interleaves a response with a streamed event", () =>
  Effect.gen(function* () {
    const { protocol, peer } = yield* makeHarness();
    const events = yield* protocol.events.pipe(
      Stream.take(1),
      Stream.runCollect,
      Effect.forkScoped,
    );
    const responseFiber = yield* Effect.forkScoped(
      protocol.request({ type: "prompt", message: "hi" }, "req-2"),
    );
    yield* peer.receive("req-2", { type: "agent_start" });
    yield* peer.push({
      id: "req-2",
      type: "response",
      command: "prompt",
      success: true,
    });
    const response = yield* Fiber.join(responseFiber);
    assert.equal(response.command, "prompt");
    const received = yield* Fiber.join(events);
    assert.equal(received[0]?.type, "agent_start");
  }).pipe(Effect.scoped),
);

it.effect("tolerates a malformed line and an unknown event type", () =>
  Effect.gen(function* () {
    const { protocol, peer } = yield* makeHarness();
    const responseFiber = yield* Effect.forkScoped(
      protocol.request({ type: "get_state" }, "req-3"),
    );
    yield* peer.receive("req-3", "not json at all");
    yield* peer.push({ type: "brand_new_event", anything: true });
    yield* peer.push({
      id: "req-3",
      type: "response",
      command: "get_state",
      success: true,
      data: { sessionId: "s-3" },
    });
    const response = yield* Fiber.join(responseFiber);
    const state = decodeGetStateResponse(response);
    assert.equal(state._tag, "Some");
    if (state._tag === "Some") {
      assert.equal(state.value.data.sessionId, "s-3");
    }
  }).pipe(Effect.scoped),
);

it.effect("fails all pending requests when the peer terminates", () =>
  Effect.gen(function* () {
    const { protocol, peer } = yield* makeHarness();
    const responseFiber = yield* Effect.forkScoped(
      protocol.request({ type: "get_state" }, "req-4"),
    );
    yield* peer.terminate();
    const result = yield* Fiber.join(responseFiber).pipe(Effect.exit);
    assert.equal(result._tag, "Failure");
  }).pipe(Effect.scoped),
);

it.effect("fails a request sent after termination instead of hanging", () =>
  Effect.gen(function* () {
    const { protocol, peer } = yield* makeHarness();
    yield* peer.terminate();
    const result = yield* protocol.request({ type: "get_state" }, "req-5").pipe(Effect.exit);
    assert.equal(result._tag, "Failure");
  }).pipe(Effect.scoped),
);

it.effect("sends a one-way extension UI cancellation without registering a pending request", () =>
  Effect.gen(function* () {
    const { protocol, output } = yield* makeSendHarness();
    const lineFiber = yield* Stream.fromQueue(output).pipe(
      Stream.take(1),
      Stream.runCollect,
      Effect.forkScoped,
    );
    yield* protocol.send({ type: "extension_ui_response", id: "ui-1", cancelled: true });
    const lines = yield* Fiber.join(lineFiber);
    assert.deepEqual(decodeJson(lines[0] ?? "{}"), {
      type: "extension_ui_response",
      id: "ui-1",
      cancelled: true,
    });
  }).pipe(Effect.scoped),
);

it.live("times out a request whose response never arrives", () =>
  Effect.gen(function* () {
    const { stdio } = yield* PiProtocol.makeInMemoryPiStdio();
    const protocol = yield* PiProtocol.makePiRpcProtocol({ stdio, requestTimeout: "50 millis" });
    const responseFiber = yield* Effect.forkScoped(
      protocol.request({ type: "get_state" }, "req-6"),
    );
    // The peer never pushes a response; the request deadline fires.
    const result = yield* Fiber.join(responseFiber).pipe(Effect.exit);
    assert.equal(result._tag, "Failure");
    if (result._tag === "Failure") {
      const cause = result.cause;
      if (isPiRpcRequestTimeoutError(cause)) {
        assert.include(cause.message, "get_state");
      }
    }
    yield* protocol.close;
  }).pipe(Effect.scoped),
);
