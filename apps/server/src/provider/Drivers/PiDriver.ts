// @effect-diagnostics nodeBuiltinImport:off
/**
 * PiDriver — assembles the Pi protocol pieces into one provider instance.
 *
 * Pi is intentionally configured through the driver-agnostic
 * `providerInstances` envelope. Its binary uses the host's `~/.pi/agent`
 * configuration through the normal Pi CLI process, while T3-owned session
 * files live below the isolated server state directory.
 */
import * as NodePath from "node:path";

import { PiSettings, ProviderDriverKind, type ServerProvider } from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import { ChildProcessSpawner } from "effect/unstable/process";

import * as BackgroundPolicy from "../../background/BackgroundPolicy.ts";
import * as McpSessionRegistry from "../../mcp/McpSessionRegistry.ts";
import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { makePiTextGeneration } from "../../textGeneration/PiTextGeneration.ts";
import { ProviderDriverError } from "../Errors.ts";
import {
  buildInitialPiProviderSnapshot,
  makePiProviderProbe,
  PI_PROVIDER_BINARY,
  PI_SCOPED_MODELS_EXTENSION_PATH,
  PI_SKILLS_PROBE_TIMEOUT_MS,
  probePiSkillsForCwd,
  type PiProviderSettings,
} from "../Layers/PiProvider.ts";
import { makePiAdapter } from "../Layers/PiAdapter.ts";
import { makePiSessionManager, type PiSessionManager } from "../Layers/PiSessionManager.ts";
import {
  PiImageAttachmentReadError,
  type PiImageAttachmentReader,
} from "../Layers/PiImageAttachments.ts";
import { makeManagedServerProvider } from "../makeManagedServerProvider.ts";
import { makeManualOnlyProviderMaintenanceCapabilities } from "../providerMaintenance.ts";
import type { ServerProviderDraft } from "../providerSnapshot.ts";
import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
  type ProviderInstance,
} from "../ProviderDriver.ts";
import { mergeProviderInstanceEnvironment } from "../ProviderInstanceEnvironment.ts";
import {
  haveProviderSnapshotSettingsChanged,
  makeProviderSnapshotSettingsSource,
  type ProviderSnapshotSettings,
} from "../providerUpdateSettings.ts";

const DRIVER_KIND = ProviderDriverKind.make("pi");

/** Driver-owned config; environment variables stay in the instance envelope. */
export const PiDriverConfig = PiSettings;
export type PiDriverConfig = PiSettings;

const decodePiDriverConfig = Schema.decodeSync(PiDriverConfig);
const PI_SESSION_DIRECTORY_NAME = "pi";

const MAINTENANCE_CAPABILITIES = makeManualOnlyProviderMaintenanceCapabilities({
  provider: DRIVER_KIND,
  packageName: null,
});

export type PiDriverEnv =
  | BackgroundPolicy.BackgroundPolicy
  | ChildProcessSpawner.ChildProcessSpawner
  | FileSystem.FileSystem
  | ServerConfig
  | ServerSettingsService;

const withInstanceIdentity =
  (input: {
    readonly instanceId: ProviderInstance["instanceId"];
    readonly displayName: string | undefined;
    readonly accentColor: string | undefined;
    readonly continuationGroupKey: string;
  }) =>
  (snapshot: ServerProviderDraft): ServerProvider => ({
    ...snapshot,
    instanceId: input.instanceId,
    driver: DRIVER_KIND,
    ...(input.displayName ? { displayName: input.displayName } : {}),
    ...(input.accentColor ? { accentColor: input.accentColor } : {}),
    continuation: { groupKey: input.continuationGroupKey },
  });

function piSessionDirectory(stateDir: string, instanceId: ProviderInstance["instanceId"]): string {
  return NodePath.join(stateDir, PI_SESSION_DIRECTORY_NAME, instanceId);
}

function toProviderDriverError(input: {
  readonly instanceId: ProviderInstance["instanceId"];
  readonly operation: string;
  readonly cause: unknown;
}): ProviderDriverError {
  const detail = input.cause instanceof Error ? input.cause.message : String(input.cause);
  return new ProviderDriverError({
    driver: DRIVER_KIND,
    instanceId: input.instanceId,
    detail: `Failed to ${input.operation} Pi provider: ${detail}`,
    cause: input.cause,
  });
}

