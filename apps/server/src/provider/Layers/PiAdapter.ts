// @effect-diagnostics nodeBuiltinImport:off
/**
 * Pi provider adapter.
 *
 * The session manager owns the process and durable Pi cursor. This module only
 * translates the Pi event stream into T3 runtime events and keeps the small
 * amount of live state needed by ProviderAdapterShape. In particular,
 * `agent_settled` is the only Pi event that closes a T3 turn: `turn_end` is an
 * internal Pi boundary and may be followed by more work in the same agent
 * cycle.
 */
import * as NodeCrypto from "node:crypto";

import {
  EventId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderItemId,
  RuntimeItemId,
  ThreadId,
  TurnId,
  type ModelSelection,
  type ProviderRuntimeEvent,
  type ProviderSession,
} from "@t3tools/contracts";
import { getModelSelectionStringOptionValue } from "@t3tools/shared/model";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as PubSub from "effect/PubSub";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import {
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
} from "../Errors.ts";
import type { ProviderAdapterShape } from "../Services/ProviderAdapter.ts";
import type { PiRpcCommand, PiRpcEvent, PiRpcExtensionUiResponse } from "./PiRpcContract.ts";
import {
  loadPiImageContents,
  piImageInputSupport,
  type PiImageAttachmentReader,
} from "./PiImageAttachments.ts";
import type { PiSession, PiSessionManager, PiSessionManagerError } from "./PiSessionManager.ts";

const PROVIDER = ProviderDriverKind.make("pi");
const BLOCKING_EXTENSION_UI_METHODS = new Set(["select", "confirm", "input", "editor"]);

export interface PiAdapterOptions {
  readonly sessionManager: PiSessionManager;
  readonly instanceId?: ProviderInstanceId;
  /** Server-owned attachment storage and reader; absent only disables image turns. */
  readonly attachmentReader?: PiImageAttachmentReader;
  /** Injectable id source for hermetic adapter tests. */
  readonly makeId?: () => string;
}

interface AssistantItemState {
  readonly key: string;
  readonly itemType: "assistant_message" | "reasoning";
  readonly streamKind: "assistant_text" | "reasoning_text";
  readonly contentIndex: number;
  text: string;
  completed: boolean;
}

interface ToolItemState {
  readonly toolCallId: string;
  readonly itemType:
    | "command_execution"
    | "file_change"
    | "mcp_tool_call"
    | "dynamic_tool_call"
    | "collab_agent_tool_call"
    | "web_search"
    | "image_view";
  readonly toolName: string;
  args: unknown;
  partialResult: unknown;
  result: unknown;
  isError: boolean;
  completed: boolean;
}

interface PiSessionContext {
  readonly threadId: ThreadId;
  readonly piSession: PiSession;
  session: ProviderSession;
  turns: Array<{ id: TurnId; items: Array<unknown> }>;
  activeTurnId: TurnId | undefined;
  abortRequestedTurnId: TurnId | undefined;
  turnFailureMessage: string | undefined;
  modelSelection: ModelSelection | undefined;
  currentModel: string | undefined;
  currentThinking: string | undefined;
  assistantMessageIndex: number;
  currentAssistantMessageIndex: number;
  assistantMessageOpen: boolean;
  assistantItems: Map<string, AssistantItemState>;
  toolItems: Map<string, ToolItemState>;
  requestSequence: number;
  stopped: boolean;
  eventFiber: Fiber.Fiber<void, never> | undefined;
}

type PiAdapterShape = ProviderAdapterShape<
  | ProviderAdapterProcessError
  | ProviderAdapterRequestError
  | ProviderAdapterSessionNotFoundError
  | ProviderAdapterValidationError
>;

const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) ? value : undefined;
}

