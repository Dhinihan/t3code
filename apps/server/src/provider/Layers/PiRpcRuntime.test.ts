// @effect-diagnostics nodeBuiltinImport:off
/**
 * Pi RPC runtime — level 2: boots the REAL `connectPiRpc` against the
 * scripted stdlib peer (`testFixtures/piRpcMockPeer.mjs`) over the real stdio
 * boundary. No Pi install, no model, no network: the suite stays hermetic
 * (ticket 13). Uses `it.live` (real child → real timers) with
 * `Effect.provide(NodeServices.layer)` for the process services, mirroring
 * `CodexCollabRuntime.integration.test.ts`.
 */
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";

import { assert, it } from "@effect/vitest";

import * as PiCompatibility from "./PiCompatibility.ts";
import { connectPiRpc, type PiRpcConnection } from "./PiRpcConnection.ts";
import { decodeGetStateResponse } from "./PiRpcContract.ts";
import { PiRpcRequestError } from "./PiRpcErrors.ts";

const PEER_PATH = NodePath.join(import.meta.dirname, "../testFixtures/piRpcMockPeer.mjs");

let scriptCounter = 0;
const makeScript = (overrides: Record<string, unknown> = {}) => {
  scriptCounter += 1;
  const path = NodePath.join(
    NodeOS.tmpdir(),
    `pi-rpc-peer-script-${process.pid}-${scriptCounter}.json`,
  );
  NodeFS.writeFileSync(path, JSON.stringify(overrides), "utf8");
  return path;
};

const makeConnection = (scriptPath: string, logPath?: string) =>
  connectPiRpc({
    binaryPath: process.execPath,
    cwd: "/tmp",
    args: [PEER_PATH],
    environment: {
      ...process.env,
      PI_RPC_PEER_SCRIPT: scriptPath,
      ...(logPath ? { PI_RPC_PEER_LOG: logPath } : {}),
    },
  });

const run = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.provide(NodeServices.layer), Effect.scoped);

it.live("gets state and runs a compatibility handshake against the peer", () =>
  run(
    Effect.gen(function* () {
      const script = makeScript({
        sessionId: "sess-1",
        stateModel: { provider: "openai-codex", id: "gpt-5.6-luna" },
      });
      const connection: PiRpcConnection = yield* makeConnection(script);
      const response = yield* connection.request({ type: "get_state" }, "r1");
      const state = decodeGetStateResponse(response);
      assert.equal(state._tag, "Some");
      if (state._tag === "None") return;
      assert.equal(state.value.data.sessionId, "sess-1");

      const compatibility = PiCompatibility.assessPiCompatibility({
        version: "0.84.1",
        state: state.value,
      });
      assert.equal(compatibility._tag, "Success");
      yield* connection.close;
      NodeFS.rmSync(script, { force: true });
    }),
  ),
);

it.live("streams events interleaved with a prompt acceptance", () =>
  run(
    Effect.gen(function* () {
      const script = makeScript({
        promptEvents: [
          { type: "message_start", message: { role: "user", content: [] } },
          {
            type: "message_end",
            message: { role: "assistant", content: [], stopReason: "end_turn" },
          },
        ],
      });
      const connection: PiRpcConnection = yield* makeConnection(script);
      const settled = yield* connection.events.pipe(
        Stream.filter((event) => event.type === "agent_settled"),
        Stream.take(1),
        Stream.runCollect,
        Effect.forkScoped,
      );
      const response = yield* connection.request({ type: "prompt", message: "hi" }, "r2");
      assert.equal(response.success, true);
      const settledEvents = yield* Fiber.join(settled);
      assert.equal(settledEvents.length, 1);
      yield* connection.close;
      NodeFS.rmSync(script, { force: true });
    }),
  ),
);

it.live("surfaces a command error from the peer", () =>
  run(
    Effect.gen(function* () {
      const script = makeScript({ failCommand: "set_model" });
      const connection: PiRpcConnection = yield* makeConnection(script);
      const result = yield* Effect.exit(
        connection.request({ type: "set_model", provider: "no-such", modelId: "model" }, "r3"),
      );
      assert.equal(result._tag, "Failure");
      if (result._tag === "Failure") {
        const error = result.cause;
        if (error instanceof PiRpcRequestError) {
          assert.include(error.message, "Model not found");
        }
      }
      yield* connection.close;
      NodeFS.rmSync(script, { force: true });
    }),
  ),
);

it.live("drains stderr without blocking protocol responses", () =>
  run(
    Effect.gen(function* () {
      const script = makeScript({ stderrBytes: 512 * 1024 });
      const connection: PiRpcConnection = yield* makeConnection(script);
      const response = yield* connection
        .request({ type: "get_state" }, "r4")
        .pipe(Effect.timeoutOption("5 seconds"));
      assert.equal(response._tag, "Some");
      if (response._tag === "Some") {
        assert.equal(response.value.command, "get_state");
      }
      yield* connection.close;
      NodeFS.rmSync(script, { force: true });
    }),
  ),
);

it.live("fails pending requests when the child dies mid-protocol", () =>
  run(
    Effect.gen(function* () {
      const script = makeScript({ deathOnCommand: "get_state" });
      const connection: PiRpcConnection = yield* makeConnection(script);
      const result = yield* Effect.exit(connection.request({ type: "get_state" }, "r5"));
      assert.equal(result._tag, "Failure");
      yield* connection.close.pipe(Effect.ignore);
      NodeFS.rmSync(script, { force: true });
    }),
  ),
);

it.live("records every received command to the peer log", () =>
  run(
    Effect.gen(function* () {
      const script = makeScript();
      const logPath = NodePath.join(
        NodeOS.tmpdir(),
        `pi-rpc-peer-log-${process.pid}-${scriptCounter}.jsonl`,
      );
      const connection: PiRpcConnection = yield* makeConnection(script, logPath);
      yield* connection.request({ type: "get_state" }, "r6");
      yield* connection.request({ type: "get_available_models" }, "r7");
      const startedAt = yield* Effect.clockWith((clock) => clock.currentTimeMillis);
      yield* connection.close;
      const closedAt = yield* Effect.clockWith((clock) => clock.currentTimeMillis);
      assert.isBelow(closedAt - startedAt, 2_000, "close should not block on a fixed sleep");
      const lines = NodeFS.readFileSync(logPath, "utf8").trim().split("\n").filter(Boolean);
      const commands = lines.map((line) => (JSON.parse(line) as { command?: string }).command);
      assert.include(commands, "get_state");
      assert.include(commands, "get_available_models");
      NodeFS.rmSync(script, { force: true });
      NodeFS.rmSync(logPath, { force: true });
    }),
  ),
);

it.live("closing one connection does not tear down a sibling in the same scope", () =>
  run(
    Effect.gen(function* () {
      const scriptA = makeScript();
      const scriptB = makeScript();
      const connectionA: PiRpcConnection = yield* makeConnection(scriptA);
      const connectionB: PiRpcConnection = yield* makeConnection(scriptB);
      yield* connectionA.close;
      // B must still be alive: closing A did not close the shared scope.
      const response = yield* connectionB
        .request({ type: "get_state" }, "rb")
        .pipe(Effect.timeoutOption("3 seconds"));
      assert.equal(response._tag, "Some");
      yield* connectionB.close;
      NodeFS.rmSync(scriptA, { force: true });
      NodeFS.rmSync(scriptB, { force: true });
    }),
  ),
);
