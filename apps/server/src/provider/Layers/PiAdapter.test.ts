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
import { PiRpcRequestError, PiRpcRequestTimeoutError } from "./PiRpcErrors.ts";
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

interface PiCommandFixture {
  readonly name: string;
  readonly source: "extension" | "prompt" | "skill";
  readonly sourceInfo: { readonly path?: string; readonly [key: string]: unknown };
}

const makeSessionDouble = Effect.fn("makePiSessionDouble")(function* (
  threadId: ThreadId,
  options: {
    readonly failCommand?: string;
    readonly stateModel?: unknown;
    /** Command whose ack never arrives, mimicking a Pi busy in preflight. */
    readonly timeoutCommand?: string;
    /** How many of those commands succeed before the deadline fires. */
    readonly timeoutAfter?: number;
    readonly stderr?: string;
    readonly commands?: ReadonlyArray<PiCommandFixture>;
  } = {},
): Effect.fn.Return<PiSessionDouble> {
  const eventQueue = yield* Queue.unbounded<PiRpcEvent, Cause.Done<void>>();
  const owned = yield* Ref.make(true);
  const requests: Array<PiRpcCommand> = [];
  const timeoutCounts = new Map<string, number>();
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
        if (options.timeoutCommand === command.type) {
          const seen = (timeoutCounts.get(command.type) ?? 0) + 1;
          timeoutCounts.set(command.type, seen);
          if (seen > (options.timeoutAfter ?? 0)) {
            return yield* new PiRpcRequestTimeoutError({
              command: command.type,
              timeoutMs: 600_000,
            });
          }
        }
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
            : command.type === "get_commands"
              ? { data: { commands: options.commands ?? [] } }
              : {}),
        };
      }),
    send: (message) =>
      Effect.sync(() => {
        uiResponses.push(message);
      }),
    events: Stream.fromQueue(eventQueue),
    stderr: Effect.succeed(options.stderr ?? ""),
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
  options: {
    readonly attachmentReader?: PiImageAttachmentReader;
    readonly skillFiles?: Readonly<Record<string, string>>;
    readonly skillReader?: (path: string) => Effect.Effect<string, Error>;
  } = {},
) =>
  makePiAdapter({
    sessionManager: sessionDouble.manager,
    instanceId: INSTANCE,
    ...(options.attachmentReader === undefined
      ? {}
      : { attachmentReader: options.attachmentReader }),
    ...(options.skillReader !== undefined
      ? { skillReader: options.skillReader }
      : options.skillFiles === undefined
        ? {}
        : { skillReader: (path: string) => Effect.succeed(options.skillFiles?.[path] ?? "") }),
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

// Large pastes arrive as file attachments; their path is already in the prompt.
const pastedTextAttachment = {
  type: "file" as const,
  id: "pi-images-00000000-0000-4000-8000-000000000002",
  name: "pasted.txt",
  mimeType: "text/plain",
  sizeBytes: 3,
};

const imageReader: PiImageAttachmentReader = {
  attachmentsDir: "/tmp/pi-images",
  readFile: () => Effect.succeed(Uint8Array.from([1, 2, 3])),
};

const skillCommand = (
  name: string,
  path: string,
  source: "extension" | "prompt" | "skill" = "skill",
): PiCommandFixture => ({
  name: source === "skill" ? `skill:${name}` : name,
  source,
  sourceInfo: { path, scope: "project", origin: "top-level" },
});

it.effect("expands ordered, repeated, and inline Pi skill mentions", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const threadId = ThreadId.make("pi-adapter-skill-composition");
      const alphaPath = "/tmp/project/.pi/skills/alpha/SKILL.md";
      const betaPath = "/tmp/project/.pi/skills/beta/SKILL.md";
      const sessionDouble = yield* makeSessionDouble(threadId, {
        commands: [skillCommand("alpha", alphaPath), skillCommand("beta", betaPath)],
      });
      const adapter = yield* makeTestAdapter(sessionDouble, {
        attachmentReader: imageReader,
        skillFiles: {
          [alphaPath]: "---\nname: ignored\n---\n\nAlpha body\n",
          [betaPath]: "---\ndescription: beta\n---\nBeta body",
        },
      });

      yield* adapter.startSession(startInput(threadId));
      yield* adapter.sendTurn({
        threadId,
        input: "before $beta ＄alpha $beta $HOME after",
        attachments: [imageAttachment, pastedTextAttachment],
      });

      assert.deepEqual(sessionDouble.requests, [
        { type: "get_commands" },
        {
          type: "get_state",
        },
        {
          type: "prompt",
          message:
            'before $beta ＄alpha $beta $HOME after\n\n<skill name="beta" location="/tmp/project/.pi/skills/beta/SKILL.md">\nReferences are relative to /tmp/project/.pi/skills/beta.\n\nBeta body\n</skill>\n\n<skill name="alpha" location="/tmp/project/.pi/skills/alpha/SKILL.md">\nReferences are relative to /tmp/project/.pi/skills/alpha.\n\nAlpha body\n</skill>',
          images: [{ type: "image", data: "AQID", mimeType: "image/png" }],
          streamingBehavior: "steer",
        },
      ]);
    }),
  ),
);

