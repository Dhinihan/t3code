// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Scope from "effect/Scope";
import * as TestClock from "effect/testing/TestClock";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import { assert, describe, it } from "@effect/vitest";

import {
  buildInitialPiProviderSnapshot,
  checkPiProviderStatus,
  makePiProviderProbe,
  PI_CATALOG_PROBE_TIMEOUT_MS,
  PI_SCOPED_MODELS_TIMEOUT_MS,
  PI_VERSION_PROBE_TIMEOUT_MS,
  probePiSkillsForCwd,
  PiProviderProbeDependencyError,
  PI_SCOPED_MODELS_EXTENSION_PATH,
  isPiModelSelectionStale,
  mapPiModelToServerModel,
  mapPiScopedModelsToServerModels,
  readPiModelCatalog,
  readPiSkills,
  type PiModelDescriptor,
  type PiRpcProbeConnection,
  type PiScopedModelDescriptor,
} from "./PiProvider.ts";
import { connectPiRpc } from "./PiRpcConnection.ts";
import type { PiRpcEvent, PiRpcResponse } from "./PiRpcContract.ts";
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
  readonly getCommands?: unknown;
}): PiRpcProbeConnection => ({
  pid: 1,
  request: (command) => {
    const response =
      command.type === "get_state"
        ? input.responses[0]
        : command.type === "get_available_models"
          ? input.responses[1]
          : command.type === "get_commands"
            ? input.getCommands
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
  send: () => Effect.void,
  events: Stream.fromIterable(input.events as ReadonlyArray<never>),
  stderr: Effect.succeed(""),
  close: Effect.void,
  exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
});

const stateResponse = {
  type: "response",
  id: "state",
  command: "get_state",
  success: true,
  data: { sessionId: "sess-1" },
} satisfies PiRpcResponse;

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

  it.effect("publishes a checking snapshot without inventing a Pi model", () =>
    Effect.gen(function* () {
      const snapshot = yield* buildInitialPiProviderSnapshot({
        enabled: true,
        binaryPath: "pi",
      });

      assert.equal(snapshot.status, "warning");
      assert.equal(snapshot.models.length, 0);
      assert.equal(snapshot.version, null);
      assert.include(snapshot.message ?? "", "Checking Pi");
    }),
  );
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

const getCommandsResponse = (commands: ReadonlyArray<unknown>) => ({
  type: "response",
  id: "commands",
  command: "get_commands",
  success: true,
  data: { commands },
});

describe("Pi skills catalog probe", () => {
  it.effect("projects skills from a valid catalog and fails an invalid skill record", () =>
    Effect.gen(function* () {
      const invalid = yield* readPiSkills({
        connection: connection({
          responses: [],
          events: [],
          getCommands: getCommandsResponse([{ name: "skill:alpha", source: "skill" }]),
        }),
      }).pipe(Effect.exit);
      assert.equal(invalid._tag, "Failure");

      const skills = yield* readPiSkills({
        connection: connection({
          responses: [],
          events: [],
          getCommands: getCommandsResponse([
            { name: "review", source: "extension" },
            {
              name: "skill:alpha",
              description: "Alpha",
              source: "skill",
              sourceInfo: {
                path: "/tmp/project/.pi/skills/alpha/SKILL.md",
                origin: "top-level",
                scope: "project",
              },
            },
          ]),
        }),
      });
      assert.deepEqual(skills, [
        {
          name: "alpha",
          path: "/tmp/project/.pi/skills/alpha/SKILL.md",
          enabled: true,
          description: "Alpha",
          scope: "project",
        },
      ]);
    }),
  );

  it.effect("treats a truly empty catalog as success", () =>
    Effect.gen(function* () {
      const skills = yield* readPiSkills({
        connection: connection({
          responses: [],
          events: [],
          getCommands: getCommandsResponse([]),
        }),
      });
      assert.deepEqual(skills, []);
    }),
  );
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
      assert.equal(snapshot.supportsConversationRollback, false);
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

for (const stderr of ["  version command failed  ", ""]) {
  it.live(`reports failed version probes with ${stderr ? "stderr" : "stdout"}`, () =>
    Effect.gen(function* () {
      const snapshot = yield* checkPiProviderStatus(
        { enabled: true, binaryPath: "pi" },
        {
          runVersion: () => Effect.succeed({ stdout: "pi 0.84.1", stderr, code: 1 }),
          connect: () => Effect.die("A failed version probe must not start an RPC session"),
        },
      );
      assert.equal(snapshot.status, "error");
      assert.equal(
        snapshot.message,
        `Pi CLI version probe failed: ${stderr.trim() || "pi 0.84.1"}`,
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  );
}

const catalogConnection = Effect.gen(function* () {
  const status = yield* Deferred.make<PiRpcEvent>();
  return {
    ...connection({ responses: [stateResponse], events: [] }),
    events: Stream.fromEffect(Deferred.await(status)),
    request: (command, id) =>
      Effect.gen(function* () {
        if (command.type === "get_state") return stateResponse;
        if (command.type === "prompt") {
          const token = command.message.split(" ").at(-1) ?? "";
          yield* Deferred.succeed(status, {
            type: "extension_ui_request",
            method: "setStatus",
            statusKey: makePiScopedModelsStatusKey(token),
            statusText: encodeJson({ version: 1, models: [{ model: model() }] }),
          });
        }
        return { type: "response", id, command: command.type, success: true };
      }),
  } satisfies PiRpcProbeConnection;
});

const temporaryPiBinary = Effect.gen(function* () {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "pi-version-cache-"));
  yield* Scope.addFinalizer(
    yield* Scope.Scope,
    Effect.sync(() => NodeFS.rmSync(directory, { recursive: true, force: true })),
  );
  const binaryPath = NodePath.join(directory, process.platform === "win32" ? "pi.cmd" : "pi");
  NodeFS.writeFileSync(binaryPath, "initial binary", { mode: 0o755 });
  return { directory, binaryPath };
});

it.effect(
  "shares successful version probes across checks and sessions, invalidating changed binaries",
  () =>
    Effect.gen(function* () {
      const { directory, binaryPath } = yield* temporaryPiBinary;
      let probes = 0;
      const probe = yield* makePiProviderProbe(
        { enabled: true, binaryPath: "pi", environment: { PATH: directory } },
        {
          runVersion: () =>
            Effect.sync(() => ({ stdout: `pi 0.84.${++probes}`, stderr: "", code: 0 })),
          connect: () => catalogConnection,
        },
      );
      assert.equal((yield* probe.checkStatus).status, "ready");
      assert.equal((yield* probe.checkStatus).version, "0.84.1");
      assert.equal(yield* probe.resolveVersionForSession, "0.84.1");
      assert.equal(probes, 1);
      NodeFS.appendFileSync(binaryPath, " upgraded");
      assert.equal((yield* probe.checkStatus).version, "0.84.2");
      assert.equal(yield* probe.resolveVersionForSession, "0.84.2");
      assert.equal(probes, 2);
      const stat = NodeFS.statSync(binaryPath);
      NodeFS.utimesSync(binaryPath, stat.atimeMs / 1_000, stat.mtimeMs / 1_000 + 10);
      assert.equal((yield* probe.checkStatus).version, "0.84.3");
      assert.equal(probes, 3);
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);

for (const timeout of ["catalog", "version"] as const) {
  for (const hadSuccess of [false, true]) {
    it.effect(
      `${timeout} timeout ${hadSuccess ? "preserves the last good catalog" : "reports error without a previous catalog"}`,
      () =>
        Effect.gen(function* () {
          const { binaryPath } = yield* temporaryPiBinary;
          let pending = false;
          const started = yield* Deferred.make<void>();
          const hang = Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never));
          const probe = yield* makePiProviderProbe(
            { enabled: true, binaryPath },
            {
              runVersion: () =>
                pending && timeout === "version"
                  ? hang
                  : Effect.succeed({ stdout: "pi 0.84.1", stderr: "", code: 0 }),
              connect: () => (pending && timeout === "catalog" ? hang : catalogConnection),
            },
          );
          const previous = hadSuccess ? yield* probe.checkStatus : undefined;
          pending = true;
          // A changed binary forces another version probe instead of using the cache.
          if (timeout === "version") NodeFS.appendFileSync(binaryPath, " changed");
          const fiber = yield* probe.checkStatus.pipe(Effect.forkChild);
          yield* Deferred.await(started);
          yield* TestClock.adjust(
            timeout === "version" ? PI_VERSION_PROBE_TIMEOUT_MS : PI_CATALOG_PROBE_TIMEOUT_MS,
          );
          const snapshot = yield* Fiber.join(fiber);
          assert.equal(snapshot.status, hadSuccess ? "warning" : "error");
          assert.deepEqual(snapshot.models, previous?.models ?? []);
          assert.equal(
            snapshot.version,
            previous?.version ?? (timeout === "catalog" ? "0.84.1" : null),
          );
          assert.include(snapshot.message ?? "", hadSuccess ? "last known models" : "timed out");
          if (hadSuccess) {
            pending = false;
            assert.equal((yield* probe.checkStatus).status, "ready");
          }
        }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
    );
  }
}

it.effect("does not reuse the last good catalog for a missing or incompatible binary", () =>
  Effect.gen(function* () {
    const { binaryPath } = yield* temporaryPiBinary;
    let mode: "ready" | "missing" | "incompatible" = "ready";
    const probe = yield* makePiProviderProbe(
      { enabled: true, binaryPath },
      {
        runVersion: () =>
          mode === "missing"
            ? Effect.fail(
                new PiProviderProbeDependencyError({ detail: "missing", missingCommand: true }),
              )
            : Effect.succeed({
                stdout: mode === "incompatible" ? "pi 0.84.0" : "pi 0.84.1",
                stderr: "",
                code: 0,
              }),
        connect: () => catalogConnection,
      },
    );
    assert.equal((yield* probe.checkStatus).status, "ready");
    NodeFS.rmSync(binaryPath);
    mode = "missing";
    const missing = yield* probe.checkStatus;
    assert.equal(missing.status, "error");
    assert.equal(missing.installed, false);
    assert.deepEqual(missing.models, []);
    NodeFS.writeFileSync(binaryPath, "incompatible new binary", { mode: 0o755 });
    mode = "incompatible";
    const incompatible = yield* probe.checkStatus;
    assert.equal(incompatible.status, "error");
    assert.deepEqual(incompatible.models, []);
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);

it.effect("probes skills without loading extensions or the scoped-models bridge", () =>
  Effect.gen(function* () {
    const args: Array<ReadonlyArray<string>> = [];
    const spawner = ChildProcessSpawner.make((command) => {
      if (command._tag === "StandardCommand") args.push(command.args);
      return Effect.die("Arguments captured before spawning");
    });
    const result = yield* probePiSkillsForCwd({
      settings: { enabled: true, binaryPath: "pi", extensionPath: "/unused.ts" },
      cwd: "/repo",
    }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner), Effect.exit);
    assert.equal(result._tag, "Failure");
    assert.deepEqual(args, [["--mode", "rpc", "--approve", "--no-session", "--no-extensions"]]);
  }).pipe(Effect.scoped),
);

for (const failure of [
  { stdout: "not a version", stderr: "", code: 0 },
  { stdout: "pi 0.84.1", stderr: "failed", code: 1 },
]) {
  it.effect(`does not cache an unsuccessful version parse or exit: ${failure.code}`, () =>
    Effect.gen(function* () {
      const { binaryPath } = yield* temporaryPiBinary;
      let probes = 0;
      const probe = yield* makePiProviderProbe(
        { enabled: true, binaryPath },
        {
          runVersion: () =>
            Effect.sync(() => {
              probes += 1;
              return probes <= 2 ? failure : { stdout: "pi 0.84.1", stderr: "", code: 0 };
            }),
          connect: () => catalogConnection,
        },
      );
      assert.equal((yield* probe.checkStatus).status, "error");
      assert.equal((yield* probe.checkStatus).status, "error");
      assert.equal((yield* probe.checkStatus).status, "ready");
      assert.equal((yield* probe.checkStatus).status, "ready");
      assert.equal(probes, 3);
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );
}

it.effect("keeps the last good catalog when the scoped-models response times out", () =>
  Effect.gen(function* () {
    const { binaryPath } = yield* temporaryPiBinary;
    const started = yield* Deferred.make<void>();
    let pending = false;
    const probe = yield* makePiProviderProbe(
      { enabled: true, binaryPath },
      {
        runVersion: () => Effect.succeed({ stdout: "pi 0.84.1", stderr: "", code: 0 }),
        connect: () =>
          pending
            ? Effect.succeed({
                ...connection({ responses: [stateResponse], events: [] }),
                events: Stream.fromEffect(
                  Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)),
                ),
              })
            : catalogConnection,
      },
    );
    const previous = yield* probe.checkStatus;
    pending = true;
    const fiber = yield* probe.checkStatus.pipe(Effect.forkChild);
    yield* Deferred.await(started);
    yield* TestClock.adjust(PI_SCOPED_MODELS_TIMEOUT_MS);
    const snapshot = yield* Fiber.join(fiber);
    assert.equal(snapshot.status, "warning");
    assert.deepEqual(snapshot.models, previous.models);
    assert.equal(snapshot.version, previous.version);
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);
