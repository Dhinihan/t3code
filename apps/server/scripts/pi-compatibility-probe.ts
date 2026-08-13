#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off

/**
 * Manual compatibility probe for the installed Pi binary.
 *
 * This is intentionally a script, not a `*.test.ts`: it may use the user's
 * Pi installation, credentials, extensions, and real model calls. It never
 * writes the curated wire fixtures. Temporary session state is scoped to the
 * invocation and is removed with the process scope.
 */
import * as NodeCrypto from "node:crypto";
import * as NodePath from "node:path";

import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as ChildProcess from "effect/unstable/process/ChildProcess";

import { parseGenericCliVersion, spawnAndCollect } from "../src/provider/providerSnapshot.ts";
import {
  assessPiCompatibility,
  assessPiVersion,
  MINIMUM_PI_VERSION,
} from "../src/provider/Layers/PiCompatibility.ts";
import { connectPiRpc, type PiRpcConnection } from "../src/provider/Layers/PiRpcConnection.ts";
import {
  decodeAvailableThinkingLevelsResponse,
  decodeGetStateResponse,
  type PiRpcEvent,
  type PiRpcGetStateResponse,
  type PiRpcResponse,
} from "../src/provider/Layers/PiRpcContract.ts";
import * as PiRpcErrors from "../src/provider/Layers/PiRpcErrors.ts";
import {
  PI_SCOPED_MODELS_EXTENSION_PATH,
  readPiModelCatalog,
  type PiProviderCatalog,
} from "../src/provider/Layers/PiProvider.ts";
import { resolveSpawnCommand } from "@t3tools/shared/shell";

export class PiProbeValidationError extends Schema.TaggedErrorClass<PiProbeValidationError>()(
  "PiProbeValidationError",
  {
    operation: Schema.String,
    detail: Schema.String,
  },
) {
  override get message(): string {
    return this.detail;
  }
}

const DEFAULT_TIMEOUT_MS = 120_000;
const VERSION_TIMEOUT_MS = 4_000;
const TOOL_MARKER = "PI_PROBE_TOOL_OK";

export type PiProbeOutput = "text" | "json";

export interface PiProbeOptions {
  readonly binaryPath: string;
  readonly cwd: string;
  readonly model: string | undefined;
  readonly thinking: string | undefined;
  readonly output: PiProbeOutput;
  readonly timeoutMs: number;
}

export type PiProbeArguments =
  | { readonly _tag: "options"; readonly options: PiProbeOptions }
  | { readonly _tag: "help" }
  | { readonly _tag: "error"; readonly message: string };

export type PiProbeScenarioName =
  | "version"
  | "handshake"
  | "catalog"
  | "thinking"
  | "text"
  | "tool"
  | "abort"
  | "shutdown"
  | "resume";

export interface PiProbeScenarioResult {
  readonly name: PiProbeScenarioName;
  readonly status: "passed" | "failed" | "skipped";
  readonly detail?: string;
}

export interface PiProbeNovelty {
  readonly kind: "event" | "field";
  /** A schema path or event type. Never contains a payload value. */
  readonly path: string;
}

export interface PiProbeReport {
  readonly status: "passed" | "failed";
  readonly version: string | null;
  readonly scenarios: ReadonlyArray<PiProbeScenarioResult>;
  readonly novelties: ReadonlyArray<PiProbeNovelty>;
}

const DEFAULT_OPTIONS = {
  binaryPath: "pi",
  model: undefined,
  thinking: undefined,
  output: "text" as const,
  timeoutMs: DEFAULT_TIMEOUT_MS,
};

