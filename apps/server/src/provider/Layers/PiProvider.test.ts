// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { assert, describe, it } from "@effect/vitest";

import {
  buildInitialPiProviderSnapshot,
  checkPiProviderStatus,
  PI_SCOPED_MODELS_EXTENSION_PATH,
  isPiModelSelectionStale,
  mapPiModelToServerModel,
  mapPiScopedModelsToServerModels,
  readPiModelCatalog,
  type PiModelDescriptor,
  type PiRpcProbeConnection,
  type PiScopedModelDescriptor,
} from "./PiProvider.ts";
import { connectPiRpc } from "./PiRpcConnection.ts";
import {
  PI_SCOPED_MODELS_STATUS_PREFIX,
  makePiScopedModelsStatusKey,
} from "../pi/PiScopedModelsExtension.ts";

const model = (overrides: Partial<PiModelDescriptor> = {}): PiModelDescriptor => ({
  provider: "openai-codex",
  id: "gpt-5.6-luna",
  name: "GPT-5.6 Luna",
  reasoning: true,
  thinkingLevelMap: {
    minimal: "low",
    xhigh: "xhigh",
    max: "max",
  },
  ...overrides,
});

const connection = (input: {
  readonly responses: ReadonlyArray<unknown>;
  readonly events: ReadonlyArray<unknown>;
}): PiRpcProbeConnection => ({
  pid: 1,
  request: (command) => {
    const response =
      command.type === "get_state"
        ? input.responses[0]
        : command.type === "get_available_models"
          ? input.responses[1]
          : {
              type: "response",
              id: "prompt",
              command: "prompt",
              success: true,
            };
    if (response === undefined) {
      return Effect.die("test connection ran out of responses");
    }
    return Effect.succeed(response as never);
  },
  events: Stream.fromIterable(input.events as ReadonlyArray<never>),
  stderr: Effect.succeed(""),
  close: Effect.void,
});

const stateResponse = {
  type: "response",
  id: "state",
  command: "get_state",
  success: true,
  data: { sessionId: "sess-1" },
};

const availableResponse = (models: ReadonlyArray<PiModelDescriptor>) => ({
  type: "response",
  id: "available",
  command: "get_available_models",
  success: true,
  data: { models },
});

const encodeJson = Schema.encodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
const decodeJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));

const PEER_PATH = NodePath.join(import.meta.dirname, "../testFixtures/piRpcMockPeer.mjs");
let scriptCounter = 0;

const makePeerScript = (value: Record<string, unknown>): string => {
  scriptCounter += 1;
  const path = NodePath.join(
    NodeOS.tmpdir(),
    `pi-provider-peer-script-${process.pid}-${scriptCounter}.json`,
  );
  NodeFS.writeFileSync(path, encodeJson(value), "utf8");
  return path;
};

const runLive = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.provide(NodeServices.layer), Effect.scoped) as unknown as Effect.Effect<
    A,
    E,
    never
  >;

describe("Pi model snapshot mapping", () => {
  it("maps provider and model id into a stable slug and exposes editable thinking", () => {
    const mapped = mapPiModelToServerModel(model(), "high");

    assert.deepEqual(mapped, {
      slug: "openai-codex/gpt-5.6-luna",
      name: "GPT-5.6 Luna",
      subProvider: "openai-codex",
      isCustom: false,
      capabilities: {
        optionDescriptors: [
          {
            id: "thinking",
            label: "Thinking",
            type: "select",
            options: [
              { id: "off", label: "Off" },
              { id: "minimal", label: "Minimal" },
              { id: "low", label: "Low" },
              { id: "medium", label: "Medium" },
              { id: "high", label: "High", isDefault: true },
              { id: "xhigh", label: "Extra High" },
              { id: "max", label: "Max" },
            ],
            currentValue: "high",
          },
        ],
      },
    });
  });

  it("keeps scoped order and uses the scoped level without removing alternatives", () => {
    const mapped = mapPiScopedModelsToServerModels([
      { model: model({ provider: "anthropic", id: "claude-sonnet-5" }), thinkingLevel: "low" },
      { model: model({ provider: "openai-codex", id: "gpt-5.6-sol" }) },
    ]);

    assert.deepEqual(
      mapped.map((entry) => [entry.slug, entry.capabilities?.optionDescriptors?.[0]?.currentValue]),
      [
        ["anthropic/claude-sonnet-5", "low"],
        ["openai-codex/gpt-5.6-sol", undefined],
      ],
    );
  });

  it("identifies a selected model missing from a refreshed catalog", () => {
    const catalog = [mapPiModelToServerModel(model({ id: "gpt-5.6-sol" }))];

    assert.isTrue(isPiModelSelectionStale(catalog, "openai-codex/gpt-5.6-luna"));
    assert.isFalse(isPiModelSelectionStale(catalog, "openai-codex/gpt-5.6-sol"));
    assert.isFalse(isPiModelSelectionStale(catalog, undefined));
  });

  it("publishes a checking snapshot without inventing a Pi model", () =>
    Effect.gen(function* () {
      const snapshot = yield* buildInitialPiProviderSnapshot({
        enabled: true,
        binaryPath: "pi",
      });

      assert.equal(snapshot.status, "warning");
      assert.equal(snapshot.models.length, 0);
      assert.equal(snapshot.version, null);
      assert.include(snapshot.message ?? "", "Checking Pi");
    }));
});