it.effect("preserves native commands and validates a leading native skill in mixed input", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const threadId = ThreadId.make("pi-adapter-native-skill-command");
      const alphaPath = "/tmp/project/.pi/skills/alpha/SKILL.md";
      const betaPath = "/tmp/project/.pi/skills/beta/SKILL.md";
      const sessionDouble = yield* makeSessionDouble(threadId, {
        commands: [
          { name: "llama", source: "extension", sourceInfo: {} },
          skillCommand("review", "/tmp/project/.pi/extensions/review.ts", "extension"),
          skillCommand("template", "/tmp/project/.pi/prompts/template.md", "prompt"),
          skillCommand("alpha", alphaPath),
          skillCommand("beta", betaPath),
        ],
      });
      const adapter = yield* makeTestAdapter(sessionDouble, {
        skillFiles: { [alphaPath]: "Alpha body", [betaPath]: "Beta body" },
      });

      yield* adapter.startSession(startInput(threadId));
      yield* adapter.sendTurn({ threadId, input: "/review $beta" });
      assert.deepEqual(sessionDouble.requests.at(-1), {
        type: "prompt",
        message: "/review $beta",
        streamingBehavior: "steer",
      });

      const secondThreadId = ThreadId.make("pi-adapter-native-skill-mixed");
      const secondSessionDouble = yield* makeSessionDouble(secondThreadId, {
        commands: [skillCommand("alpha", alphaPath), skillCommand("beta", betaPath)],
      });
      const secondAdapter = yield* makeTestAdapter(secondSessionDouble, {
        skillFiles: { [alphaPath]: "Alpha body", [betaPath]: "Beta body" },
      });
      yield* secondAdapter.startSession(startInput(secondThreadId));
      yield* secondAdapter.sendTurn({ threadId: secondThreadId, input: "/skill:alpha text $beta" });
      assert.deepEqual(secondSessionDouble.requests.at(-1), {
        type: "prompt",
        message:
          '/skill:alpha text $beta\n\n<skill name="beta" location="/tmp/project/.pi/skills/beta/SKILL.md">\nReferences are relative to /tmp/project/.pi/skills/beta.\n\nBeta body\n</skill>',
        streamingBehavior: "steer",
      });
      assert.deepEqual(
        secondSessionDouble.requests.filter((command) => command.type === "get_commands"),
        [{ type: "get_commands" }],
      );
    }),
  ),
);

