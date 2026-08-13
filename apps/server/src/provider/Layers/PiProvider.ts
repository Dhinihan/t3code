// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import * as NodePath from "node:path";

import * as Cause from "effect/Cause";
import * as Data from "effect/Data";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/unstable/process/ChildProcess";

import {
  TrimmedNonEmptyString,
  type ModelCapabilities,
  type ServerProviderModel,
} from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { createModelCapabilities } from "@t3tools/shared/model";
import { resolveSpawnCommand } from "@t3tools/shared/shell";

import {
  buildServerProvider,
  detailFromResult,
  isCommandMissingCause,
  parseGenericCliVersion,
  spawnAndCollect,
  type CommandResult,
  type ServerProviderDraft,
} from "../providerSnapshot.ts";
import { assessPiCompatibility } from "./PiCompatibility.ts";
import { connectPiRpc, type PiRpcConnection } from "./PiRpcConnection.ts";
import { decodeGetStateResponse, type PiRpcResponse } from "./PiRpcContract.ts";
import type * as PiRpcErrors from "./PiRpcErrors.ts";
import {
  makePiScopedModelsStatusKey,
  PI_SCOPED_MODELS_COMMAND,
} from "../pi/PiScopedModelsExtension.ts";

export const PI_PROVIDER_BINARY = "pi";
export const PI_SCOPED_MODELS_EXTENSION_PATH = NodePath.join(
  import.meta.dirname,
  "../pi/PiScopedModelsExtension.ts",
);
export const PI_VERSION_PROBE_TIMEOUT_MS = 4_000;
export const PI_CATALOG_PROBE_TIMEOUT_MS = 10_000;
export const PI_SCOPED_MODELS_TIMEOUT_MS = 4_000;

const PI_PRESENTATION = {
  displayName: "Pi",
  showInteractionModeToggle: false,
  requiresNewThreadForModelChange: false,
} as const;

const PI_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
type PiThinkingLevel = (typeof PI_THINKING_LEVELS)[number];

const PI_THINKING_LABELS: Record<PiThinkingLevel, string> = {
  off: "Off",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra High",
  max: "Max",
};

export interface PiProviderSettings {
  readonly enabled: boolean;
  readonly binaryPath: string;
  readonly cwd?: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly extensionPath?: string;
}

export interface PiModelDescriptor {
  readonly provider: string;
  readonly id: string;
  readonly name?: string | undefined;
  readonly reasoning?: boolean | undefined;
  readonly thinkingLevelMap?: Readonly<Record<string, string | null>> | undefined;
}

export interface PiScopedModelDescriptor {
  readonly model: PiModelDescriptor;
  readonly thinkingLevel?: string | undefined;
}

export type PiRpcProbeConnection = PiRpcConnection;

export interface PiProviderCatalog {
  readonly models: ReadonlyArray<ServerProviderModel>;
  readonly usedScopedModels: boolean;
  readonly sessionId: string;
}

export class PiProviderCatalogError extends Data.TaggedError("PiProviderCatalogError")<{
  readonly operation: string;
  readonly detail: string;
}> {}

export class PiProviderProbeDependencyError extends Data.TaggedError(
  "PiProviderProbeDependencyError",
)<{
  readonly detail: string;
  readonly missingCommand: boolean;
}> {}

/** Injectable only for hermetic tests; production uses the two functions below. */
export interface PiProviderProbeDependencies {
  readonly runVersion?: (
    settings: PiProviderSettings,
  ) => Effect.Effect<CommandResult, PiProviderProbeDependencyError>;
  readonly connect?: (
    settings: PiProviderSettings,
  ) => Effect.Effect<
    PiRpcConnection,
    PiProviderProbeDependencyError | PiRpcErrors.PiRpcError,
    Scope.Scope | typeof HostProcessPlatform
  >;
}

const PiModelSchema = Schema.Struct({
  provider: TrimmedNonEmptyString,
  id: TrimmedNonEmptyString,
  name: Schema.optional(Schema.String),
  reasoning: Schema.optional(Schema.Boolean),
  thinkingLevelMap: Schema.optional(Schema.Record(Schema.String, Schema.NullOr(Schema.String))),
});

const PiAvailableModelsData = Schema.Struct({
  models: Schema.Array(PiModelSchema),
});

const PiScopedModelSchema = Schema.Struct({
  model: PiModelSchema,
  thinkingLevel: Schema.optional(Schema.String),
});

const PiScopedModelsPayload = Schema.Struct({
  version: Schema.Literal(1),
  models: Schema.Array(PiScopedModelSchema),
  error: Schema.optional(Schema.String),
});

const decodeAvailableModels = Schema.decodeUnknownOption(PiAvailableModelsData);
const decodeScopedModelsPayload = Schema.decodeUnknownOption(PiScopedModelsPayload);
const decodeJsonPayload = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));

