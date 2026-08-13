// @effect-diagnostics nodeBuiltinImport:off
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as Cause from "effect/Cause";

import { assert, it } from "@effect/vitest";
import { ProviderDriverKind, ProviderInstanceId, ThreadId, TurnId } from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";

import type { PiRpcCommand, PiRpcEvent, PiRpcExtensionUiResponse } from "./PiRpcContract.ts";
import { PiRpcRequestError } from "./PiRpcErrors.ts";
import type { PiImageAttachmentReader } from "./PiImageAttachments.ts";
import type { PiResumeCursor, PiSession, PiSessionManager } from "./PiSessionManager.ts";
import { makePiAdapter } from "./PiAdapter.ts";

const PI = ProviderDriverKind.make("pi");
const INSTANCE = ProviderInstanceId.make("pi");

interface PiSessionDouble {
  readonly manager: PiSessionManager;
  readonly requests: Array<PiRpcCommand>;
  readonly uiResponses: Array<PiRpcExtensionUiResponse>;
  readonly push: (event: PiRpcEvent) => Effect.Effect<void>;
  readonly terminate: () => Effect.Effect<void>;
}

const makeSessionDouble = Effect.fn("makePiSessionDouble")(function* (
  threadId: ThreadId,
  options: { readonly failCommand?: string; readonly stateModel?: unknown } = {},
): Effect.fn.Return<PiSessionDouble> {
  const eventQueue = yield* Queue.unbounded<PiRpcEvent, Cause.Done<void>>();
  const owned = yield* Ref.make(true);
  const requests: Array<PiRpcCommand> = [];
  const uiResponses: Array<PiRpcExtensionUiResponse> = [];
  const cursor: PiResumeCursor = {
    schemaVersion: 1,
    threadId,
    sessionId: "pi-test-session",
    sessionDir: "/tmp/pi-test",
    cwd: "/tmp/project",
    piVersion: "0.84.1",
    messageCount: 0,
  };

  const session: PiSession = {
    threadId,
    sessionId: cursor.sessionId,
    cwd: cursor.cwd,
    sessionDir: cursor.sessionDir,
    request: (command) =>
      Effect.gen(function* () {
        requests.push(command);
        if (options.failCommand === command.type) {
          return yield* new PiRpcRequestError({
            command: command.type,
            detail: `test Pi request failed: ${command.type}`,
          });
        }
        return {
          type: "response",
          id: "pi-test-response",
          command: command.type,
          success: true,
          ...(command.type === "get_state"
            ? {
                data: {
                  sessionId: cursor.sessionId,
                  ...(options.stateModel === undefined ? {} : { model: options.stateModel }),
                },
              }
            : {}),
        };
      }),
    send: (message) =>
      Effect.sync(() => {
        uiResponses.push(message);
      }),
    events: Stream.fromQueue(eventQueue),
    stderr: Effect.succeed(""),
    getResumeCursor: () => Effect.succeed(cursor),
    refresh: () => Effect.succeed(cursor),
    close: Effect.void,
  };

  return {
    manager: {
      start: () => Effect.succeed(session),
      get: () => Effect.succeed(Option.some(session)),
      has: () => Ref.get(owned),
      list: () => Effect.succeed([session]),
      stop: () => Ref.set(owned, false),
      stopAll: () => Ref.set(owned, false),
    },
    requests,
    uiResponses,
    push: (event) => Queue.offer(eventQueue, event).pipe(Effect.asVoid),
    terminate: () =>
      Effect.gen(function* () {
        yield* Ref.set(owned, false);
        yield* Queue.end(eventQueue);
      }).pipe(Effect.asVoid),
  };
});

const makeTestAdapter = (
  sessionDouble: PiSessionDouble,
  options: { readonly attachmentReader?: PiImageAttachmentReader } = {},
) =>
  makePiAdapter({
    sessionManager: sessionDouble.manager,
    instanceId: INSTANCE,
    ...(options.attachmentReader === undefined
      ? {}
      : { attachmentReader: options.attachmentReader }),
    makeId: (() => {
      let index = 0;
      return () => `pi-test-id-${index++}`;
    })(),
  });

const startInput = (threadId: ThreadId) => ({
  provider: PI,
  providerInstanceId: INSTANCE,
  threadId,
  cwd: "/tmp/project",
  runtimeMode: "full-access" as const,
});

const imageAttachment = {
  type: "image" as const,
  id: "pi-images-00000000-0000-4000-8000-000000000001",
  name: "diagram.png",
  mimeType: "image/png",
  sizeBytes: 3,
};

