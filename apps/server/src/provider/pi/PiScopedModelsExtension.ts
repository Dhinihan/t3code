/**
 * The only Pi extension shipped by the T3 integration for provider probing.
 *
 * It deliberately has no imports: Pi loads this file in its own module
 * environment through `--extension`. The host asks the command to publish a
 * JSON payload through the RPC extension-UI event stream, then closes this
 * disposable process. Nothing is written to the user's Pi directory.
 */

export const PI_SCOPED_MODELS_COMMAND = "t3-scoped-models";
export const PI_SCOPED_MODELS_STATUS_PREFIX = "t3-scoped-models:";

export const makePiScopedModelsStatusKey = (operationId: string): string =>
  `${PI_SCOPED_MODELS_STATUS_PREFIX}${operationId}`;

interface PiScopedModelsContext {
  readonly scopedModels?: ReadonlyArray<unknown>;
  readonly ui: {
    readonly setStatus: (key: string, text: string) => void;
  };
}

interface PiExtensionApi {
  readonly registerCommand: (
    name: string,
    options: {
      readonly description: string;
      readonly handler: (args: string, ctx: PiScopedModelsContext) => void;
    },
  ) => void;
}

function copyThinkingLevelMap(
  model: Record<string, unknown>,
): Record<string, string | null> | undefined {
  const raw = model.thinkingLevelMap;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return undefined;
  }

  const result: Record<string, string | null> = {};
  for (const [level, value] of Object.entries(raw)) {
    if (typeof value === "string" || value === null) {
      result[level] = value;
    }
  }
  return result;
}

function copyScopedModel(entry: unknown): Record<string, unknown> | undefined {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    return undefined;
  }
  const rawModel = (entry as Record<string, unknown>).model;
  if (!rawModel || typeof rawModel !== "object" || Array.isArray(rawModel)) {
    return undefined;
  }

  const model = rawModel as Record<string, unknown>;
  const copiedModel: Record<string, unknown> = {
    provider: model.provider,
    id: model.id,
    name: model.name,
    reasoning: model.reasoning,
  };
  const thinkingLevelMap = copyThinkingLevelMap(model);
  if (thinkingLevelMap !== undefined) {
    copiedModel.thinkingLevelMap = thinkingLevelMap;
  }

  const copied: Record<string, unknown> = { model: copiedModel };
  const thinkingLevel = (entry as Record<string, unknown>).thinkingLevel;
  if (typeof thinkingLevel === "string") {
    copied.thinkingLevel = thinkingLevel;
  }

  return copied;
}

export default function (pi: PiExtensionApi) {
  pi.registerCommand(PI_SCOPED_MODELS_COMMAND, {
    description: "Return the Pi model scope to the T3 provider probe",
    handler: (args, ctx) => {
      const operationId = args.trim();
      if (!operationId) {
        return;
      }

      const payload = {
        version: 1,
        models: Array.isArray(ctx.scopedModels)
          ? ctx.scopedModels.map(copyScopedModel).filter((entry: unknown) => entry !== undefined)
          : [],
      };
      ctx.ui.setStatus(makePiScopedModelsStatusKey(operationId), JSON.stringify(payload));
    },
  });
}