it.effect("preserves template arguments across space, newline, and tab separators", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const threadId = ThreadId.make("pi-adapter-template-whitespace");
      const betaPath = "/tmp/project/.pi/skills/beta/SKILL.md";
      const sessionDouble = yield* makeSessionDouble(threadId, {
        commands: [
          skillCommand("template", "/tmp/project/.pi/prompts/template.md", "prompt"),
          skillCommand("beta", betaPath),
        ],
      });
      const reads: Array<string> = [];
      const adapter = yield* makeTestAdapter(sessionDouble, {
        skillReader: (path) => {
          reads.push(path);
          return Effect.fail(
            new PiRpcRequestError({
              command: "read_skill",
              detail: `unreadable skill ${path}`,
            }),
          );
        },
      });

      yield* adapter.startSession(startInput(threadId));
      for (const input of ["/template $beta", "/template\n$beta", "/template\t$beta"]) {
        yield* adapter.sendTurn({ threadId, input });
        assert.deepEqual(sessionDouble.requests.at(-1), {
          type: "prompt",
          message: input,
          streamingBehavior: "steer",
        });
      }
      assert.deepEqual(reads, []);
    }),
  ),
);

it.effect("expands mentions when whitespace prevents a literal native command from matching", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const threadId = ThreadId.make("pi-adapter-literal-command-whitespace");
      const alphaPath = "/tmp/project/.pi/skills/alpha/SKILL.md";
      const sessionDouble = yield* makeSessionDouble(threadId, {
        commands: [
          { name: "review", source: "extension", sourceInfo: {} },
          skillCommand("alpha", alphaPath),
        ],
      });
      const adapter = yield* makeTestAdapter(sessionDouble, {
        skillFiles: { [alphaPath]: "Alpha body" },
      });

      yield* adapter.startSession(startInput(threadId));
      for (const input of [
        "/review\n $alpha",
        "/review\t $alpha",
        "/skill:alpha\n $alpha",
        "/skill:alpha\t $alpha",
      ]) {
        yield* adapter.sendTurn({ threadId, input });
        assert.deepEqual(sessionDouble.requests.at(-1), {
          type: "prompt",
          message:
            `${input}\n\n<skill name="alpha" location="/tmp/project/.pi/skills/alpha/SKILL.md">\n` +
            "References are relative to /tmp/project/.pi/skills/alpha.\n\nAlpha body\n</skill>",
          streamingBehavior: "steer",
        });
      }
    }),
  ),
);

it.effect("keeps native skill expansion ahead of a colliding template name", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const threadId = ThreadId.make("pi-adapter-skill-template-collision");
      const alphaPath = "/tmp/project/.pi/skills/alpha/SKILL.md";
      const betaPath = "/tmp/project/.pi/skills/beta/SKILL.md";
      const sessionDouble = yield* makeSessionDouble(threadId, {
        commands: [
          skillCommand("alpha", alphaPath),
          {
            name: "skill:alpha",
            source: "prompt",
            sourceInfo: { path: "/tmp/project/.pi/prompts/skill:alpha.md", origin: "top-level" },
          },
          skillCommand("beta", betaPath),
        ],
      });
      const adapter = yield* makeTestAdapter(sessionDouble, {
        skillFiles: { [alphaPath]: "Alpha body", [betaPath]: "Beta body" },
      });

      yield* adapter.startSession(startInput(threadId));
      yield* adapter.sendTurn({ threadId, input: "/skill:alpha $beta" });
      assert.deepEqual(sessionDouble.requests.at(-1), {
        type: "prompt",
        message:
          '/skill:alpha $beta\n\n<skill name="beta" location="/tmp/project/.pi/skills/beta/SKILL.md">\nReferences are relative to /tmp/project/.pi/skills/beta.\n\nBeta body\n</skill>',
        streamingBehavior: "steer",
      });
    }),
  ),
);