export function parsePiProbeArguments(
  argv: ReadonlyArray<string>,
  defaults: { readonly cwd: string },
): PiProbeArguments {
  let binaryPath = DEFAULT_OPTIONS.binaryPath;
  let cwd = defaults.cwd;
  let model: string | undefined = DEFAULT_OPTIONS.model;
  let thinking: string | undefined = DEFAULT_OPTIONS.thinking;
  let output: PiProbeOutput = DEFAULT_OPTIONS.output;
  let timeoutMs = DEFAULT_OPTIONS.timeoutMs;

  const readValue = (
    index: number,
    flag: string,
  ):
    | { readonly _tag: "value"; readonly value: string; readonly nextIndex: number }
    | { readonly _tag: "error"; readonly message: string } => {
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      return { _tag: "error", message: `${flag} requires a value.` };
    }
    return { _tag: "value", value, nextIndex: index + 1 };
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h") return { _tag: "help" };
    if (argument === "--json") {
      output = "json";
      continue;
    }

    if (
      argument === "--binary" ||
      argument === "--cwd" ||
      argument === "--model" ||
      argument === "--thinking" ||
      argument === "--timeout-ms"
    ) {
      const value = readValue(index, argument);
      if (value._tag === "error") return value;
      index = value.nextIndex;
      if (argument === "--binary") binaryPath = value.value;
      if (argument === "--cwd") cwd = value.value;
      if (argument === "--model") {
        if (!isModelSlug(value.value)) {
          return { _tag: "error", message: "--model must use the provider/model format." };
        }
        model = value.value;
      }
      if (argument === "--thinking") thinking = value.value;
      if (argument === "--timeout-ms") {
        const parsedTimeoutMs = Number(value.value);
        if (!Number.isInteger(parsedTimeoutMs) || parsedTimeoutMs < 1) {
          return { _tag: "error", message: "--timeout-ms must be a positive integer." };
        }
        timeoutMs = parsedTimeoutMs;
      }
      continue;
    }

    return { _tag: "error", message: `Unknown argument '${argument}'.` };
  }

  return {
    _tag: "options",
    options: { binaryPath, cwd, model, thinking, output, timeoutMs },
  };
}

function isModelSlug(value: string): boolean {
  const separator = value.indexOf("/");
  return separator > 0 && separator < value.length - 1 && !value.includes(" ");
}