export const PiDriver: ProviderDriver<PiDriverConfig, PiDriverEnv> = {
  driverKind: DRIVER_KIND,
  metadata: {
    displayName: "Pi",
    supportsMultipleInstances: true,
  },
  configSchema: PiDriverConfig,
  defaultConfig: () => decodePiDriverConfig({}),
  create: ({ instanceId, displayName, accentColor, environment, enabled, config }) =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const serverConfig = yield* ServerConfig;
      const serverSettings = yield* ServerSettingsService;
      const processEnv = mergeProviderInstanceEnvironment(environment);
      const binaryPath = config.binaryPath.trim() || PI_PROVIDER_BINARY;
      const providerSettings: PiProviderSettings = {
        enabled,
        binaryPath,
        cwd: serverConfig.cwd,
        environment: processEnv,
        extensionPath: PI_SCOPED_MODELS_EXTENSION_PATH,
      };
      const continuationIdentity = defaultProviderContinuationIdentity({
        driverKind: DRIVER_KIND,
        instanceId,
      });
      const stampIdentity = withInstanceIdentity({
        instanceId,
        displayName,
        accentColor,
        continuationGroupKey: continuationIdentity.continuationKey,
      });
      const sessionDir = piSessionDirectory(serverConfig.stateDir, instanceId);
      const probe = yield* makePiProviderProbe(providerSettings);

      yield* fileSystem.makeDirectory(sessionDir, { recursive: true }).pipe(
        Effect.mapError((cause) =>
          toProviderDriverError({
            instanceId,
            operation: "prepare Pi session directory",
            cause,
          }),
        ),
      );

      const sessionManager: PiSessionManager = yield* makePiSessionManager({
        binaryPath,
        cwd: serverConfig.cwd,
        sessionDir,
        resolveVersion: probe.resolveVersionForSession,
        environment: processEnv,
        revokeMcpProviderSession: McpSessionRegistry.revokeActiveMcpProviderSession,
      }).pipe(
        Effect.mapError((cause) =>
          toProviderDriverError({
            instanceId,
            operation: "create Pi session manager",
            cause,
          }),
        ),
      );

      const adapter = yield* makePiAdapter({
        sessionManager,
        instanceId,
        attachmentReader: {
          attachmentsDir: serverConfig.attachmentsDir,
          readFile: (path) =>
            fileSystem.readFile(path).pipe(
              Effect.mapError(
                (cause) =>
                  new PiImageAttachmentReadError({
                    path,
                    cause,
                  }),
              ),
            ),
        } satisfies PiImageAttachmentReader,
        skillReader: (path) => fileSystem.readFileString(path),
      });
      const textGeneration = yield* makePiTextGeneration();
      const snapshotSettings = makeProviderSnapshotSettingsSource(providerSettings, serverSettings);
      const checkProvider = probe.checkStatus.pipe(
        Effect.map(stampIdentity),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, childProcessSpawner),
        Effect.provideService(HostProcessPlatform, process.platform),
      );
      const snapshot = yield* makeManagedServerProvider<
        ProviderSnapshotSettings<PiProviderSettings>
      >({
        resolveMaintenance: () => Effect.succeed(MAINTENANCE_CAPABILITIES),
        getSettings: snapshotSettings.getSettings,
        streamSettings: snapshotSettings.streamSettings,
        haveSettingsChanged: haveProviderSnapshotSettingsChanged,
        initialSnapshot: (settings) =>
          buildInitialPiProviderSnapshot(settings.provider).pipe(Effect.map(stampIdentity)),
        checkProvider,
      }).pipe(
        Effect.mapError((cause) =>
          toProviderDriverError({
            instanceId,
            operation: "build Pi snapshot",
            cause,
          }),
        ),
      );
      const snapshotForCwd = (cwd: string) =>
        !enabled
          ? snapshot.getSnapshot
          : Effect.all([
              snapshot.getSnapshot,
              probePiSkillsForCwd({ settings: providerSettings, cwd }).pipe(
                Effect.scoped,
                Effect.timeout(PI_SKILLS_PROBE_TIMEOUT_MS),
                Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, childProcessSpawner),
              ),
            ]).pipe(
              Effect.map(([machineSnapshot, skills]) => ({ ...machineSnapshot, skills })),
              Effect.mapError((cause) =>
                toProviderDriverError({
                  instanceId,
                  operation: `discover Pi skills for '${cwd}'`,
                  cause,
                }),
              ),
            );

      return {
        instanceId,
        driverKind: DRIVER_KIND,
        continuationIdentity,
        displayName,
        accentColor,
        enabled,
        snapshot,
        snapshotForCwd,
        adapter,
        textGeneration,
      } satisfies ProviderInstance;
    }),
};
