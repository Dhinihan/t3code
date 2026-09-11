import { assert, describe, it } from "vite-plus/test";

import {
  TurnId,
  EventId,
  ThreadId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderRuntimeEvent,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { runtimeEventToActivities } from "../../orchestration/Layers/ProviderRuntimeIngestion.ts";
import {
  foldSubagentActivities,
  deriveAgentPanelModel,
} from "../../../../../packages/client-runtime/src/state/subagentRuntime.ts";
import { decodeWireRecord, type PiRpcEvent } from "./PiRpcContract.ts";
import { makePiSubagentEvents } from "./PiSubagentEvents.ts";

const session = (overrides: Record<string, unknown> = {}) => ({
  id: "sa-1",
  origin: "model",
  title: "Research",
  backend: "pi",
  model: "model-1",
  status: "running",
  terminalReason: null,
  createdAt: 1,
  updatedAt: 2,
  settledAt: null,
  context: { occupancyTokens: null, capacityTokens: null },
  cumulative: { tokens: 10, costUsd: null },
  generation: { active: true, counter: 1, outputCharacters: 3 },
  tools: {
    active: 1,
    done: 0,
    error: 0,
    activities: [{ sequence: 1, kind: "read", state: "running", startedAt: 1, endedAt: null }],
  },
  ...overrides,
});
const event = (sessions: readonly unknown[], sequence = 1): PiRpcEvent => {
  const decoded = decodeWireRecord({
    type: "extension_ui_request",
    id: "1",
    method: "setStatus",
    statusKey: "t3-subagents:v1",
    statusText: JSON.stringify({ protocolVersion: 1, sequence, sessions }),
  });
  if (decoded.type !== "extension_ui_request") throw new Error("fixture did not decode as event");
  return decoded;
};

describe("PiSubagentEvents", () => {
  it("starts, deduplicates churn, and completes with cumulative usage", () => {
    const events = makePiSubagentEvents({ runtimeId: "runtime-a" });
    const first = events.accept({ event: event([session()]), turnId: TurnId.make("turn-a") });
    assert.deepEqual(
      first.map((item) => item.type),
      ["task.started", "task.progress"],
    );
    assert.equal(events.accept({ event: event([session({ updatedAt: 999 })], 2) }).length, 0);
    const terminal = events.accept({
      event: event(
        [
          session({
            status: "error",
            terminalReason: "failed",
            generation: { active: false, counter: 1, outputCharacters: 3 },
            tools: {
              active: 0,
              done: 1,
              error: 0,
              activities: [
                { sequence: 1, kind: "read", state: "completed", startedAt: 1, endedAt: 3 },
              ],
            },
          }),
        ],
        3,
      ),
    });
    assert.equal(terminal.at(-1)?.type, "task.completed");
    const completed = terminal.find((item) => item.type === "task.completed");
    assert.equal(completed?.payload.typedUsage?.totalTokens, 10);
    assert.equal(events.hasLiveTasks(), false);
  });

  it("keeps runtime identity and original turn through reactivation", () => {
    const events = makePiSubagentEvents({ runtimeId: "runtime-b" });
    const first = events.accept({
      event: event([session({ status: "done", terminalReason: "completed" })]),
      turnId: TurnId.make("turn-old"),
    });
    const id = first[0]?.payload.taskId;
    const resumed = events.accept({
      event: event([session({ status: "running", terminalReason: null })], 2),
      turnId: TurnId.make("turn-new"),
    });
    assert.equal(resumed[0]?.type, "task.progress");
    assert.equal(resumed[0]?.payload.taskId, id);
    assert.equal(resumed[0]?.turnId, TurnId.make("turn-old"));
  });

  it("ignores invalid, unknown, and by-the-way payloads; close is idempotent", () => {
    const events = makePiSubagentEvents({ runtimeId: "runtime-c" });
    const invalid = decodeWireRecord({
      type: "extension_ui_request",
      id: "1",
      method: "setStatus",
      statusKey: "t3-subagents:v1",
      statusText: "{}",
    });
    assert.equal(
      events.accept({ event: invalid.type === "extension_ui_request" ? invalid : event([]) })
        .length,
      0,
    );
    events.accept({ event: event([session({ origin: "btw" })]) });
    assert.equal(events.hasLiveTasks(), false);
    events.accept({ event: event([session()], 2) });
    assert.deepEqual(
      events.close().map((item) => item.type),
      ["task.updated", "task.completed"],
    );
    assert.equal(events.close().length, 0);
  });
});

it("rejects stale snapshots and recognizes an already settled child", () => {
  const normalizer = makePiSubagentEvents({ runtimeId: "fresh" });
  const terminal = normalizer.accept({
    event: event([session({ status: "done", terminalReason: "completed" })], 4),
  });
  assert.equal(terminal.at(-1)?.type, "task.completed");
  assert.equal(normalizer.hasLiveTasks(), false);
  assert.deepEqual(normalizer.accept({ event: event([session()], 3) }), []);
  assert.equal(normalizer.hasLiveTasks(), false);
  assert.deepEqual(normalizer.close(), []);
});

it("namespaces local IDs by runtime and preserves cancellation", () => {
  const first = makePiSubagentEvents({ runtimeId: "one" });
  const second = makePiSubagentEvents({ runtimeId: "two" });
  const a = first.accept({ event: event([session()]) });
  const b = second.accept({ event: event([session()]) });
  assert.notEqual(a[0]?.payload.taskId, b[0]?.payload.taskId);
  const cancelled = first.accept({
    event: event([session({ status: "error", terminalReason: "cancelled" })], 2),
  });
  assert.isTrue(
    cancelled.some(
      (update) => update.type === "task.updated" && update.payload.status === "cancelled",
    ),
  );
  assert.isTrue(
    cancelled.some(
      (update) => update.type === "task.completed" && update.payload.status === "stopped",
    ),
  );
});

it("does not attach background children to a later parent turn or treat spawn as completion", () => {
  const normalizer = makePiSubagentEvents({ runtimeId: "background" });
  normalizer.accept({ event: event([session()]) });
  const linkage = normalizer.accept({
    event: {
      type: "tool_execution_end",
      toolName: "subagent_spawn",
      toolCallId: "launch",
      result: { details: { id: "sa-1" } },
    },
    turnId: TurnId.make("later"),
  });
  assert.equal(linkage[0]?.payload.toolUseId, "launch");
  assert.isUndefined(linkage[0]?.turnId);
  assert.equal(normalizer.hasLiveTasks(), true);
  const done = normalizer.accept({
    event: event([session({ status: "done", terminalReason: "completed" })], 2),
    turnId: TurnId.make("later"),
  });
  assert.isUndefined(done.at(-1)?.turnId);
});

it("feeds the existing ingestion and agent panel with two independently settled children", () => {
  const normalizer = makePiSubagentEvents({ runtimeId: "panel" });
  const updates = [
    ...normalizer.accept({ event: event([session(), session({ id: "sa-2", title: "Review" })]) }),
    ...normalizer.accept({
      event: event(
        [
          session({ status: "done", terminalReason: "completed" }),
          session({ id: "sa-2", title: "Review", status: "error", terminalReason: "cancelled" }),
        ],
        2,
      ),
    }),
  ];
  const decode = Schema.decodeUnknownSync(ProviderRuntimeEvent);
  const activities = updates.flatMap((update, index) =>
    runtimeEventToActivities(
      decode({
        ...update,
        eventId: EventId.make(`event-${index}`),
        threadId: ThreadId.make("thread"),
        provider: ProviderDriverKind.make("pi"),
        providerInstanceId: ProviderInstanceId.make("pi"),
        createdAt: "2026-09-11T10:00:00.000Z",
      }),
    ),
  );
  const panel = deriveAgentPanelModel({ agents: foldSubagentActivities(activities) });
  assert.equal(panel.directAgents.length, 2);
  assert.deepEqual(
    panel.directAgents.map((agent) => agent.status),
    ["completed", "cancelled"],
  );
  assert.equal(panel.runningCount, 0);
  assert.equal(panel.settledCount, 2);
  assert.equal(panel.totalTokens, 20);
});

it.each([-1, 1.5, "2"])("ignores invalid snapshot sequence %s", (sequence) => {
  const normalizer = makePiSubagentEvents({ runtimeId: "invalid" });
  const invalid: PiRpcEvent = {
    type: "extension_ui_request",
    method: "setStatus",
    statusKey: "t3-subagents:v1",
    statusText: JSON.stringify({ protocolVersion: 1, sequence, sessions: [session()] }),
  };
  assert.deepEqual(normalizer.accept({ event: invalid }), []);
  assert.equal(normalizer.hasLiveTasks(), false);
});