const imageReader: PiImageAttachmentReader = {
  attachmentsDir: "/tmp/pi-images",
  readFile: () => Effect.succeed(Uint8Array.from([1, 2, 3])),
};

it.effect("sends text and ordered images through the Pi prompt command", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const threadId = ThreadId.make("pi-adapter-images");
      const sessionDouble = yield* makeSessionDouble(threadId);
      const adapter = yield* makeTestAdapter(sessionDouble, {
        attachmentReader: imageReader,
      });

      yield* adapter.startSession(startInput(threadId));
      yield* adapter.sendTurn({
        threadId,
        input: "describe this",
        attachments: [imageAttachment],
      });

      assert.deepEqual(sessionDouble.requests, [
        {
          type: "get_state",
        },
        {
          type: "prompt",
          message: "describe this",
          images: [{ type: "image", data: "AQID", mimeType: "image/png" }],
        },
      ]);
    }),
  ),
);

it.effect("allows a prompt containing only an image", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const threadId = ThreadId.make("pi-adapter-image-only");
      const sessionDouble = yield* makeSessionDouble(threadId);
      const adapter = yield* makeTestAdapter(sessionDouble, {
        attachmentReader: imageReader,
      });

      yield* adapter.startSession(startInput(threadId));
      yield* adapter.sendTurn({
        threadId,
        attachments: [imageAttachment],
      });

      assert.deepEqual(sessionDouble.requests.at(-1), {
        type: "prompt",
        message: "",
        images: [{ type: "image", data: "AQID", mimeType: "image/png" }],
      });
    }),
  ),
);

it.effect("rejects images when the current Pi model explicitly lacks image input", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const threadId = ThreadId.make("pi-adapter-no-image-input");
      const sessionDouble = yield* makeSessionDouble(threadId, {
        stateModel: { input: ["text"] },
      });
      const adapter = yield* makeTestAdapter(sessionDouble, {
        attachmentReader: imageReader,
      });

      yield* adapter.startSession(startInput(threadId));
      const error = yield* Effect.flip(
        adapter.sendTurn({
          threadId,
          input: "inspect",
          attachments: [imageAttachment],
        }),
      );

      assert.equal(error._tag, "ProviderAdapterValidationError");
      if (error._tag === "ProviderAdapterValidationError") {
        assert.include(error.issue, "image input");
      }
      assert.deepEqual(sessionDouble.requests, [{ type: "get_state" }]);
      assert.equal((yield* adapter.listSessions())[0]?.status, "ready");
    }),
  ),
);

it.effect("keeps the session recoverable when Pi rejects an image prompt", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const threadId = ThreadId.make("pi-adapter-image-error");
      const sessionDouble = yield* makeSessionDouble(threadId, { failCommand: "prompt" });
      const adapter = yield* makeTestAdapter(sessionDouble, {
        attachmentReader: imageReader,
      });
      const eventsFiber = yield* adapter.streamEvents.pipe(
        Stream.filter((event) => event.threadId === threadId),
        Stream.takeUntil((event) => event.type === "turn.completed"),
        Stream.runCollect,
        Effect.forkScoped,
      );
      yield* Effect.yieldNow;

      yield* adapter.startSession(startInput(threadId));
      const error = yield* Effect.flip(
        adapter.sendTurn({
          threadId,
          input: "this image prompt fails",
          attachments: [imageAttachment],
        }),
      );
      const events = yield* Fiber.join(eventsFiber);

      assert.equal(error._tag, "ProviderAdapterRequestError");
      assert.equal(events.at(-1)?.type, "turn.completed");
      assert.equal(yield* adapter.hasSession(threadId), true);
      assert.equal((yield* adapter.listSessions())[0]?.status, "ready");
      assert.isUndefined((yield* adapter.listSessions())[0]?.activeTurnId);
    }),
  ),
);