it.effect("gives colliding extension commands priority with intact arguments", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const threadId = ThreadId.make("pi-adapter-extension-priority");
      const alphaPath = "/tmp/project/.pi/skills/alpha/SKILL.md";
      const betaPath = "/tmp/project/.pi/skills/beta/SKILL.md";
      const sessionDouble = yield* makeSessionDouble(threadId, {
        commands: [
          { name: "skill:alpha", source: "extension", sourceInfo: {} },
          skillCommand("alpha", alphaPath),
          skillCommand("beta", betaPath),
        ],
      });
      const reads: Array<string> = [];
      const adapter = yield* makeTestAdapter(sessionDouble, {
        skillReader: (path) => {
          reads.push(path);
          return Effect.succeed("should not be read");
        },
      });

      yield* adapter.startSession(startInput(threadId));
      yield* adapter.sendTurn({ threadId, input: "/skill:alpha $beta" });
      assert.deepEqual(sessionDouble.requests.at(-1), {
        type: "prompt",
        message: "/skill:alpha $beta",
        streamingBehavior: "steer",
      });
      assert.deepEqual(reads, []);
    }),
  ),
);

it.effect("treats a skill-named template as a template when that skill is absent", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const threadId = ThreadId.make("pi-adapter-template-without-skill");
      const betaPath = "/tmp/project/.pi/skills/beta/SKILL.md";
      const sessionDouble = yield* makeSessionDouble(threadId, {
        commands: [
          {
            name: "skill:alpha",
            source: "prompt",
            sourceInfo: { path: "/tmp/project/.pi/prompts/skill:alpha.md", origin: "top-level" },
          },
          skillCommand("beta", betaPath),
        ],
      });
      const adapter = yield* makeTestAdapter(sessionDouble, {
        skillFiles: { [betaPath]: "Beta body" },
      });

      yield* adapter.startSession(startInput(threadId));
      yield* adapter.sendTurn({ threadId, input: "/skill:alpha $beta" });
      assert.deepEqual(sessionDouble.requests.at(-1), {
        type: "prompt",
        message: "/skill:alpha $beta",
        streamingBehavior: "steer",
      });
    }),
  ),
);

it.effect("does not duplicate a leading native skill that is also mentioned", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const threadId = ThreadId.make("pi-adapter-native-skill-self-mention");
      const alphaPath = "/tmp/project/.pi/skills/alpha/SKILL.md";
      const sessionDouble = yield* makeSessionDouble(threadId, {
        commands: [skillCommand("alpha", alphaPath)],
      });
      const adapter = yield* makeTestAdapter(sessionDouble, {
        skillFiles: { [alphaPath]: "Alpha body" },
      });

      yield* adapter.startSession(startInput(threadId));
      yield* adapter.sendTurn({ threadId, input: "/skill:alpha intro $alpha" });
      assert.deepEqual(sessionDouble.requests.at(-1), {
        type: "prompt",
        message: "/skill:alpha intro $alpha",
        streamingBehavior: "steer",
      });
    }),
  ),
);

it.effect("fails get_commands decode before starting a turn", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const threadId = ThreadId.make("pi-adapter-invalid-catalog");
      const sessionDouble = yield* makeSessionDouble(threadId, {
        commands: [{ name: "skill:alpha", source: "skill", sourceInfo: {} }],
      });
      const adapter = yield* makeTestAdapter(sessionDouble, {
        skillFiles: {},
      });

      yield* adapter.startSession(startInput(threadId));
      const error = yield* Effect.flip(adapter.sendTurn({ threadId, input: "use $alpha" }));

      assert.equal(error._tag, "ProviderAdapterRequestError");
      if (error._tag === "ProviderAdapterRequestError") {
        assert.equal(error.method, "get_commands");
      }
      assert.deepEqual(sessionDouble.requests, [{ type: "get_commands" }]);
      assert.equal((yield* adapter.listSessions())[0]?.status, "ready");
      assert.isUndefined((yield* adapter.listSessions())[0]?.activeTurnId);
    }),
  ),
);