function boolValue(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function detailFromUnknown(value: unknown): string | undefined {
  const direct = stringValue(value);
  if (direct !== undefined) return direct;
  if (isRecord(value)) {
    const text = stringValue(value.text) ?? stringValue(value.message) ?? stringValue(value.output);
    if (text !== undefined) return text;
    try {
      const encoded = JSON.stringify(value);
      return encoded === undefined ? undefined : encoded;
    } catch {
      return undefined;
    }
  }
  if (Array.isArray(value)) {
    const parts = value.flatMap((part) => {
      if (!isRecord(part)) return [];
      const text = stringValue(part.text) ?? stringValue(part.content);
      return text === undefined ? [] : [text];
    });
    if (parts.length > 0) return parts.join("\n");
  }
  return undefined;
}

function causeMessage(cause: unknown): string {
  if (cause instanceof Error && cause.message.trim().length > 0) return cause.message;
  if (isRecord(cause) && typeof cause.message === "string" && cause.message.trim().length > 0) {
    return cause.message;
  }
  return String(cause);
}

function parsePiModelSlug(
  model: string | undefined,
): { readonly provider: string; readonly modelId: string } | undefined {
  if (model === undefined) return undefined;
  const separator = model.indexOf("/");
  if (separator <= 0 || separator === model.length - 1) return undefined;
  const provider = model.slice(0, separator).trim();
  const modelId = model.slice(separator + 1).trim();
  return provider.length > 0 && modelId.length > 0 ? { provider, modelId } : undefined;
}

function toolItemType(toolName: string): ToolItemState["itemType"] {
  const name = toolName.toLowerCase();
  if (name.includes("subagent") || name.includes("agent") || name.includes("task")) {
    return "collab_agent_tool_call";
  }
  if (name.includes("mcp")) return "mcp_tool_call";
  if (name.includes("search") || name.includes("web")) return "web_search";
  if (name.includes("image") || name.includes("vision")) return "image_view";
  if (
    name.includes("patch") ||
    name.includes("edit") ||
    name.includes("write") ||
    name.includes("delete")
  ) {
    return "file_change";
  }
  if (
    name.includes("bash") ||
    name.includes("shell") ||
    name.includes("command") ||
    name.includes("exec")
  ) {
    return "command_execution";
  }
  return "dynamic_tool_call";
}

function runtimeItemId(key: string): RuntimeItemId {
  return RuntimeItemId.make(key);
}

function appendTurnItem(ctx: PiSessionContext, turnId: TurnId, item: unknown): void {
  const turn = ctx.turns.find((candidate) => candidate.id === turnId);
  if (turn === undefined) {
    ctx.turns.push({ id: turnId, items: [item] });
  } else {
    turn.items.push(item);
  }
}

function eventAssistantMessageEvent(event: PiRpcEvent): Record<string, unknown> | undefined {
  return isRecord(event.assistantMessageEvent) ? event.assistantMessageEvent : undefined;
}

function currentTurn(ctx: PiSessionContext): TurnId | undefined {
  return ctx.activeTurnId;
}

function makeAdapterError(
  operation: string,
  threadId: ThreadId,
  cause: PiSessionManagerError,
): ProviderAdapterProcessError {
  return new ProviderAdapterProcessError({
    provider: PROVIDER,
    threadId,
    detail: `${operation}: ${causeMessage(cause)}`,
    cause,
  });
}

export const makePiAdapter = Effect.fn("makePiAdapter")(function* (
  options: PiAdapterOptions,
): Effect.fn.Return<PiAdapterShape, never, Scope.Scope> {
  const boundInstanceId = options.instanceId ?? ProviderInstanceId.make("pi");
  const makeId = options.makeId ?? (() => NodeCrypto.randomUUID());
  const sessions = new Map<ThreadId, PiSessionContext>();
  const runtimeEvents = yield* PubSub.unbounded<ProviderRuntimeEvent>();
  const adapterScope = yield* Scope.Scope;

  const emit = (event: ProviderRuntimeEvent) =>
    PubSub.publish(runtimeEvents, event).pipe(Effect.asVoid);

  const makeEventBase = Effect.fn("PiAdapter.makeEventBase")(function* (input: {
    readonly threadId: ThreadId;
    readonly turnId?: TurnId | undefined;
    readonly itemId?: RuntimeItemId;
    readonly providerItemId?: string;
  }) {
    return {
      eventId: EventId.make(makeId()),
      provider: PROVIDER,
      providerInstanceId: boundInstanceId,
      threadId: input.threadId,
      createdAt: yield* nowIso,
      ...(input.turnId === undefined ? {} : { turnId: input.turnId }),
      ...(input.itemId === undefined ? {} : { itemId: input.itemId }),
      ...(input.providerItemId === undefined
        ? {}
        : { providerRefs: { providerItemId: ProviderItemId.make(input.providerItemId) } }),
    };
  });

  const requireSession = Effect.fn("PiAdapter.requireSession")(function* (threadId: ThreadId) {
    const context = sessions.get(threadId);
    if (context === undefined || context.stopped) {
      return yield* new ProviderAdapterSessionNotFoundError({
        provider: PROVIDER,
        threadId,
      });
    }
    return context;
  });

  const updateSession = Effect.fn("PiAdapter.updateSession")(function* (
    context: PiSessionContext,
    patch: Partial<ProviderSession>,
    clearActiveTurnId = false,
  ) {
    const updatedAt = yield* nowIso;
    const { activeTurnId: currentActiveTurnId, ...withoutActiveTurnId } = context.session;
    context.session = {
      ...withoutActiveTurnId,
      ...(clearActiveTurnId ? {} : { activeTurnId: patch.activeTurnId ?? currentActiveTurnId }),
      ...patch,
      updatedAt,
    };
  });

  const requestId = (context: PiSessionContext, command: string): string =>
    `pi-${context.threadId}-${command}-${context.requestSequence++}`;

  const request = Effect.fn("PiAdapter.request")(function* (
    context: PiSessionContext,
    command: PiRpcCommand,
  ) {
    return yield* context.piSession.request(command, requestId(context, command.type)).pipe(
      Effect.mapError(
        (cause) =>
          new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: command.type,
            detail: causeMessage(cause),
            cause,
          }),
      ),
    );
  });

  const emitSessionStarted = (context: PiSessionContext) =>
    Effect.gen(function* () {
      yield* emit({
        ...(yield* makeEventBase({ threadId: context.threadId })),
        type: "session.started",
        payload: {
          message: "Pi RPC session ready",
          resume: context.session.resumeCursor,
        },
      });
      yield* emit({
        ...(yield* makeEventBase({ threadId: context.threadId })),
        type: "thread.started",
        payload: { providerThreadId: context.piSession.sessionId },
      });
      yield* emit({
        ...(yield* makeEventBase({ threadId: context.threadId })),
        type: "session.state.changed",
        payload: { state: "ready" },
      });
    });

  const validateModelSelection = (selection: ModelSelection | undefined) => {
    if (selection === undefined) return;
    if (selection.instanceId !== boundInstanceId) {
      return new ProviderAdapterValidationError({
        provider: PROVIDER,
        operation: "sendTurn",
        issue: `Pi model selection is bound to instance '${selection.instanceId}', expected '${boundInstanceId}'.`,
      });
    }
    if (parsePiModelSlug(selection.model) === undefined) {
      return new ProviderAdapterValidationError({
        provider: PROVIDER,
        operation: "sendTurn",
        issue: "Pi model selection must use the 'provider/model' format.",
      });
    }
  };

  const emitTurnStarted = (context: PiSessionContext, turnId: TurnId, model?: string) =>
    Effect.gen(function* () {
      yield* emit({
        ...(yield* makeEventBase({ threadId: context.threadId, turnId })),
        type: "turn.started",
        payload: model === undefined ? {} : { model },
      });
      context.turns.push({ id: turnId, items: [] });
    });

  const ensureAssistantItem = Effect.fn("PiAdapter.ensureAssistantItem")(function* (
    context: PiSessionContext,
    turnId: TurnId,
    kind: "assistant_message" | "reasoning",
    contentIndex: number,
  ) {
    const streamKind = kind === "assistant_message" ? "assistant_text" : "reasoning_text";
    const key = `${turnId}:assistant:${context.currentAssistantMessageIndex}:${kind}:${contentIndex}`;
    const existing = context.assistantItems.get(key);
    if (existing !== undefined) return existing;
    const item: AssistantItemState = {
      key,
      itemType: kind,
      streamKind,
      contentIndex,
      text: "",
      completed: false,
    };
    context.assistantItems.set(key, item);
    yield* emit({
      ...(yield* makeEventBase({ threadId: context.threadId, turnId, itemId: runtimeItemId(key) })),
      type: "item.started",
      payload: {
        itemType: kind,
        status: "inProgress",
        title: kind === "assistant_message" ? "Assistant message" : "Reasoning",
      },
    });
    appendTurnItem(context, turnId, { type: kind, itemId: key });
    return item;
  });

  const emitAssistantDelta = Effect.fn("PiAdapter.emitAssistantDelta")(function* (
    context: PiSessionContext,
    turnId: TurnId,
    kind: "assistant_message" | "reasoning",
    contentIndex: number,
    delta: string,
  ) {
    if (delta.length === 0) return;
    const item = yield* ensureAssistantItem(context, turnId, kind, contentIndex);
    item.text += delta;
    yield* emit({
      ...(yield* makeEventBase({
        threadId: context.threadId,
        turnId,
        itemId: runtimeItemId(item.key),
      })),
      type: "content.delta",
      payload: {
        streamKind: item.streamKind,
        delta,
        contentIndex,
      },
    });
  });

  const completeAssistantItem = Effect.fn("PiAdapter.completeAssistantItem")(function* (
    context: PiSessionContext,
    turnId: TurnId,
    kind: "assistant_message" | "reasoning",
    contentIndex: number,
    finalText: string | undefined,
    failed: boolean,
  ) {
    const item = yield* ensureAssistantItem(context, turnId, kind, contentIndex);
    if (finalText !== undefined && finalText !== item.text) {
      const delta = finalText.startsWith(item.text) ? finalText.slice(item.text.length) : finalText;
      yield* emitAssistantDelta(context, turnId, kind, contentIndex, delta);
      item.text = finalText;
    }
    if (item.completed) return;
    item.completed = true;
    yield* emit({
      ...(yield* makeEventBase({
        threadId: context.threadId,
        turnId,
        itemId: runtimeItemId(item.key),
      })),
      type: "item.completed",
      payload: {
        itemType: kind,
        status: failed ? "failed" : "completed",
        title: kind === "assistant_message" ? "Assistant message" : "Reasoning",
        ...(item.text.length === 0 ? {} : { detail: item.text }),
      },
    });
  });

  const readAssistantContent = (
    content: unknown,
  ): Array<{ kind: "assistant_message" | "reasoning"; text: string; index: number }> => {
    if (!Array.isArray(content)) return [];
    return content.flatMap((part, index) => {
      if (!isRecord(part)) return [];
      const text = stringValue(part.text) ?? stringValue(part.thinking);
      if (text === undefined) return [];
      return [
        {
          kind: part.type === "thinking" ? ("reasoning" as const) : ("assistant_message" as const),
          text,
          index,
        },
      ];
    });
  };

  const handleMessageEnd = Effect.fn("PiAdapter.handleMessageEnd")(function* (
    context: PiSessionContext,
    event: PiRpcEvent,
  ) {
    const turnId = currentTurn(context);
    if (turnId === undefined || !isRecord(event.message)) return;
    const message = event.message;
    if (message.role !== "assistant") return;
    const stopReason = stringValue(message.stopReason);
    const errorMessage =
      stringValue(message.errorMessage) ??
      stringValue(message.error) ??
      (stopReason === "error" ? "Pi reported an assistant message error." : undefined);
    if (errorMessage !== undefined) context.turnFailureMessage = errorMessage;
    for (const part of readAssistantContent(message.content)) {
      yield* completeAssistantItem(
        context,
        turnId,
        part.kind,
        part.index,
        part.text,
        errorMessage !== undefined,
      );
    }
    context.assistantMessageOpen = false;
    context.currentAssistantMessageIndex = context.assistantMessageIndex;
  });

  const emitToolEvent = Effect.fn("PiAdapter.emitToolEvent")(function* (
    context: PiSessionContext,
    event: PiRpcEvent,
    phase: "start" | "update" | "end",
  ) {
    const turnId = currentTurn(context);
    const toolCallId = stringValue(event.toolCallId);
    const toolName = stringValue(event.toolName);
    if (turnId === undefined || toolCallId === undefined || toolName === undefined) return;
    let item = context.toolItems.get(toolCallId);
    if (item === undefined) {
      item = {
        toolCallId,
        itemType: toolItemType(toolName),
        toolName,
        args: event.args,
        partialResult: event.partialResult,
        result: event.result,
        isError: boolValue(event.isError) ?? false,
        completed: false,
      };
      context.toolItems.set(toolCallId, item);
    } else {
      item.args = event.args ?? item.args;
      item.partialResult = event.partialResult ?? item.partialResult;
      item.result = event.result ?? item.result;
      item.isError = boolValue(event.isError) ?? item.isError;
    }
    if (phase === "end") item.completed = true;
    const type =
      phase === "start" ? "item.started" : phase === "end" ? "item.completed" : "item.updated";
    const detail = detailFromUnknown(item.result) ?? detailFromUnknown(item.partialResult);
    yield* emit({
      ...(yield* makeEventBase({
        threadId: context.threadId,
        turnId,
        itemId: runtimeItemId(toolCallId),
        providerItemId: toolCallId,
      })),
      type,
      payload: {
        itemType: item.itemType,
        status: phase === "end" ? (item.isError ? "failed" : "completed") : "inProgress",
        title: item.toolName,
        ...(detail === undefined ? {} : { detail }),
        data: {
          toolCallId,
          toolName: item.toolName,
          ...(item.args === undefined ? {} : { args: item.args }),
          ...(item.partialResult === undefined ? {} : { partialResult: item.partialResult }),
          ...(item.result === undefined ? {} : { result: item.result }),
          isError: item.isError,
        },
      },
    });
    appendTurnItem(context, turnId, {
      type: item.itemType,
      toolCallId,
      toolName: item.toolName,
      phase,
    });
  });

  const settleTurn = Effect.fn("PiAdapter.settleTurn")(function* (context: PiSessionContext) {
    const turnId = currentTurn(context);
    if (turnId === undefined) return;
    const interrupted = context.abortRequestedTurnId === turnId;
    const errorMessage = context.turnFailureMessage;
    for (const item of context.assistantItems.values()) {
      if (!item.completed) {
        yield* completeAssistantItem(
          context,
          turnId,
          item.itemType,
          item.contentIndex,
          item.text,
          context.turnFailureMessage !== undefined,
        );
      }
    }
    const refreshed = yield* context.piSession.refresh().pipe(Effect.exit);
    if (Exit.isSuccess(refreshed)) {
      context.session = { ...context.session, resumeCursor: refreshed.value };
    } else {
      yield* emit({
        ...(yield* makeEventBase({ threadId: context.threadId, turnId })),
        type: "runtime.warning",
        payload: {
          message: "Pi settled the turn, but refreshing its resume cursor failed.",
          detail: refreshed.cause,
        },
      });
    }
    context.activeTurnId = undefined;
    context.abortRequestedTurnId = undefined;
    context.turnFailureMessage = undefined;
    context.assistantItems.clear();
    context.toolItems.clear();
    context.assistantMessageOpen = false;
    yield* updateSession(context, { status: "ready" }, true);

    if (interrupted) {
      yield* emit({
        ...(yield* makeEventBase({ threadId: context.threadId, turnId })),
        type: "turn.aborted",
        payload: { reason: "Interrupted by user." },
      });
    } else {
      yield* emit({
        ...(yield* makeEventBase({ threadId: context.threadId, turnId })),
        type: "turn.completed",
        payload: {
          state: errorMessage === undefined ? "completed" : "failed",
          ...(errorMessage === undefined ? {} : { errorMessage }),
        },
      });
    }
    context.turnFailureMessage = undefined;
  });

  const handleExtensionUiRequest = Effect.fn("PiAdapter.handleExtensionUiRequest")(function* (
    context: PiSessionContext,
    event: PiRpcEvent,
  ) {
    const method = stringValue(event.method);
    const id = stringValue(event.id);
    if (method === undefined || id === undefined) return;
    if (!BLOCKING_EXTENSION_UI_METHODS.has(method)) return;

    const cancellation: PiRpcExtensionUiResponse = {
      type: "extension_ui_response",
      id,
      cancelled: true,
    };
    const sent = yield* context.piSession.send(cancellation).pipe(Effect.exit);
    const eventBase = () =>
      makeEventBase({
        threadId: context.threadId,
        ...(currentTurn(context) === undefined ? {} : { turnId: currentTurn(context) }),
      });
    if (Exit.isFailure(sent)) {
      yield* emit({
        ...(yield* eventBase()),
        type: "runtime.warning",
        payload: {
          message: `Pi blocking extension UI '${method}' could not be cancelled.`,
          detail: sent.cause,
        },
      });
      return;
    }
    yield* emit({
      ...(yield* eventBase()),
      type: "runtime.warning",
      payload: {
        message: `Pi requested blocking extension UI '${method}'; T3 cancelled it because this interaction is not supported.`,
        detail: { id },
      },
    });
  });

  const handleEvent = Effect.fn("PiAdapter.handleEvent")(function* (
    context: PiSessionContext,
    event: PiRpcEvent,
  ) {
    switch (event.type) {
      case "message_start": {
        const message = isRecord(event.message) ? event.message : undefined;
        if (message?.role === "assistant") {
          context.currentAssistantMessageIndex = context.assistantMessageIndex++;
          context.assistantMessageOpen = true;
        }
        break;
      }
      case "message_update": {
        const update = eventAssistantMessageEvent(event);
        const kind = stringValue(update?.type);
        const turnId = currentTurn(context);
        if (turnId === undefined || update === undefined || kind === undefined) break;
        if (!context.assistantMessageOpen) {
          context.currentAssistantMessageIndex = context.assistantMessageIndex++;
          context.assistantMessageOpen = true;
        }
        const contentIndex = numberValue(update.contentIndex) ?? 0;
        if (kind === "text_start" || kind === "text_delta" || kind === "text_end") {
          if (kind === "text_delta") {
            yield* emitAssistantDelta(
              context,
              turnId,
              "assistant_message",
              contentIndex,
              stringValue(update.delta) ?? "",
            );
          } else {
            yield* ensureAssistantItem(context, turnId, "assistant_message", contentIndex);
          }
        } else if (
          kind === "thinking_start" ||
          kind === "thinking_delta" ||
          kind === "thinking_end"
        ) {
          if (kind === "thinking_delta") {
            yield* emitAssistantDelta(
              context,
              turnId,
              "reasoning",
              contentIndex,
              stringValue(update.delta) ?? "",
            );
          } else {
            yield* ensureAssistantItem(context, turnId, "reasoning", contentIndex);
          }
        }
        break;
      }
      case "message_end":
        yield* handleMessageEnd(context, event);
        break;
      case "tool_execution_start":
        yield* emitToolEvent(context, event, "start");
        break;
      case "tool_execution_update":
        yield* emitToolEvent(context, event, "update");
        break;
      case "tool_execution_end":
        yield* emitToolEvent(context, event, "end");
        break;
      case "agent_settled":
        yield* settleTurn(context);
        break;
      case "extension_ui_request":
        yield* handleExtensionUiRequest(context, event);
        break;
      case "agent_start":
      case "turn_start":
      case "turn_end":
      case "agent_end":
        // Pi lifecycle markers do not independently settle T3 turns.
        break;
      default:
        yield* Effect.logDebug("Ignoring unknown Pi event.", {
          type: event.type,
          threadId: context.threadId,
          turnId: context.activeTurnId,
          raw: event,
        });
        break;
    }
  });

  const handleUnexpectedExit = Effect.fn("PiAdapter.handleUnexpectedExit")(function* (
    context: PiSessionContext,
    detail: string,
  ) {
    if (context.stopped) return;
    context.stopped = true;
    sessions.delete(context.threadId);
    const activeTurnId = context.activeTurnId;
    if (activeTurnId !== undefined) {
      yield* emit({
        ...(yield* makeEventBase({ threadId: context.threadId, turnId: activeTurnId })),
        type: "turn.completed",
        payload: { state: "failed", errorMessage: detail },
      });
    }
    yield* updateSession(context, { status: "error", lastError: detail }, true);
    yield* emit({
      ...(yield* makeEventBase({ threadId: context.threadId })),
      type: "runtime.error",
      payload: { message: detail, class: "transport_error" },
    });
    yield* emit({
      ...(yield* makeEventBase({ threadId: context.threadId })),
      type: "session.state.changed",
      payload: { state: "error", reason: detail },
    });
    yield* emit({
      ...(yield* makeEventBase({ threadId: context.threadId })),
      type: "session.exited",
      payload: { reason: detail, recoverable: false, exitKind: "error" },
    });
  });

  const startEventPump = Effect.fn("PiAdapter.startEventPump")(function* (
    context: PiSessionContext,
  ) {
    const pump = context.piSession.events.pipe(
      Stream.runForEach((event) => handleEvent(context, event)),
      Effect.exit,
      Effect.flatMap((exit) =>
        Effect.gen(function* () {
          if (context.stopped) return;
          if (Exit.isFailure(exit)) {
            yield* handleUnexpectedExit(context, causeMessage(exit.cause));
            return;
          }
          const stillOwned = yield* options.sessionManager.has(context.threadId);
          if (!stillOwned) {
            yield* handleUnexpectedExit(context, "Pi RPC event stream ended unexpectedly.");
          }
        }),
      ),
    );
    context.eventFiber = yield* Effect.forkIn(pump, adapterScope);
  });

  const startSession: PiAdapterShape["startSession"] = Effect.fn("PiAdapter.startSession")(
    function* (input) {
      if (input.provider !== undefined && input.provider !== PROVIDER) {
        return yield* new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "startSession",
          issue: `Expected provider '${PROVIDER}', received '${input.provider}'.`,
        });
      }
      if (input.providerInstanceId !== undefined && input.providerInstanceId !== boundInstanceId) {
        return yield* new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "startSession",
          issue: `Expected provider instance '${boundInstanceId}', received '${input.providerInstanceId}'.`,
        });
      }
      const existing = sessions.get(input.threadId);
      if (existing !== undefined && !existing.stopped) return { ...existing.session };

      const piSession = yield* options.sessionManager
        .start({
          threadId: input.threadId,
          ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
          ...(input.resumeCursor === undefined ? {} : { resumeCursor: input.resumeCursor }),
        })
        .pipe(Effect.mapError((cause) => makeAdapterError("startSession", input.threadId, cause)));
      const resumeCursor = yield* piSession.getResumeCursor();
      const timestamp = yield* nowIso;
      const context: PiSessionContext = {
        threadId: input.threadId,
        piSession,
        session: {
          provider: PROVIDER,
          providerInstanceId: boundInstanceId,
          status: "ready",
          runtimeMode: input.runtimeMode,
          cwd: piSession.cwd,
          ...(input.modelSelection === undefined ? {} : { model: input.modelSelection.model }),
          threadId: input.threadId,
          resumeCursor,
          createdAt: timestamp,
          updatedAt: timestamp,
        },
        turns: [],
        activeTurnId: undefined,
        abortRequestedTurnId: undefined,
        turnFailureMessage: undefined,
        modelSelection: input.modelSelection,
        currentModel: undefined,
        currentThinking: undefined,
        assistantMessageIndex: 0,
        currentAssistantMessageIndex: 0,
        assistantMessageOpen: false,
        assistantItems: new Map(),
        toolItems: new Map(),
        requestSequence: 0,
        stopped: false,
        eventFiber: undefined,
      };
      sessions.set(input.threadId, context);
      yield* startEventPump(context);
      yield* emitSessionStarted(context);
      return { ...context.session };
    },
  );

  const sendTurn: PiAdapterShape["sendTurn"] = Effect.fn("PiAdapter.sendTurn")(function* (input) {
    const context = yield* requireSession(input.threadId);
    const requestedSelection = input.modelSelection ?? context.modelSelection;
    const modelError = validateModelSelection(requestedSelection);
    if (modelError !== undefined) return yield* modelError;
    const text = input.input?.trim() ?? "";
    const attachments = input.attachments ?? [];
    if (text.length === 0 && attachments.length === 0) {
      return yield* new ProviderAdapterValidationError({
        provider: PROVIDER,
        operation: "sendTurn",
        issue: "Pi turns require text input or at least one image attachment.",
      });
    }

    const parsedModel = parsePiModelSlug(requestedSelection?.model);
    const requestedThinking = getModelSelectionStringOptionValue(requestedSelection, "thinking");
    if (parsedModel !== undefined && requestedSelection?.model !== context.currentModel) {
      yield* request(context, {
        type: "set_model",
        provider: parsedModel.provider,
        modelId: parsedModel.modelId,
      });
      context.currentModel = requestedSelection?.model;
    }
    if (requestedThinking !== undefined && requestedThinking !== context.currentThinking) {
      yield* request(context, { type: "set_thinking_level", level: requestedThinking });
      context.currentThinking = requestedThinking;
    }
    if (requestedSelection !== undefined) {
      context.modelSelection = requestedSelection;
      context.session = { ...context.session, model: requestedSelection.model };
    }

    const images =
      attachments.length === 0
        ? []
        : yield* Effect.gen(function* () {
            if (options.attachmentReader === undefined) {
              return yield* new ProviderAdapterRequestError({
                provider: PROVIDER,
                method: "attachments/read",
                detail:
                  "Pi image attachments are unavailable because attachment storage is not configured.",
              });
            }

            const state = yield* request(context, { type: "get_state" });
            if (piImageInputSupport(state) === "unsupported") {
              return yield* new ProviderAdapterValidationError({
                provider: PROVIDER,
                operation: "sendTurn",
                issue: "The selected Pi model does not accept image input.",
              });
            }

            return yield* loadPiImageContents({
              attachments,
              reader: options.attachmentReader,
            }).pipe(
              Effect.mapError(
                (cause) =>
                  new ProviderAdapterRequestError({
                    provider: PROVIDER,
                    method: "attachments/read",
                    detail: cause.message,
                    cause,
                  }),
              ),
            );
          });

    const turnId = context.activeTurnId ?? TurnId.make(makeId());
    const newTurn = context.activeTurnId === undefined;
    if (newTurn) {
      context.activeTurnId = turnId;
      context.abortRequestedTurnId = undefined;
      context.turnFailureMessage = undefined;
      context.assistantMessageIndex = 0;
      context.currentAssistantMessageIndex = 0;
      context.assistantMessageOpen = false;
      context.assistantItems.clear();
      context.toolItems.clear();
      yield* updateSession(context, { status: "running", activeTurnId: turnId });
      yield* emitTurnStarted(context, turnId, requestedSelection?.model);
    }
    const promptResult = yield* request(context, {
      type: "prompt",
      message: text,
      ...(images.length === 0 ? {} : { images }),
    }).pipe(Effect.exit);
    if (Exit.isFailure(promptResult)) {
      const detail = causeMessage(promptResult.cause);
      if (newTurn) {
        context.activeTurnId = undefined;
        yield* updateSession(context, { status: "ready" }, true);
        yield* emit({
          ...(yield* makeEventBase({ threadId: context.threadId, turnId })),
          type: "turn.completed",
          payload: { state: "failed", errorMessage: detail },
        });
      }
      return yield* Effect.failCause(promptResult.cause);
    }
    return {
      threadId: input.threadId,
      turnId,
      resumeCursor: context.session.resumeCursor,
    };
  });

  const interruptTurn: PiAdapterShape["interruptTurn"] = Effect.fn("PiAdapter.interruptTurn")(
    function* (threadId, requestedTurnId) {
      const context = yield* requireSession(threadId);
      const activeTurnId = context.activeTurnId;
      if (activeTurnId === undefined) return;
      if (requestedTurnId !== undefined && requestedTurnId !== activeTurnId) return;
      context.abortRequestedTurnId = activeTurnId;
      yield* request(context, { type: "abort" }).pipe(Effect.asVoid);
    },
  );

  const unsupportedRequest = (threadId: ThreadId, method: string, detail: string) =>
    Effect.gen(function* () {
      yield* requireSession(threadId);
      return yield* new ProviderAdapterRequestError({
        provider: PROVIDER,
        method,
        detail,
      });
    });

  const respondToRequest: PiAdapterShape["respondToRequest"] = (threadId) =>
    unsupportedRequest(
      threadId,
      "extension_ui_response",
      "Pi blocking extension UI requests are cancelled by policy and cannot be answered by T3 yet.",
    );

  const respondToUserInput: PiAdapterShape["respondToUserInput"] = (threadId) =>
    unsupportedRequest(
      threadId,
      "extension_ui_response",
      "Pi structured user-input requests are not exposed by the MVP adapter.",
    );

  const stopSession: PiAdapterShape["stopSession"] = Effect.fn("PiAdapter.stopSession")(
    function* (threadId) {
      const context = yield* requireSession(threadId);
      context.stopped = true;
      sessions.delete(threadId);
      if (context.eventFiber !== undefined) yield* Fiber.interrupt(context.eventFiber);
      yield* options.sessionManager.stop(threadId);
      yield* emit({
        ...(yield* makeEventBase({ threadId })),
        type: "session.exited",
        payload: { reason: "Stopped by user.", recoverable: true, exitKind: "graceful" },
      });
    },
  );

  const listSessions: PiAdapterShape["listSessions"] = () =>
    Effect.succeed(Array.from(sessions.values(), (context) => ({ ...context.session })));

  const hasSession: PiAdapterShape["hasSession"] = (threadId) =>
    Effect.succeed(sessions.get(threadId)?.stopped === false);

  const readThread: PiAdapterShape["readThread"] = (threadId) =>
    Effect.gen(function* () {
      const context = yield* requireSession(threadId);
      return {
        threadId,
        turns: context.turns.map((turn) => ({ id: turn.id, items: [...turn.items] })),
      };
    });

  const rollbackThread: PiAdapterShape["rollbackThread"] = (threadId, numTurns) =>
    Effect.gen(function* () {
      yield* requireSession(threadId);
      if (!Number.isInteger(numTurns) || numTurns < 1) {
        return yield* new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "rollbackThread",
          issue: "numTurns must be an integer >= 1.",
        });
      }
      return yield* new ProviderAdapterRequestError({
        provider: PROVIDER,
        method: "thread/rollback",
        detail: "Pi RPC does not support provider-side thread rollback in the MVP adapter.",
      });
    });

  const stopAll: PiAdapterShape["stopAll"] = () =>
    Effect.forEach(Array.from(sessions.keys()), stopSession, { discard: true }).pipe(
      Effect.andThen(options.sessionManager.stopAll()),
    );

  yield* Effect.addFinalizer(() =>
    Effect.gen(function* () {
      yield* stopAll().pipe(Effect.ignore);
      yield* PubSub.shutdown(runtimeEvents);
    }),
  );

  return {
    provider: PROVIDER,
    capabilities: { sessionModelSwitch: "in-session" },
    startSession,
    sendTurn,
    interruptTurn,
    respondToRequest,
    respondToUserInput,
    stopSession,
    listSessions,
    hasSession,
    readThread,
    rollbackThread,
    stopAll,
    streamEvents: Stream.fromPubSub(runtimeEvents),
  } satisfies PiAdapterShape;
});