function normalizePiModel(model: PiModelDescriptor): PiModelDescriptor {
  return {
    provider: model.provider.trim(),
    id: model.id.trim(),
    ...(model.name !== undefined ? { name: model.name.trim() } : {}),
    ...(model.reasoning !== undefined ? { reasoning: model.reasoning } : {}),
    ...(model.thinkingLevelMap !== undefined ? { thinkingLevelMap: model.thinkingLevelMap } : {}),
  };
}

function supportedThinkingLevels(model: PiModelDescriptor): ReadonlyArray<PiThinkingLevel> {
  if (model.reasoning !== true) {
    return ["off"];
  }

  // Pi omits a level from thinkingLevelMap when the standard level is
  // supported, and uses null to explicitly exclude one.
  return PI_THINKING_LEVELS.filter((level) => model.thinkingLevelMap?.[level] !== null);
}

function makeThinkingCapabilities(
  model: PiModelDescriptor,
  pinnedLevel: string | undefined,
): ModelCapabilities {
  const levels = supportedThinkingLevels(model);
  if (levels.length === 0) {
    return createModelCapabilities({ optionDescriptors: [] });
  }

  const currentValue = levels.includes(pinnedLevel as PiThinkingLevel) ? pinnedLevel : undefined;
  return createModelCapabilities({
    optionDescriptors: [
      {
        id: "thinking",
        label: "Thinking",
        type: "select",
        options: levels.map((level) => ({
          id: level,
          label: PI_THINKING_LABELS[level],
          ...(currentValue === level ? { isDefault: true } : {}),
        })),
        ...(currentValue ? { currentValue } : {}),
      },
    ],
  });
}

export function mapPiModelToServerModel(
  model: PiModelDescriptor,
  pinnedThinkingLevel?: string,
): ServerProviderModel {
  const normalized = normalizePiModel(model);
  const slug = `${normalized.provider}/${normalized.id}`;
  return {
    slug,
    name: normalized.name || normalized.id,
    subProvider: normalized.provider,
    isCustom: false,
    capabilities: makeThinkingCapabilities(normalized, pinnedThinkingLevel),
  };
}

export function mapPiScopedModelsToServerModels(
  models: ReadonlyArray<PiScopedModelDescriptor>,
): ReadonlyArray<ServerProviderModel> {
  const seen = new Set<string>();
  return models.flatMap((entry) => {
    const mapped = mapPiModelToServerModel(entry.model, entry.thinkingLevel);
    if (seen.has(mapped.slug)) {
      return [];
    }
    seen.add(mapped.slug);
    return [mapped];
  });
}

function mapPiModelsToServerModels(
  models: ReadonlyArray<PiModelDescriptor>,
): ReadonlyArray<ServerProviderModel> {
  return mapPiScopedModelsToServerModels(models.map((model) => ({ model })));
}

/** The adapter uses this seam after Pi rejects a model selection as stale. */
export function isPiModelSelectionStale(
  models: ReadonlyArray<ServerProviderModel>,
  selectedModel: string | undefined,
): boolean {
  return selectedModel !== undefined && !models.some((model) => model.slug === selectedModel);
}

function responseData(
  response: PiRpcResponse,
  operation: string,
): Effect.Effect<unknown, PiProviderCatalogError> {
  return response.success === true
    ? Effect.succeed(response.data)
    : Effect.fail(
        new PiProviderCatalogError({
          operation,
          detail: response.error ?? `Pi RPC command '${operation}' failed.`,
        }),
      );
}

function decodeRequired<A>(
  option: Option.Option<A>,
  operation: string,
): Effect.Effect<A, PiProviderCatalogError> {
  return Option.isSome(option)
    ? Effect.succeed(option.value)
    : Effect.fail(
        new PiProviderCatalogError({
          operation,
          detail: `Pi returned an unexpected ${operation} response.`,
        }),
      );
}

function parseJsonPayload(
  raw: string | undefined,
  operation: string,
): Effect.Effect<unknown, PiProviderCatalogError> {
  if (typeof raw !== "string") {
    return Effect.fail(
      new PiProviderCatalogError({
        operation,
        detail: "Pi scoped-models extension returned no status payload.",
      }),
    );
  }

  const parsed = decodeJsonPayload(raw);
  return Option.isSome(parsed)
    ? Effect.succeed(parsed.value)
    : Effect.fail(
        new PiProviderCatalogError({
          operation,
          detail: "Pi scoped-models extension returned malformed JSON.",
        }),
      );
}

