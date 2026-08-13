import * as Schema from "effect/Schema";

import { assert, it } from "@effect/vitest";

import extension, {
  makePiScopedModelsStatusKey,
  PI_SCOPED_MODELS_COMMAND,
} from "./PiScopedModelsExtension.ts";

const decodeJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));

interface RegisteredCommand {
  readonly handler: (
    args: string,
    context: {
      readonly scopedModels?: ReadonlyArray<unknown>;
      readonly ui: { readonly setStatus: (key: string, text: string) => void };
    },
  ) => void;
}

it("publishes only the scoped model data through the namespaced status event", () => {
  let registered: RegisteredCommand | undefined;
  extension({
    registerCommand: (name, options) => {
      assert.equal(name, PI_SCOPED_MODELS_COMMAND);
      registered = options;
    },
  });

  assert.isDefined(registered);
  if (!registered) return;

  let status: { key: string; text: string } | undefined;
  registered.handler("operation-1", {
    scopedModels: [
      {
        model: {
          provider: "openai-codex",
          id: "gpt-5.6-luna",
          name: "GPT-5.6 Luna",
          reasoning: true,
          thinkingLevelMap: { high: "high", max: null },
          ignoredRuntimeField: "not forwarded",
        },
        thinkingLevel: "high",
      },
      null,
    ],
    ui: {
      setStatus: (key, text) => {
        status = { key, text };
      },
    },
  });

  assert.isDefined(status);
  if (!status) return;
  assert.equal(status.key, makePiScopedModelsStatusKey("operation-1"));
  assert.deepEqual(decodeJson(status.text), {
    version: 1,
    models: [
      {
        model: {
          provider: "openai-codex",
          id: "gpt-5.6-luna",
          name: "GPT-5.6 Luna",
          reasoning: true,
          thinkingLevelMap: { high: "high", max: null },
        },
        thinkingLevel: "high",
      },
    ],
  });
});