it.effect("fails skill preparation before starting a turn when a skill file is missing", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const threadId = ThreadId.make("pi-adapter-skill-missing");
      const alphaPath = "/tmp/project/.pi/skills/alpha/SKILL.md";
      const sessionDouble = yield* makeSessionDouble(threadId, {
        commands: [skillCommand("alpha", alphaPath)],
      });
      const adapter = yield* makeTestAdapter(sessionDouble, {
        skillReader: () =>
          Effect.fail(
            new PiRpcRequestError({
              command: "read_skill",
              detail: "ENOENT: no such file or directory, open skill",
            }),
          ),
      });

      yield* adapter.startSession(startInput(threadId));
      const error = yield* Effect.flip(adapter.sendTurn({ threadId, input: "use $alpha" }));

      assert.equal(error._tag, "ProviderAdapterRequestError");
      if (error._tag === "ProviderAdapterRequestError") {
        assert.equal(error.method, "skills/read");
        assert.include(error.detail, alphaPath);
      }
      assert.deepEqual(sessionDouble.requests, [{ type: "get_commands" }]);
      assert.equal((yield* adapter.listSessions())[0]?.status, "ready");
      assert.isUndefined((yield* adapter.listSessions())[0]?.activeTurnId);
    }),
  ),
);

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
          streamingBehavior: "steer",
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
        streamingBehavior: "steer",
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

it.effect("announces a Pi compaction and closes it on the compacted thread state", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const threadId = ThreadId.make("pi-adapter-compaction");
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
      const turn = yield* adapter.sendTurn({ threadId, input: "keep going" });
      yield* sessionDouble.push({ type: "compaction_start", reason: "threshold" });
      yield* sessionDouble.push({
        type: "compaction_end",
        reason: "threshold",
        aborted: false,
        result: { tokensBefore: 120000, estimatedTokensAfter: 20000 },
      });
      yield* sessionDouble.push({ type: "agent_settled" });
      const events = yield* Fiber.join(eventsFiber);

      const started = events.find((event) => event.type === "runtime.warning");
      if (started?.type === "runtime.warning") {
        assert.include(started.payload.message, "compacting");
        // The notice belongs to the turn that is waiting on the compaction.
        assert.equal(String(started.turnId), String(turn.turnId));
      } else {
        assert.fail("expected a compaction notice");
      }

      const compacted = events.find((event) => event.type === "thread.state.changed");
      if (compacted?.type === "thread.state.changed") {
        assert.equal(compacted.payload.state, "compacted");
        assert.deepEqual(compacted.payload.detail, {
          tokensBefore: 120000,
          estimatedTokensAfter: 20000,
        });
      } else {
        assert.fail("expected a compacted thread state");
      }
    }),
  ),
);

it.effect("reports an aborted compaction instead of claiming the thread compacted", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const threadId = ThreadId.make("pi-adapter-compaction-aborted");
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
      yield* adapter.sendTurn({ threadId, input: "keep going" });
      yield* sessionDouble.push({ type: "compaction_start", reason: "overflow" });
      yield* sessionDouble.push({ type: "compaction_end", reason: "overflow", aborted: true });
      yield* sessionDouble.push({ type: "agent_settled" });
      const events = yield* Fiber.join(eventsFiber);

      assert.isUndefined(events.find((event) => event.type === "thread.state.changed"));
      const notices = events.filter((event) => event.type === "runtime.warning");
      assert.equal(notices.length, 2);
      if (notices.at(-1)?.type === "runtime.warning") {
        assert.include(notices.at(-1)?.payload.message, "aborted");
      }
    }),
  ),
);

it.effect("aborts the Pi run when the prompt ack times out", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const threadId = ThreadId.make("pi-adapter-prompt-timeout");
      const sessionDouble = yield* makeSessionDouble(threadId, {
        timeoutCommand: "prompt",
        stderr: "pi: compaction retry 2/3\n",
      });
      const adapter = yield* makeTestAdapter(sessionDouble);
      const eventsFiber = yield* adapter.streamEvents.pipe(
        Stream.filter((event) => event.threadId === threadId),
        Stream.takeUntil((event) => event.type === "turn.completed"),
        Stream.runCollect,
        Effect.forkScoped,
      );
      yield* Effect.yieldNow;

      yield* adapter.startSession(startInput(threadId));
      const error = yield* Effect.flip(adapter.sendTurn({ threadId, input: "keep going" }));
      const events = yield* Fiber.join(eventsFiber);

      assert.equal(error._tag, "ProviderAdapterRequestError");
      if (error._tag === "ProviderAdapterRequestError") {
        // The Pi side of the story travels with the failure.
        assert.include(error.detail, "pi stderr: pi: compaction retry 2/3");
      }
      // T3 declared the turn dead, so Pi is told to stop too.
      assert.deepEqual(sessionDouble.requests.at(-1), { type: "abort" });
      const completed = events.at(-1);
      if (completed?.type === "turn.completed") {
        assert.equal(completed.payload.state, "failed");
        assert.include(completed.payload.errorMessage, "timed out");
      } else {
        assert.fail("expected a failed turn");
      }
      assert.equal((yield* adapter.listSessions())[0]?.status, "ready");
    }),
  ),
);