export const readPiModelCatalog = Effect.fn("readPiModelCatalog")(function* (input: {
  readonly connection: PiRpcProbeConnection;
  readonly version: string;
  readonly operationId?: string;
}): Effect.fn.Return<
  PiProviderCatalog,
  PiRpcErrors.PiRpcError | PiProviderCatalogError,
  Scope.Scope
> {
  const stateResponse = yield* input.connection.request(
    { type: "get_state" },
    `t3-state-${NodeCrypto.randomUUID()}`,
  );
  const state = yield* decodeRequired(decodeGetStateResponse(stateResponse), "get_state");
  const compatibility = assessPiCompatibility({ version: input.version, state });
  if (compatibility._tag === "Failure") {
    return yield* compatibility.failure;
  }

  const operationId = input.operationId ?? NodeCrypto.randomUUID();
  const statusKey = makePiScopedModelsStatusKey(operationId);
  const scopedEventResult = yield* Effect.gen(function* () {
    const eventFiber = yield* input.connection.events.pipe(
      Stream.filter(
        (event) =>
          event.type === "extension_ui_request" &&
          event.method === "setStatus" &&
          event.statusKey === statusKey,
      ),
      Stream.take(1),
      Stream.runHead,
      Effect.timeoutOption(PI_SCOPED_MODELS_TIMEOUT_MS),
      Effect.forkScoped,
    );

    const promptExit = yield* Effect.exit(
      input.connection.request(
        {
          type: "prompt",
          message: `/${PI_SCOPED_MODELS_COMMAND} ${operationId}`,
        },
        `t3-scoped-models-${NodeCrypto.randomUUID()}`,
      ),
    );
    if (Exit.isFailure(promptExit)) {
      yield* Fiber.interrupt(eventFiber);
      return yield* Effect.failCause(promptExit.cause);
    }

    return yield* Fiber.join(eventFiber).pipe(Effect.ensuring(Fiber.interrupt(eventFiber)));
  });
  // `runHead` already returns an Option; `timeoutOption` adds a second one
  // for the deadline. Flatten them before inspecting the event itself.
  const scopedEvent = Option.flatten(scopedEventResult);

  if (Option.isNone(scopedEvent)) {
    return yield* new PiProviderCatalogError({
      operation: "scoped_models",
      detail: "Pi scoped-models extension did not return a response.",
    });
  }

  const scopedJson = yield* parseJsonPayload(scopedEvent.value.statusText, "scoped_models");
  const scopedPayload = yield* decodeRequired(
    decodeScopedModelsPayload(scopedJson),
    "scoped_models",
  );
  if (scopedPayload.error !== undefined) {
    return yield* new PiProviderCatalogError({
      operation: "scoped_models",
      detail: scopedPayload.error,
    });
  }

  if (scopedPayload.models.length > 0) {
    return {
      models: mapPiScopedModelsToServerModels(scopedPayload.models),
      usedScopedModels: true,
      sessionId: compatibility.success,
    };
  }

  const availableResponse = yield* input.connection.request(
    { type: "get_available_models" },
    `t3-models-${NodeCrypto.randomUUID()}`,
  );
  const availableData = yield* responseData(availableResponse, "get_available_models");
  const available = yield* decodeRequired(
    decodeAvailableModels(availableData),
    "get_available_models",
  );

  return {
    models: mapPiModelsToServerModels(available.models),
    usedScopedModels: false,
    sessionId: compatibility.success,
  };
});

function runPiVersionCommand(settings: PiProviderSettings) {
  const binaryPath = settings.binaryPath.trim() || PI_PROVIDER_BINARY;
  const environment = settings.environment ?? process.env;
  return Effect.gen(function* () {
    const resolved = yield* resolveSpawnCommand(binaryPath, ["--version"], {
      env: environment,
      extendEnv: false,
    });
    return yield* spawnAndCollect(
      binaryPath,
      ChildProcess.make(resolved.command, resolved.args, {
        cwd: settings.cwd ?? process.cwd(),
        env: environment,
        extendEnv: false,
        shell: resolved.shell,
      }),
    );
  }).pipe(
    Effect.mapError(
      (error) =>
        new PiProviderProbeDependencyError({
          detail: errorMessage(error),
          missingCommand: isCommandMissingCause(error),
        }),
    ),
  );
}

function connectPiProbe(settings: PiProviderSettings) {
  return connectPiRpc({
    binaryPath: settings.binaryPath.trim() || PI_PROVIDER_BINARY,
    cwd: settings.cwd ?? process.cwd(),
    args: [
      "--mode",
      "rpc",
      "--approve",
      "--no-session",
      "--extension",
      settings.extensionPath ?? PI_SCOPED_MODELS_EXTENSION_PATH,
    ],
    ...(settings.environment !== undefined ? { environment: settings.environment } : {}),
  });
}

