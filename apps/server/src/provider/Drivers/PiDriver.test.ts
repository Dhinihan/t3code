import { it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderInstanceConfigMap,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { expect } from "vite-plus/test";

import * as BackgroundPolicy from "../../background/BackgroundPolicy.ts";
import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { makeProviderInstanceRegistry } from "../Layers/ProviderInstanceRegistryLive.ts";
import { BUILT_IN_DRIVERS } from "../builtInDrivers.ts";
import { PiDriver } from "./PiDriver.ts";

const TEST_EPOCH = DateTime.makeUnsafe("1970-01-01T00:00:00.000Z");

const BackgroundPolicyAlwaysRunLayer = Layer.mock(BackgroundPolicy.BackgroundPolicy)({
  reportClientActivity: () => Effect.void,
  removeRpcClient: () => Effect.void,
  reportHostPowerState: () => Effect.void,
  snapshot: Effect.succeed({
    hostPower: {
      source: "unknown",
      idle: "unknown",
      idleSeconds: null,
      locked: "unknown",
      suspended: false,
      onBattery: "unknown",
      lowPowerMode: "unknown",
      thermalState: "unknown",
      stale: true,
      updatedAt: TEST_EPOCH,
    },
    leases: [],
    activeForegroundLeaseCount: 0,
    activeScopeKeys: [],
    shouldRunOpportunisticWork: true,
    updatedAt: TEST_EPOCH,
  }),
  streamChanges: Stream.empty,
  hasDemand: () => Effect.succeed(true),
  shouldRunScopeWork: () => Effect.succeed(true),
  shouldRunOpportunisticWork: Effect.succeed(true),
});

const PiDriverTestLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "pi-driver-test-",
}).pipe(
  Layer.provideMerge(NodeServices.layer),
  Layer.provideMerge(BackgroundPolicyAlwaysRunLayer),
  Layer.provideMerge(ServerSettingsService.layerTest()),
);

it.live("materializes an explicit Pi provider instance without a legacy provider key", () =>
  Effect.gen(function* () {
    const piId = ProviderInstanceId.make("pi_main");
    const configMap: ProviderInstanceConfigMap = {
      [piId]: {
        driver: PiDriver.driverKind,
        enabled: false,
        config: {},
      },
    };

    const { registry } = yield* makeProviderInstanceRegistry({
      drivers: [PiDriver],
      configMap,
    });

    const instance = yield* registry.getInstance(piId);
    expect(instance).toBeDefined();
    expect(instance?.driverKind).toBe(ProviderDriverKind.make("pi"));
    expect(instance?.displayName).toBeUndefined();
    expect(instance?.enabled).toBe(false);

    const snapshot = yield* instance!.snapshot.getSnapshot;
    expect(snapshot.instanceId).toBe(piId);
    expect(snapshot.driver).toBe(ProviderDriverKind.make("pi"));
    expect(snapshot.displayName).toBe("Pi");
    expect(snapshot.status).toBe("disabled");
    expect(snapshot.models).toEqual([]);

    const driverKinds = BUILT_IN_DRIVERS.map((driver) => driver.driverKind);
    expect(driverKinds).toEqual([
      ProviderDriverKind.make("codex"),
      ProviderDriverKind.make("claudeAgent"),
      ProviderDriverKind.make("cursor"),
      ProviderDriverKind.make("grok"),
      ProviderDriverKind.make("opencode"),
      ProviderDriverKind.make("pi"),
    ]);
  }).pipe(Effect.provide(PiDriverTestLayer)),
);