it.effect("leaves a running turn alone when a steer times out", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const threadId = ThreadId.make("pi-adapter-steer-timeout");
      const sessionDouble = yield* makeSessionDouble(threadId, {
        timeoutCommand: "prompt",
        timeoutAfter: 1,
      });
      const adapter = yield* makeTestAdapter(sessionDouble);

      yield* adapter.startSession(startInput(threadId));
      yield* adapter.sendTurn({ threadId, input: "start working" });
      const error = yield* Effect.flip(adapter.sendTurn({ threadId, input: "and be careful" }));

      assert.equal(error._tag, "ProviderAdapterRequestError");
      // The steer failed, but the turn behind it is still Pi's to finish.
      assert.isFalse(sessionDouble.requests.some((command) => command.type === "abort"));
      assert.isDefined((yield* adapter.listSessions())[0]?.activeTurnId);
    }),
  ),
);

it.effect("steers a running turn instead of opening a new one on mid-turn sendTurn", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const threadId = ThreadId.make("pi-adapter-steer");
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
      const turn = yield* adapter.sendTurn({ threadId, input: "start working" });

      // The turn is still running (no agent_settled yet), so this folds into it.
      const steered = yield* adapter.sendTurn({ threadId, input: "actually, be careful" });
      assert.equal(String(steered.turnId), String(turn.turnId));

      yield* sessionDouble.push({ type: "agent_settled" });
      const events = yield* Fiber.join(eventsFiber);

      assert.deepEqual(sessionDouble.requests, [
        { type: "prompt", message: "start working", streamingBehavior: "steer" },
        { type: "prompt", message: "actually, be careful", streamingBehavior: "steer" },
      ]);
      // One turn boundary for the whole run: the steer opened no second turn.
      assert.equal(events.filter((event) => event.type === "turn.started").length, 1);
      assert.equal(events.filter((event) => event.type === "turn.completed").length, 1);
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

it.effect("coalesces identical Pi tool updates while preserving changed progress", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const threadId = ThreadId.make("pi-adapter-tool-update-coalescing");
      const sessionDouble = yield* makeSessionDouble(threadId);
      const adapter = yield* makeTestAdapter(sessionDouble);
      const eventsFiber = yield* adapter.streamEvents.pipe(
        Stream.filter((event) => event.threadId === threadId),
        Stream.takeUntil((event) => event.type === "turn.completed"),
        Stream.runCollect,
        Effect.forkScoped,
      );

      yield* adapter.startSession(startInput(threadId));
      yield* adapter.sendTurn({ threadId, input: "wait for the subagent" });
      yield* sessionDouble.push({
        type: "tool_execution_start",
        toolCallId: "wait-tool",
        toolName: "subagent_wait",
        args: { ids: ["sa-1"] },
      });
      yield* sessionDouble.push({
        type: "tool_execution_update",
        toolCallId: "wait-tool",
        toolName: "subagent_wait",
        partialResult: { pending: ["sa-1"] },
      });
      yield* sessionDouble.push({
        type: "tool_execution_update",
        toolCallId: "wait-tool",
        toolName: "subagent_wait",
        partialResult: { pending: ["sa-1"] },
      });
      yield* sessionDouble.push({
        type: "tool_execution_update",
        toolCallId: "wait-tool",
        toolName: "subagent_wait",
        partialResult: { pending: ["sa-1"], elapsedSeconds: 1 },
      });
      yield* sessionDouble.push({
        type: "tool_execution_end",
        toolCallId: "wait-tool",
        toolName: "subagent_wait",
        result: { status: "done" },
        isError: false,
      });
      yield* sessionDouble.push({ type: "agent_settled" });

      const events = yield* Fiber.join(eventsFiber);
      const toolEvents = events.filter((event) => event.itemId?.includes("wait-tool"));
      assert.deepEqual(
        toolEvents.map((event) => event.type),
        ["item.started", "item.updated", "item.updated", "item.completed"],
      );
    }),
  ),
);