it.effect("maps Pi events and settles only on agent_settled", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const threadId = ThreadId.make("pi-adapter-events");
      const sessionDouble = yield* makeSessionDouble(threadId);
      const adapter = yield* makeTestAdapter(sessionDouble);
      const eventsFiber = yield* adapter.streamEvents.pipe(
        Stream.filter((event) => event.threadId === threadId),
        Stream.takeUntil((event) => event.type === "turn.completed"),
        Stream.runCollect,
        Effect.forkScoped,
      );
      yield* Effect.yieldNow;

      yield* adapter.startSession(startInput(threadId));
      const selection = createModelSelection(INSTANCE, "openai/gpt-5.6-luna", [
        { id: "thinking", value: "high" },
      ]);
      const turn = yield* adapter.sendTurn({
        threadId,
        input: "hello Pi",
        modelSelection: selection,
      });

      yield* sessionDouble.push({
        type: "message_update",
        assistantMessageEvent: { type: "text_start", contentIndex: 0 },
      });
      yield* sessionDouble.push({
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "hello" },
      });
      yield* sessionDouble.push({
        type: "message_update",
        assistantMessageEvent: { type: "thinking_start", contentIndex: 1 },
      });
      yield* sessionDouble.push({
        type: "message_update",
        assistantMessageEvent: { type: "thinking_delta", contentIndex: 1, delta: "plan" },
      });
      yield* sessionDouble.push({
        type: "message_end",
        message: {
          role: "assistant",
          content: [
            { type: "text", text: "hello" },
            { type: "thinking", thinking: "plan" },
          ],
          stopReason: "stop",
        },
      });
      yield* sessionDouble.push({ type: "turn_end" });
      yield* sessionDouble.push({
        type: "tool_execution_start",
        toolCallId: "tool-1",
        toolName: "bash",
        args: { command: "pwd" },
      });
      yield* sessionDouble.push({
        type: "tool_execution_update",
        toolCallId: "tool-1",
        toolName: "bash",
        partialResult: " /tmp/project",
      });
      yield* sessionDouble.push({
        type: "tool_execution_end",
        toolCallId: "tool-1",
        toolName: "bash",
        result: "/tmp/project",
        isError: true,
      });
      yield* sessionDouble.push({
        type: "tool_execution_start",
        toolCallId: "tool-2",
        toolName: "subagent_spawn",
        args: { prompt: "inspect the repository" },
      });
      yield* sessionDouble.push({
        type: "tool_execution_end",
        toolCallId: "tool-2",
        toolName: "subagent_spawn",
        result: { agentId: "child-1" },
        isError: false,
      });
      yield* sessionDouble.push({ type: "agent_settled" });

      const events = yield* Fiber.join(eventsFiber);
      assert.equal(turn.turnId, TurnId.make("pi-test-id-3"));
      assert.deepEqual(
        sessionDouble.requests.map((request) => request.type),
        ["set_model", "set_thinking_level", "prompt"],
      );
      assert.deepEqual(
        events.map((event) => event.type),
        [
          "session.started",
          "thread.started",
          "session.state.changed",
          "turn.started",
          "item.started",
          "content.delta",
          "item.started",
          "content.delta",
          "item.completed",
          "item.completed",
          "item.started",
          "item.updated",
          "item.completed",
          "item.started",
          "item.completed",
          "turn.completed",
        ],
      );

      const contentDelta = events.find((event) => event.type === "content.delta");
      assert.equal(contentDelta?.type, "content.delta");
      if (contentDelta?.type === "content.delta") {
        assert.equal(contentDelta.payload.streamKind, "assistant_text");
        assert.equal(contentDelta.payload.delta, "hello");
      }

      const toolCompleted = events.find(
        (event) => event.type === "item.completed" && event.itemId?.includes("tool-1"),
      );
      assert.equal(toolCompleted?.type, "item.completed");
      if (toolCompleted?.type === "item.completed") {
        assert.equal(toolCompleted.payload.itemType, "command_execution");
        assert.equal(toolCompleted.payload.status, "failed");
      }
      const subagentEvent = events.find(
        (event) => event.type === "item.started" && event.payload.title === "subagent_spawn",
      );
      assert.equal(subagentEvent?.type, "item.started");
      if (subagentEvent?.type === "item.started") {
        assert.equal(subagentEvent.payload.itemType, "collab_agent_tool_call");
      }
      assert.equal(
        events.some((event) => event.type.startsWith("task.")),
        false,
      );
      const snapshot = yield* adapter.readThread(threadId);
      assert.equal(snapshot.turns.length, 1);
      assert.equal(yield* adapter.hasSession(threadId), true);
      assert.equal((yield* adapter.listSessions())[0]?.status, "ready");
    }),
  ),
);