const KNOWN_RESPONSE_FIELDS = new Set(["type", "id", "command", "success", "data", "error"]);
const KNOWN_STATE_FIELDS = new Set([
  "sessionId",
  "sessionFile",
  "model",
  "thinkingLevel",
  "messageCount",
  "isStreaming",
  "isCompacting",
  "steeringMode",
  "followUpMode",
  "autoCompactionEnabled",
  "pendingMessageCount",
]);
const KNOWN_MODEL_FIELDS = new Set([
  "provider",
  "id",
  "name",
  "reasoning",
  "thinkingLevelMap",
  "api",
  "baseUrl",
  "input",
  "cost",
  "contextWindow",
  "maxTokens",
  "compat",
]);
const KNOWN_EVENT_FIELDS = new Set([
  "type",
  "id",
  "method",
  "statusKey",
  "statusText",
  "assistantMessageEvent",
  "message",
  "toolCallId",
  "toolName",
  "args",
  "partialResult",
  "result",
  "isError",
  "willRetry",
  "messages",
  "toolResults",
  // Some future Pi event families use a payload bag. Report its fields only
  // when the event-specific decoder starts consuming them.
  "payload",
]);
const KNOWN_EVENT_TYPES = new Set([
  "agent_start",
  "turn_start",
  "message_start",
  "message_update",
  "message_end",
  "tool_execution_start",
  "tool_execution_update",
  "tool_execution_end",
  "turn_end",
  "agent_end",
  "agent_settled",
  "extension_ui_request",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function addNovelty(output: PiProbeNovelty[], seen: Set<string>, novelty: PiProbeNovelty): void {
  const key = `${novelty.kind}:${novelty.path}`;
  if (seen.has(key)) return;
  seen.add(key);
  output.push(novelty);
}

function addUnknownFields(
  output: PiProbeNovelty[],
  seen: Set<string>,
  prefix: string,
  value: unknown,
  known: ReadonlySet<string>,
): void {
  if (!isRecord(value)) return;
  for (const key of Object.keys(value).sort()) {
    if (!known.has(key)) addNovelty(output, seen, { kind: "field", path: `${prefix}.${key}` });
  }
}

/** Extract drift signals without retaining or printing any wire payload values. */
export function collectPiProbeNovelties(
  records: ReadonlyArray<PiRpcResponse | PiRpcEvent>,
): ReadonlyArray<PiProbeNovelty> {
  const output: PiProbeNovelty[] = [];
  const seen = new Set<string>();

  for (const record of records) {
    if (record.type === "response") {
      addUnknownFields(output, seen, `response.${record.command}`, record, KNOWN_RESPONSE_FIELDS);
      if (!isRecord(record.data)) continue;
      if (record.command === "get_state") {
        addUnknownFields(output, seen, "response.get_state.data", record.data, KNOWN_STATE_FIELDS);
        if (isRecord(record.data.model)) {
          addUnknownFields(
            output,
            seen,
            "response.get_state.data.model",
            record.data.model,
            KNOWN_MODEL_FIELDS,
          );
        }
      } else if (record.command === "get_available_models") {
        if (Array.isArray(record.data.models)) {
          record.data.models.forEach((model, index) =>
            addUnknownFields(
              output,
              seen,
              `response.get_available_models.data.models[${index}]`,
              model,
              KNOWN_MODEL_FIELDS,
            ),
          );
        }
      } else if (record.command === "get_available_thinking_levels") {
        addUnknownFields(
          output,
          seen,
          "response.get_available_thinking_levels.data",
          record.data,
          new Set(["levels"]),
        );
      }
      continue;
    }

    if (!KNOWN_EVENT_TYPES.has(record.type)) {
      addNovelty(output, seen, { kind: "event", path: record.type });
    }
    addUnknownFields(output, seen, `event.${record.type}`, record, KNOWN_EVENT_FIELDS);
  }

  return output;
}

export function formatPiProbeReport(report: PiProbeReport): string {
  const lines = [
    `Pi compatibility probe: ${report.status.toUpperCase()}`,
    `Pi version: ${report.version ?? "unknown"}`,
    "",
    "Scenarios:",
  ];
  for (const scenario of report.scenarios) {
    const marker = scenario.status === "passed" ? "✓" : scenario.status === "skipped" ? "·" : "✗";
    lines.push(
      `  ${marker} ${scenario.name}: ${scenario.status}${scenario.detail ? ` — ${scenario.detail}` : ""}`,
    );
  }
  lines.push("", "Novelty (non-fatal; inspect before accepting a Pi update):");
  if (report.novelties.length === 0) {
    lines.push("  none");
  } else {
    for (const novelty of report.novelties) lines.push(`  - ${novelty.kind}: ${novelty.path}`);
  }
  return `${lines.join("\n")}\n`;
}

const isPiRpcCompatibilityError = Schema.is(PiRpcErrors.PiRpcCompatibilityError);
const isPiRpcRequestTimeoutError = Schema.is(PiRpcErrors.PiRpcRequestTimeoutError);
const isPiRpcRequestError = Schema.is(PiRpcErrors.PiRpcRequestError);
const isPiRpcProcessExitedError = Schema.is(PiRpcErrors.PiRpcProcessExitedError);
const isPiRpcTerminatedError = Schema.is(PiRpcErrors.PiRpcTerminatedError);
const isPiProbeValidationError = Schema.is(PiProbeValidationError);

function safeFailure(error: unknown, operation: string): string {
  if (isPiRpcCompatibilityError(error)) return error.message;
  if (isPiRpcRequestTimeoutError(error)) return error.message;
  if (isPiRpcRequestError(error)) {
    return `Pi RPC command '${error.command}' failed.`;
  }
  if (isPiRpcProcessExitedError(error)) return error.message;
  if (isPiRpcTerminatedError(error)) return error.message;
  if (isPiProbeValidationError(error)) return error.message;
  if (error instanceof Error && error.message === "Pi returned an incompatible response shape.") {
    return error.message;
  }
  const tag = isRecord(error) && typeof error._tag === "string" ? error._tag : undefined;
  return `${operation} failed${tag ? ` (${tag})` : ""}.`;
}

function scenarioResult<A>(
  name: PiProbeScenarioName,
  exit: Exit.Exit<A, unknown>,
): PiProbeScenarioResult {
  return Exit.isSuccess(exit)
    ? { name, status: "passed" }
    : { name, status: "failed", detail: safeFailure(Cause.squash(exit.cause), name) };
}

function skippedScenario(name: PiProbeScenarioName, detail: string): PiProbeScenarioResult {
  return { name, status: "skipped", detail };
}

function modelParts(
  value: unknown,
): { readonly provider: string; readonly modelId: string } | undefined {
  if (!isRecord(value) || typeof value.provider !== "string" || typeof value.id !== "string") {
    return undefined;
  }
  if (value.provider.length === 0 || value.id.length === 0) return undefined;
  return { provider: value.provider, modelId: value.id };
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

interface TurnObservation {
  readonly events: ReadonlyArray<PiRpcEvent>;
  readonly assistantText: string;
  readonly toolStarts: number;
  readonly toolEnds: number;
}

function textFromEvent(event: PiRpcEvent): string {
  const update = isRecord(event.assistantMessageEvent) ? event.assistantMessageEvent : undefined;
  const updateText = update ? stringValue(update.delta) : undefined;
  if (updateText !== undefined) return updateText;

  const message = isRecord(event.message) ? event.message : undefined;
  if (!message || !Array.isArray(message.content)) return "";
  return message.content
    .flatMap((part) => {
      if (!isRecord(part)) return [];
      const text = stringValue(part.text);
      return text === undefined ? [] : [text];
    })
    .join("");
}

function runTurn(
  connection: PiRpcConnection,
  input: {
    readonly message: string;
    readonly requestId: string;
    readonly timeoutMs: number;
    readonly expectedText?: string;
    readonly requireTool?: boolean;
    readonly abortAfterTool?: boolean;
  },
): Effect.Effect<TurnObservation, PiProbeValidationError | PiRpcErrors.PiRpcError, Scope.Scope> {
  return Effect.gen(function* () {
    const settled = yield* Deferred.make<void, never>();
    const toolStarted = yield* Deferred.make<void, never>();
    const events: PiRpcEvent[] = [];
    const eventFiber = yield* connection.events.pipe(
      Stream.runForEach((event) =>
        Effect.gen(function* () {
          events.push(event);
          if (event.type === "tool_execution_start") {
            yield* Deferred.succeed(toolStarted, undefined);
          }
          if (event.type === "agent_settled") {
            yield* Deferred.succeed(settled, undefined);
          }
        }),
      ),
      Effect.forkScoped,
    );

    const promptFiber = yield* connection
      .request({ type: "prompt", message: input.message }, input.requestId)
      .pipe(Effect.forkScoped);

    if (input.abortAfterTool) {
      const toolReady = yield* Deferred.await(toolStarted).pipe(
        Effect.timeoutOption(Duration.millis(input.timeoutMs)),
      );
      if (Option.isNone(toolReady)) {
        yield* Fiber.interrupt(promptFiber);
        yield* Fiber.interrupt(eventFiber);
        return yield* new PiProbeValidationError({
          operation: "abort",
          detail: "Pi did not start the abort probe tool.",
        });
      }
      const abortExit = yield* Effect.exit(
        connection.request({ type: "abort" }, `${input.requestId}-abort`),
      );
      if (Exit.isFailure(abortExit)) {
        yield* Fiber.interrupt(promptFiber);
        yield* Fiber.interrupt(eventFiber);
        return yield* Effect.failCause(abortExit.cause);
      }
    }

    const promptExit = yield* Fiber.join(promptFiber).pipe(Effect.exit);
    if (Exit.isFailure(promptExit)) {
      yield* Fiber.interrupt(eventFiber);
      return yield* Effect.failCause(promptExit.cause);
    }

    const settledValue = yield* Deferred.await(settled).pipe(
      Effect.timeoutOption(Duration.millis(input.timeoutMs)),
    );
    yield* Fiber.interrupt(eventFiber);
    if (Option.isNone(settledValue)) {
      yield* Fiber.interrupt(promptFiber);
      return yield* new PiProbeValidationError({
        operation: "turn",
        detail: "Pi turn did not emit agent_settled.",
      });
    }

    const assistantText = events.map(textFromEvent).join("");
    const toolStarts = events.filter((event) => event.type === "tool_execution_start").length;
    const toolEnds = events.filter((event) => event.type === "tool_execution_end").length;
    if (input.requireTool && (toolStarts === 0 || toolEnds === 0)) {
      return yield* new PiProbeValidationError({
        operation: "tool",
        detail: "Pi tool probe did not produce a complete tool execution.",
      });
    }
    if (input.expectedText !== undefined && !assistantText.includes(input.expectedText)) {
      return yield* new PiProbeValidationError({
        operation: "turn",
        detail: "Pi turn completed without the expected text marker.",
      });
    }

    return { events, assistantText, toolStarts, toolEnds } satisfies TurnObservation;
  });
}

function observedConnection(
  connection: PiRpcConnection,
  addRecords: (records: ReadonlyArray<PiRpcResponse | PiRpcEvent>) => void,
): PiRpcConnection {
  return {
    ...connection,
    request: (command, id) =>
      connection
        .request(command, id)
        .pipe(Effect.tap((response) => Effect.sync(() => addRecords([response])))),
    events: connection.events.pipe(Stream.tap((event) => Effect.sync(() => addRecords([event])))),
  };
}

function makeConnection(input: {
  readonly options: PiProbeOptions;
  readonly sessionDir: string;
  readonly sessionId: string;
}) {
  return connectPiRpc({
    binaryPath: input.options.binaryPath,
    cwd: input.options.cwd,
    args: [
      "--approve",
      "--mode",
      "rpc",
      "--session-dir",
      input.sessionDir,
      "--session-id",
      input.sessionId,
      "--extension",
      PI_SCOPED_MODELS_EXTENSION_PATH,
    ],
  });
}

function runPiVersion(options: PiProbeOptions) {
  return Effect.gen(function* () {
    const resolved = yield* resolveSpawnCommand(options.binaryPath, ["--version"]);
    return yield* spawnAndCollect(
      options.binaryPath,
      ChildProcess.make(resolved.command, resolved.args, {
        cwd: options.cwd,
        shell: resolved.shell,
      }),
    );
  });
}

function buildReport(
  version: string | null,
  scenarios: ReadonlyArray<PiProbeScenarioResult>,
  novelties: ReadonlyArray<PiProbeNovelty>,
): PiProbeReport {
  return {
    status: scenarios.some((scenario) => scenario.status === "failed") ? "failed" : "passed",
    version,
    scenarios,
    novelties,
  };
}

/** Run the real Pi maintenance probe. The caller owns an Effect scope. */
export const runPiCompatibilityProbe = Effect.fn("runPiCompatibilityProbe")(function* (
  options: PiProbeOptions,
) {
  const fs = yield* FileSystem.FileSystem;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-pi-compatibility-probe-" });
  const sessionDir = NodePath.join(root, "session");
  yield* fs.makeDirectory(sessionDir, { recursive: true });
  const markerPath = NodePath.join(root, "probe-marker.txt");
  yield* fs.writeFileString(markerPath, `${TOOL_MARKER}\n`);

  const versionExit = yield* runPiVersion(options).pipe(
    Effect.timeoutOption(Duration.millis(VERSION_TIMEOUT_MS)),
    Effect.exit,
  );
  if (Exit.isFailure(versionExit)) {
    return buildReport(
      null,
      [
        { name: "version", status: "failed", detail: "Could not execute pi --version." },
        ...(
          [
            "handshake",
            "catalog",
            "thinking",
            "text",
            "tool",
            "abort",
            "shutdown",
            "resume",
          ] as const
        ).map((name) => skippedScenario(name, "Pi version probe failed.")),
      ],
      [],
    );
  }
  if (Option.isNone(versionExit.value)) {
    return buildReport(
      null,
      [
        { name: "version", status: "failed", detail: "pi --version timed out." },
        ...(
          [
            "handshake",
            "catalog",
            "thinking",
            "text",
            "tool",
            "abort",
            "shutdown",
            "resume",
          ] as const
        ).map((name) => skippedScenario(name, "Pi version probe timed out.")),
      ],
      [],
    );
  }

  const versionResult = versionExit.value.value;
  const version = parseGenericCliVersion(`${versionResult.stdout}\n${versionResult.stderr}`);
  if (versionResult.code !== 0 || version === null) {
    return buildReport(
      version,
      [
        {
          name: "version",
          status: "failed",
          detail:
            version === null
              ? "pi --version did not report a semantic version."
              : `pi --version exited with code ${versionResult.code}.`,
        },
        ...(
          [
            "handshake",
            "catalog",
            "thinking",
            "text",
            "tool",
            "abort",
            "shutdown",
            "resume",
          ] as const
        ).map((name) => skippedScenario(name, "Pi version probe failed.")),
      ],
      [],
    );
  }

  const versionCompatibility = assessPiVersion(version);
  if (Result.isFailure(versionCompatibility)) {
    return buildReport(
      version,
      [
        { name: "version", status: "failed", detail: versionCompatibility.failure.message },
        ...(
          [
            "handshake",
            "catalog",
            "thinking",
            "text",
            "tool",
            "abort",
            "shutdown",
            "resume",
          ] as const
        ).map((name) => skippedScenario(name, `Requires Pi >= ${MINIMUM_PI_VERSION}.`)),
      ],
      [],
    );
  }

  const scenarios: PiProbeScenarioResult[] = [{ name: "version", status: "passed" }];
  const novelties: PiProbeNovelty[] = [];
  const noveltyKeys = new Set<string>();
  const addRecords = (records: ReadonlyArray<PiRpcResponse | PiRpcEvent>) => {
    for (const novelty of collectPiProbeNovelties(records)) {
      const key = `${novelty.kind}:${novelty.path}`;
      if (noveltyKeys.has(key)) continue;
      noveltyKeys.add(key);
      novelties.push(novelty);
    }
  };
  const sessionId = `t3-probe-${NodeCrypto.randomUUID()}`;
  const connectionExit = yield* makeConnection({ options, sessionDir, sessionId }).pipe(
    Effect.exit,
  );
  if (Exit.isFailure(connectionExit)) {
    scenarios.push({ name: "handshake", status: "failed", detail: "Could not start Pi RPC." });
    for (const name of [
      "catalog",
      "thinking",
      "text",
      "tool",
      "abort",
      "shutdown",
      "resume",
    ] as const) {
      scenarios.push(skippedScenario(name, "Pi RPC process did not start."));
    }
    return buildReport(version, scenarios, novelties);
  }

  const rawConnection = connectionExit.value;
  const connection = observedConnection(rawConnection, addRecords);
  let state: PiRpcGetStateResponse;
  const stateExit = yield* Effect.exit(
    connection.request({ type: "get_state" }, "pi-probe-handshake"),
  );
  if (Exit.isFailure(stateExit)) {
    scenarios.push({
      name: "handshake",
      status: "failed",
      detail: safeFailure(Cause.squash(stateExit.cause), "handshake"),
    });
    for (const name of ["catalog", "thinking", "text", "tool", "abort"] as const) {
      scenarios.push(skippedScenario(name, "Pi handshake failed."));
    }
    const shutdownExit = yield* Effect.exit(connection.close);
    scenarios.push(scenarioResult("shutdown", shutdownExit));
    scenarios.push(skippedScenario("resume", "Pi handshake failed."));
    return buildReport(version, scenarios, novelties);
  }
  const decodedState = decodeGetStateResponse(stateExit.value);
  if (Option.isNone(decodedState)) {
    scenarios.push({
      name: "handshake",
      status: "failed",
      detail: new PiRpcErrors.PiRpcCompatibilityError({
        operation: "get_state",
        piVersion: version,
        missingRequirement: "data.sessionId",
      }).message,
    });
    for (const name of ["catalog", "thinking", "text", "tool", "abort"] as const) {
      scenarios.push(skippedScenario(name, "Pi handshake failed."));
    }
    const shutdownExit = yield* Effect.exit(connection.close);
    scenarios.push(scenarioResult("shutdown", shutdownExit));
    scenarios.push(skippedScenario("resume", "Pi handshake failed."));
    return buildReport(version, scenarios, novelties);
  }
  state = decodedState.value;
  const compatibility = assessPiCompatibility({ version, state });
  if (Result.isFailure(compatibility)) {
    scenarios.push({ name: "handshake", status: "failed", detail: compatibility.failure.message });
    for (const name of ["catalog", "thinking", "text", "tool", "abort"] as const) {
      scenarios.push(skippedScenario(name, "Pi handshake failed."));
    }
    const shutdownExit = yield* Effect.exit(connection.close);
    scenarios.push(scenarioResult("shutdown", shutdownExit));
    scenarios.push(skippedScenario("resume", "Pi handshake failed."));
    return buildReport(version, scenarios, novelties);
  }
  const sessionIdFromState = state.data.sessionId;
  if (compatibility.success !== sessionId || sessionIdFromState !== sessionId) {
    scenarios.push({
      name: "handshake",
      status: "failed",
      detail: "Pi confirmed an unexpected session id.",
    });
    for (const name of ["catalog", "thinking", "text", "tool", "abort"] as const) {
      scenarios.push(skippedScenario(name, "Pi session identity did not match."));
    }
    const shutdownExit = yield* Effect.exit(connection.close);
    scenarios.push(scenarioResult("shutdown", shutdownExit));
    scenarios.push(skippedScenario("resume", "Pi session identity did not match."));
    return buildReport(version, scenarios, novelties);
  }
  scenarios.push({ name: "handshake", status: "passed" });

  const catalogExit = yield* Effect.exit(
    readPiModelCatalog({
      connection,
      version,
      operationId: `probe-${NodeCrypto.randomUUID()}`,
    }),
  );
  let catalog: PiProviderCatalog | undefined;
  if (Exit.isFailure(catalogExit)) {
    scenarios.push({
      name: "catalog",
      status: "failed",
      detail: safeFailure(Cause.squash(catalogExit.cause), "catalog"),
    });
  } else {
    catalog = catalogExit.value;
    scenarios.push({
      name: "catalog",
      status: catalog.models.length > 0 ? "passed" : "failed",
      detail:
        catalog.models.length === 0
          ? "Pi returned an empty model catalog."
          : catalog.usedScopedModels
            ? "Scoped model catalog returned."
            : "Scoped catalog was empty; available-model fallback returned.",
    });
  }

  const model = options.model ?? modelParts(state.data.model);
  const thinkingExit = yield* Effect.exit(
    Effect.gen(function* () {
      const response = yield* connection.request(
        { type: "get_available_thinking_levels" },
        "pi-probe-thinking-catalog",
      );
      const levels = decodeAvailableThinkingLevelsResponse(response);
      if (Option.isNone(levels) || levels.value.length === 0) {
        return yield* new PiProbeValidationError({
          operation: "thinking",
          detail: "Pi returned an incompatible thinking-level catalog.",
        });
      }
      const requestedThinking =
        options.thinking ?? stringValue(state.data.thinkingLevel) ?? levels.value[0];
      if (requestedThinking === undefined || !levels.value.includes(requestedThinking)) {
        return yield* new PiProbeValidationError({
          operation: "thinking",
          detail: "Requested Pi thinking level is not advertised by the binary.",
        });
      }
      if (typeof model === "string") {
        const separator = model.indexOf("/");
        yield* connection.request(
          {
            type: "set_model",
            provider: model.slice(0, separator),
            modelId: model.slice(separator + 1),
          },
          "pi-probe-set-model",
        );
      } else if (model !== undefined) {
        yield* connection.request(
          { type: "set_model", provider: model.provider, modelId: model.modelId },
          "pi-probe-set-model",
        );
      } else if (catalog?.models[0] !== undefined) {
        const separator = catalog.models[0].slug.indexOf("/");
        yield* connection.request(
          {
            type: "set_model",
            provider: catalog.models[0].slug.slice(0, separator),
            modelId: catalog.models[0].slug.slice(separator + 1),
          },
          "pi-probe-set-model",
        );
      }
      yield* connection.request(
        { type: "set_thinking_level", level: requestedThinking },
        "pi-probe-set-thinking",
      );
    }),
  );
  scenarios.push(scenarioResult("thinking", thinkingExit));

  const textExit = yield* Effect.exit(
    runTurn(connection, {
      message: `Reply exactly with ${TOOL_MARKER.replace("TOOL", "TEXT")} and nothing else. Do not use tools.`,
      requestId: "pi-probe-text",
      expectedText: "PI_PROBE_TEXT_OK",
      timeoutMs: options.timeoutMs,
    }),
  );
  scenarios.push(scenarioResult("text", textExit));

  const toolExit = yield* Effect.exit(
    runTurn(connection, {
      message: `Use the built-in read tool exactly once to read ${markerPath}. After it returns, reply exactly with ${TOOL_MARKER}.`,
      requestId: "pi-probe-tool",
      expectedText: TOOL_MARKER,
      requireTool: true,
      timeoutMs: options.timeoutMs,
    }),
  );
  scenarios.push(scenarioResult("tool", toolExit));

  const abortExit = yield* Effect.exit(
    runTurn(connection, {
      message: "Use the built-in bash tool to run `sleep 30`. Do not answer until it finishes.",
      requestId: "pi-probe-abort",
      abortAfterTool: true,
      timeoutMs: options.timeoutMs,
    }),
  );
  scenarios.push(scenarioResult("abort", abortExit));

  const shutdownExit = yield* Effect.exit(connection.close);
  scenarios.push(
    Exit.isFailure(shutdownExit)
      ? scenarioResult("shutdown", shutdownExit)
      : { name: "shutdown", status: "passed" },
  );

  const resumeExit = yield* Effect.exit(
    Effect.gen(function* () {
      const resumedRaw = yield* makeConnection({ options, sessionDir, sessionId });
      const resumed = observedConnection(resumedRaw, addRecords);
      const resumedStateResponse = yield* resumed.request({ type: "get_state" }, "pi-probe-resume");
      const resumedState = decodeGetStateResponse(resumedStateResponse);
      if (Option.isNone(resumedState)) {
        return yield* new PiProbeValidationError({
          operation: "resume",
          detail: "Pi resume get_state response is incompatible.",
        });
      }
      if (resumedState.value.data.sessionId !== sessionId) {
        return yield* new PiProbeValidationError({
          operation: "resume",
          detail: "Pi resume returned a different session id.",
        });
      }
      yield* resumed.close;
    }),
  );
  scenarios.push(scenarioResult("resume", resumeExit));

  return buildReport(version, scenarios, novelties);
});

const HELP = `Usage: node apps/server/scripts/pi-compatibility-probe.ts [options]

Runs a manual compatibility probe against the installed Pi binary. This may
make real model/tool calls. It never updates fixtures and cleans temporary
session state before exiting.

Options:
  --binary <path>       Pi executable (default: pi)
  --cwd <path>          Pi working directory (default: current directory)
  --model <provider/id> Select a model before the turn checks
  --thinking <level>    Select a thinking level advertised by Pi
  --timeout-ms <n>      Per-turn timeout (default: 120000)
  --json                Emit a machine-readable report
  --help                Show this help
`;

async function main(): Promise<void> {
  const parsed = parsePiProbeArguments(process.argv.slice(2), { cwd: process.cwd() });
  if (parsed._tag === "help") {
    process.stdout.write(HELP);
    return;
  }
  if (parsed._tag === "error") {
    process.stderr.write(`${parsed.message}\n\n${HELP}`);
    process.exitCode = 2;
    return;
  }

  const report = await Effect.runPromise(
    runPiCompatibilityProbe({ ...parsed.options, cwd: NodePath.resolve(parsed.options.cwd) }).pipe(
      Effect.scoped,
      Effect.provide(NodeServices.layer),
    ),
  );
  if (parsed.options.output === "json") {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    process.stdout.write(formatPiProbeReport(report));
  }
  process.exitCode = report.status === "passed" ? 0 : 1;
}

if (import.meta.main) {
  main().catch((_error: unknown) => {
    process.stderr.write("Pi compatibility probe failed before producing a report.\n");
    process.exitCode = 1;
  });
}