it.effect("preserves whitespace across assistant deltas and does not repeat the final text", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const threadId = ThreadId.make("pi-adapter-whitespace-deltas");
      const sessionDouble = yield* makeSessionDouble(threadId);
      const adapter = yield* makeTestAdapter(sessionDouble);
      const eventsFiber = yield* adapter.streamEvents.pipe(
        Stream.filter((event) => event.threadId === threadId),
        Stream.takeUntil((event) => event.type === "turn.completed"),
        Stream.runCollect,
        Effect.forkScoped,
      );

      yield* adapter.startSession(startInput(threadId));
      yield* adapter.sendTurn({ threadId, input: "preserve this" });
      yield* sessionDouble.push({
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "hello " },
      });
      yield* sessionDouble.push({
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "world\n" },
      });
      yield* sessionDouble.push({
        type: "message_end",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "hello world\n" }],
          stopReason: "stop",
        },
      });
      yield* sessionDouble.push({ type: "agent_settled" });

      const events = yield* Fiber.join(eventsFiber);
      const deltas = events.filter((event) => event.type === "content.delta");
      assert.deepEqual(
        deltas.map((event) => (event.type === "content.delta" ? event.payload.delta : "")),
        ["hello ", "world\n"],
      );
      const completed = events.filter(
        (event) =>
          event.type === "item.completed" && event.payload.itemType === "assistant_message",
      );
      assert.equal(completed.length, 1);
      assert.equal(completed[0]?.type, "item.completed");
      if (completed[0]?.type === "item.completed") {
        assert.equal(completed[0].payload.detail, "hello world\n");
      }
    }),
  ),
);