function providerSnapshot(input: {
  readonly settings: PiProviderSettings;
  readonly checkedAt: string;
  readonly models: ReadonlyArray<ServerProviderModel>;
  readonly installed: boolean;
  readonly version: string | null;
  readonly status: "ready" | "warning" | "error";
  readonly message?: string;
}) {
  return buildServerProvider({
    presentation: PI_PRESENTATION,
    enabled: input.settings.enabled,
    checkedAt: input.checkedAt,
    models: input.models,
    probe: {
      installed: input.installed,
      version: input.version,
      status: input.status,
      auth: { status: "unknown", type: "pi", label: "Pi" },
      ...(input.message ? { message: input.message } : {}),
    },
  });
}

function errorMessage(error: unknown): string {
  if (error instanceof PiProviderCatalogError) {
    return error.detail;
  }
  if (error instanceof PiProviderProbeDependencyError) {
    return error.detail;
  }
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }
  return "Unexpected Pi provider probe failure.";
}

export const checkPiProviderStatus = Effect.fn("checkPiProviderStatus")(function* (
  settings: PiProviderSettings,
  dependencies: PiProviderProbeDependencies = {},
) {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  if (!settings.enabled) {
    return providerSnapshot({
      settings,
      checkedAt,
      models: [],
      installed: false,
      version: null,
      status: "warning",
      message: "Pi is disabled in T3 Code settings.",
    });
  }

  const versionEffect = dependencies.runVersion
    ? dependencies.runVersion(settings)
    : runPiVersionCommand(settings);
  const versionResult = yield* versionEffect.pipe(
    Effect.timeoutOption(PI_VERSION_PROBE_TIMEOUT_MS),
    Effect.result,
  );
  if (versionResult._tag === "Failure") {
    const error = versionResult.failure;
    const missingCommand =
      error instanceof PiProviderProbeDependencyError
        ? error.missingCommand
        : isCommandMissingCause(error);
    return providerSnapshot({
      settings,
      checkedAt,
      models: [],
      installed: !missingCommand,
      version: null,
      status: "error",
      message: missingCommand
        ? "Pi CLI (`pi`) is not installed or not on PATH."
        : `Pi CLI version probe failed: ${errorMessage(error)}`,
    });
  }
  if (Option.isNone(versionResult.success)) {
    return providerSnapshot({
      settings,
      checkedAt,
      models: [],
      installed: true,
      version: null,
      status: "error",
      message: "Pi CLI is installed but timed out while running `pi --version`.",
    });
  }

  const versionOutput = versionResult.success.value;
  const version = parseGenericCliVersion(`${versionOutput.stdout}\n${versionOutput.stderr}`);
  if (versionOutput.code !== 0 || version === null) {
    const detail = detailFromResult(versionOutput);
    return providerSnapshot({
      settings,
      checkedAt,
      models: [],
      installed: true,
      version,
      status: "error",
      message:
        version === null
          ? "Pi CLI is installed but did not report a semantic version."
          : `Pi CLI version probe failed${detail ? `: ${detail}` : "."}`,
    });
  }

  const catalogExit = yield* Effect.scoped(
    Effect.gen(function* () {
      const connection = yield* dependencies.connect?.(settings) ?? connectPiProbe(settings);
      return yield* readPiModelCatalog({ connection, version }).pipe(
        Effect.ensuring(connection.close),
      );
    }),
  ).pipe(Effect.timeoutOption(PI_CATALOG_PROBE_TIMEOUT_MS), Effect.exit);

  if (catalogExit._tag === "Failure") {
    return providerSnapshot({
      settings,
      checkedAt,
      models: [],
      installed: true,
      version,
      status: "error",
      message: `Pi provider probe failed: ${errorMessage(Cause.squash(catalogExit.cause))}`,
    });
  }
  if (Option.isNone(catalogExit.value)) {
    return providerSnapshot({
      settings,
      checkedAt,
      models: [],
      installed: true,
      version,
      status: "error",
      message: `Pi provider probe timed out after ${PI_CATALOG_PROBE_TIMEOUT_MS}ms.`,
    });
  }

  const catalog = catalogExit.value.value;
  return providerSnapshot({
    settings,
    checkedAt,
    models: catalog.models,
    installed: true,
    version,
    status: catalog.models.length > 0 ? "ready" : "warning",
    ...(catalog.models.length > 0
      ? {}
      : { message: "Pi is available, but it did not report any models." }),
  });
});

export function buildInitialPiProviderSnapshot(
  settings: PiProviderSettings,
): Effect.Effect<ServerProviderDraft> {
  return Effect.gen(function* () {
    const checkedAt = DateTime.formatIso(yield* DateTime.now);
    return providerSnapshot({
      settings,
      checkedAt,
      models: [],
      installed: settings.enabled,
      version: null,
      status: "warning",
      message: settings.enabled
        ? "Checking Pi availability..."
        : "Pi is disabled in T3 Code settings.",
    });
  });
}