it.effect("cancels blocking extension UI and keeps the Pi turn alive", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const threadId = ThreadId.make("pi-adapter-ui");
      const sessionDouble = yield* makeSessionDouble(threadId);
      const adapter = yield* makeTestAdapter(sessionDouble);
      const warningFiber = yield* adapter.streamEvents.pipe(
        Stream.filter((event) => event.type === "runtime.warning"),
        Stream.take(1),
        Stream.runCollect,
        Effect.forkScoped,
      );

      yield* adapter.startSession(startInput(threadId));
      yield* sessionDouble.push({
        type: "extension_ui_request",
        id: "ui-1",
        method: "confirm",
      });

      const warnings = yield* Fiber.join(warningFiber);
      assert.equal(sessionDouble.uiResponses.length, 1);
      assert.deepEqual(sessionDouble.uiResponses[0], {
        type: "extension_ui_response",
        id: "ui-1",
        cancelled: true,
      });
      assert.equal(warnings[0]?.type, "runtime.warning");
      if (warnings[0]?.type === "runtime.warning") {
        assert.include(warnings[0].payload.message, "blocking extension UI");
      }
      yield* adapter.stopSession(threadId);
      assert.equal(yield* adapter.hasSession(threadId), false);
    }),
  ),
);

it.effect("keeps the session recoverable after a local prompt request error", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const threadId = ThreadId.make("pi-adapter-prompt-error");
      const sessionDouble = yield* makeSessionDouble(threadId, { failCommand: "prompt" });
      const adapter = yield* makeTestAdapter(sessionDouble);
      const eventsFiber = yield* adapter.streamEvents.pipe(
        Stream.filter((event) => event.threadId === threadId),
        Stream.takeUntil((event) => event.type === "turn.completed"),
        Stream.runCollect,
        Effect.forkScoped,
      );
      yield* Effect.yieldNow;

      yield* adapter.startSession(startInput(threadId));
      const error = yield* Effect.flip(
        adapter.sendTurn({ threadId, input: "this prompt fails locally" }),
      );
      const events = yield* Fiber.join(eventsFiber);

      assert.equal(error._tag, "ProviderAdapterRequestError");
      assert.equal(events.at(-1)?.type, "turn.completed");
      assert.equal(yield* adapter.hasSession(threadId), true);
      assert.equal((yield* adapter.listSessions())[0]?.status, "ready");
      assert.isUndefined((yield* adapter.listSessions())[0]?.activeTurnId);
    }),
  ),
);

it.effect("maps abort to turn.aborted and exposes unsupported Pi operations as typed errors", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const threadId = ThreadId.make("pi-adapter-abort");
      const sessionDouble = yield* makeSessionDouble(threadId);
      const adapter = yield* makeTestAdapter(sessionDouble);
      const eventsFiber = yield* adapter.streamEvents.pipe(
        Stream.filter((event) => event.threadId === threadId),
        Stream.takeUntil((event) => event.type === "turn.aborted"),
        Stream.runCollect,
        Effect.forkScoped,
      );

      yield* adapter.startSession(startInput(threadId));
      const turn = yield* adapter.sendTurn({ threadId, input: "interrupt me" });
      yield* adapter.interruptTurn(threadId, turn.turnId);
      yield* sessionDouble.push({ type: "agent_settled" });

      const events = yield* Fiber.join(eventsFiber);
      assert.equal(events.at(-1)?.type, "turn.aborted");
      assert.equal(
        events.some((event) => event.type === "turn.completed"),
        false,
      );
      assert.equal(sessionDouble.requests.at(-1)?.type, "abort");

      const rollback = yield* adapter.rollbackThread(threadId, 1).pipe(Effect.exit);
      assert.equal(rollback._tag, "Failure");
    }),
  ),
);

it.effect("reports a dead Pi process and removes only the active session", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const threadId = ThreadId.make("pi-adapter-dead-process");
      const sessionDouble = yield* makeSessionDouble(threadId);
      const adapter = yield* makeTestAdapter(sessionDouble);
      const eventsFiber = yield* adapter.streamEvents.pipe(
        Stream.filter((event) => event.threadId === threadId),
        Stream.takeUntil((event) => event.type === "session.exited"),
        Stream.runCollect,
        Effect.forkScoped,
      );
      yield* Effect.yieldNow;

      yield* adapter.startSession(startInput(threadId));
      yield* sessionDouble.terminate();

      const events = yield* Fiber.join(eventsFiber);
      assert.equal(
        events.some((event) => event.type === "runtime.error"),
        true,
      );
      assert.equal(events.at(-1)?.type, "session.exited");
      assert.equal(yield* adapter.hasSession(threadId), false);
      assert.deepEqual(yield* adapter.listSessions(), []);
    }),
  ),
);