it.effect("ends an interrupted subagent spawn as an aborted turn", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const threadId = ThreadId.make("pi-adapter-subagent-interrupt");
      const sessionDouble = yield* makeSessionDouble(threadId);
      const adapter = yield* makeTestAdapter(sessionDouble);
      const eventsFiber = yield* adapter.streamEvents.pipe(
        Stream.filter((event) => event.threadId === threadId),
        Stream.takeUntil((event) => event.type === "turn.aborted"),
        Stream.runCollect,
        Effect.forkScoped,
      );

      yield* adapter.startSession(startInput(threadId));
      const turn = yield* adapter.sendTurn({
        threadId,
        input: "interrupt this delegation",
      });
      yield* adapter.interruptTurn(threadId, turn.turnId);
      yield* sessionDouble.push({
        type: "tool_execution_end",
        toolCallId: "subagent-tool-interrupted",
        toolName: "subagent_spawn",
        args: { harness: "pi" },
        result: {
          content: [{ type: "text", text: "Subagent spawn aborted." }],
        },
        isError: true,
      });
      yield* sessionDouble.push({ type: "agent_settled" });

      const events = yield* Fiber.join(eventsFiber);
      assert.equal(events.at(-1)?.type, "turn.aborted");
      assert.equal(
        events.some((event) => event.type === "turn.completed"),
        false,
      );
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
      assert.isFalse(adapter.capabilities.supportsConversationRollback);
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

const subagentSnapshot = (sequence: number, status: "running" | "done" = "running") => ({
  type: "extension_ui_request",
  id: `subagents-${sequence}`,
  method: "setStatus",
  statusKey: "t3-subagents:v1",
  statusText: JSON.stringify({
    protocolVersion: 1,
    sequence,
    sessions: [
      {
        id: "sa-1",
        origin: "model",
        title: "Review",
        backend: "pi",
        model: "test/model",
        status,
        terminalReason: status === "done" ? "completed" : null,
        createdAt: 1000,
        updatedAt: 2000 + sequence,
        settledAt: status === "done" ? 2000 : null,
        context: { occupancyTokens: 10, capacityTokens: 1000 },
        cumulative: { tokens: 20, costUsd: null },
        generation: { active: status === "running", counter: 1, outputCharacters: 10 },
        tools: { active: 0, done: 1, error: 0, activities: [] },
      },
    ],
  }),
});

it.effect("stops live Pi subagents after the parent turn has settled", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const threadId = ThreadId.make("pi-background-stop");
      const sessionDouble = yield* makeSessionDouble(threadId);
      const adapter = yield* makeTestAdapter(sessionDouble);
      const eventsFiber = yield* adapter.streamEvents.pipe(
        Stream.takeUntil((event) => event.type === "session.exited"),
        Stream.runCollect,
        Effect.forkScoped,
      );
      const settled = yield* adapter.streamEvents.pipe(
        Stream.filter((event) => event.type === "turn.completed"),
        Stream.take(1),
        Stream.runCollect,
        Effect.forkScoped,
      );
      yield* adapter.startSession(startInput(threadId));
      const turn = yield* adapter.sendTurn({ threadId, input: "delegate" });
      yield* sessionDouble.push(subagentSnapshot(1));
      yield* sessionDouble.push({ type: "agent_settled" });
      yield* Fiber.join(settled);
      yield* adapter.interruptTurn(threadId);
      const events = yield* Fiber.join(eventsFiber);
      assert.equal(yield* adapter.hasSession(threadId), false);
      assert.equal(yield* sessionDouble.manager.has(threadId), false);
      assert.equal(
        sessionDouble.requests.some((command) => command.type === "abort"),
        false,
      );
      const start = events.find((event) => event.type === "task.started");
      assert.equal(start?.turnId, turn.turnId);
      const terminals = events.filter(
        (event) => event.type === "task.completed" || event.type === "task.updated",
      );
      assert.isTrue(
        terminals.some(
          (event) => event.type === "task.updated" && event.payload.status === "interrupted",
        ),
      );
      assert.equal(events.at(-1)?.type, "session.exited");
    }),
  ),
);

it.effect("keeps child completion on its original turn and does not close an idle Pi session", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const threadId = ThreadId.make("pi-background-complete");
      const sessionDouble = yield* makeSessionDouble(threadId);
      const adapter = yield* makeTestAdapter(sessionDouble);
      const eventsFiber = yield* adapter.streamEvents.pipe(
        Stream.takeUntil((event) => event.type === "task.completed"),
        Stream.runCollect,
        Effect.forkScoped,
      );
      const settled = yield* adapter.streamEvents.pipe(
        Stream.filter((event) => event.type === "turn.completed"),
        Stream.take(1),
        Stream.runCollect,
        Effect.forkScoped,
      );
      yield* adapter.startSession(startInput(threadId));
      const first = yield* adapter.sendTurn({ threadId, input: "delegate" });
      yield* sessionDouble.push(subagentSnapshot(1));
      yield* sessionDouble.push({ type: "agent_settled" });
      yield* Fiber.join(settled);
      yield* adapter.sendTurn({ threadId, input: "another task" });
      yield* sessionDouble.push(subagentSnapshot(2, "done"));
      const events = yield* Fiber.join(eventsFiber);
      const completed = events.find((event) => event.type === "task.completed");
      assert.equal(completed?.turnId, first.turnId);
      yield* adapter.interruptTurn(threadId);
      assert.equal(sessionDouble.requests.at(-1)?.type, "abort");
      assert.equal(yield* adapter.hasSession(threadId), true);
    }),
  ),
);