describe("Pi model catalog probe", () => {
  it.effect("falls back to available models when the scoped list is empty", () => {
    const token = "fallback-test";
    const scopedKey = makePiScopedModelsStatusKey(token);
    const available = model({ id: "gpt-5.6-sol", name: "GPT-5.6 Sol" });
    const scopedPayload = encodeJson({ version: 1, models: [] });

    return Effect.gen(function* () {
      const catalog = yield* readPiModelCatalog({
        connection: connection({
          responses: [stateResponse, availableResponse([available])],
          events: [
            {
              type: "extension_ui_request",
              method: "setStatus",
              statusKey: scopedKey,
              statusText: scopedPayload,
            },
          ],
        }),
        version: "0.84.1",
        operationId: token,
      });

      assert.deepEqual(catalog.models, [mapPiModelToServerModel(available)]);
      assert.equal(catalog.usedScopedModels, false);
    });
  });

  it.effect("uses the scoped model and keeps its pinned thinking level", () => {
    const token = "scoped-test";
    const scoped = { model: model(), thinkingLevel: "xhigh" } satisfies PiScopedModelDescriptor;

    return Effect.gen(function* () {
      const catalog = yield* readPiModelCatalog({
        connection: connection({
          responses: [stateResponse, availableResponse([model()])],
          events: [
            {
              type: "extension_ui_request",
              method: "setStatus",
              statusKey: makePiScopedModelsStatusKey(token),
              statusText: encodeJson({ version: 1, models: [scoped] }),
            },
          ],
        }),
        version: "0.84.1",
        operationId: token,
      });

      assert.equal(catalog.usedScopedModels, true);
      assert.equal(catalog.models[0]?.slug, "openai-codex/gpt-5.6-luna");
      assert.equal(catalog.models[0]?.capabilities?.optionDescriptors?.[0]?.currentValue, "xhigh");
    });
  });

  it.effect("rejects an unexpected bridge payload instead of silently showing stale models", () => {
    const token = "unexpected-test";

    return Effect.gen(function* () {
      const result = yield* readPiModelCatalog({
        connection: connection({
          responses: [stateResponse],
          events: [
            {
              type: "extension_ui_request",
              method: "setStatus",
              statusKey: makePiScopedModelsStatusKey(token),
              statusText: "not-json",
            },
          ],
        }),
        version: "0.84.1",
        operationId: token,
      }).pipe(Effect.exit);

      assert.equal(result._tag, "Failure");
    });
  });

  it("keeps the bridge key protocol namespaced", () => {
    assert.isTrue(makePiScopedModelsStatusKey("id-1").startsWith(PI_SCOPED_MODELS_STATUS_PREFIX));
  });
});

it.live("runs the disposable snapshot probe through the hermetic Pi peer", () => {
  const script = makePeerScript({
    scopedModels: [{ model: model(), thinkingLevel: "xhigh" }],
    models: [model({ id: "gpt-5.6-sol" })],
  });
  const logPath = NodePath.join(
    NodeOS.tmpdir(),
    `pi-provider-peer-log-${process.pid}-${scriptCounter}.jsonl`,
  );

  return runLive(
    Effect.gen(function* () {
      const snapshot = yield* checkPiProviderStatus(
        {
          enabled: true,
          binaryPath: process.execPath,
          cwd: process.cwd(),
          environment: {
            ...process.env,
            PI_RPC_PEER_SCRIPT: script,
            PI_RPC_PEER_LOG: logPath,
          },
        },
        {
          runVersion: () => Effect.succeed({ stdout: "pi 0.84.1", stderr: "", code: 0 }),
          connect: (settings) =>
            connectPiRpc({
              binaryPath: process.execPath,
              cwd: settings.cwd ?? process.cwd(),
              args: [
                PEER_PATH,
                "--mode",
                "rpc",
                "--approve",
                "--no-session",
                "--extension",
                PI_SCOPED_MODELS_EXTENSION_PATH,
              ],
              ...(settings.environment !== undefined ? { environment: settings.environment } : {}),
            }).pipe(Effect.provide(NodeServices.layer)),
        },
      );

      assert.equal(snapshot.status, "ready", snapshot.message);
      assert.equal(snapshot.version, "0.84.1");
      assert.equal(snapshot.models[0]?.slug, "openai-codex/gpt-5.6-luna");
      assert.equal(snapshot.models[0]?.capabilities?.optionDescriptors?.[0]?.currentValue, "xhigh");

      const commands = NodeFS.readFileSync(logPath, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => decodeJson(line) as { kind?: string; command?: string })
        .filter((line) => line.kind === "command")
        .map((line) => line.command);
      assert.deepEqual(commands, ["get_state", "prompt"]);
    }),
  ).pipe(
    Effect.ensuring(
      Effect.sync(() => {
        NodeFS.rmSync(script, { force: true });
        NodeFS.rmSync(logPath, { force: true });
      }),
    ),
  );
});
