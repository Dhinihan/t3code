// @effect-diagnostics nodeBuiltinImport:off
import type { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";

import * as McpProviderSession from "../../mcp/McpProviderSession.ts";
import * as McpSessionRegistry from "../../mcp/McpSessionRegistry.ts";
import { resolvePiExtensionAssetPath } from "../pi/PiExtensionAssets.ts";
import { makePiT3McpExtensionWrapperSource, type PiT3McpConfig } from "../pi/PiT3McpExtension.ts";

export const PI_T3_MCP_EXTENSION_PATH = resolvePiExtensionAssetPath("PiT3McpExtension.ts");

export interface PiMcpSessionLease {
  readonly threadId: ThreadId;
  readonly providerSessionId: string;
  readonly extensionPath: string;
  readonly close: Effect.Effect<void>;
}

export interface PiMcpSessionLeaseOptions {
  readonly revokeProviderSession?: (providerSessionId: string) => Effect.Effect<void>;
}

export const makePiMcpSessionLease = Effect.fn("makePiMcpSessionLease")(function* (
  config: McpProviderSession.McpProviderSessionConfig,
  options: PiMcpSessionLeaseOptions = {},
): Effect.fn.Return<PiMcpSessionLease, never, FileSystem.FileSystem | Scope.Scope> {
  const fileSystem = yield* FileSystem.FileSystem;
  const closed = yield* Ref.make(false);
  const extensionPath = yield* fileSystem
    .makeTempFileScoped({
      prefix: "t3-pi-mcp-",
      suffix: ".ts",
    })
    .pipe(Effect.orDie);
  const wrapperConfig: PiT3McpConfig = {
    endpoint: config.endpoint,
    authorizationHeader: config.authorizationHeader,
  };
  const revokeProviderSession =
    options.revokeProviderSession ?? McpSessionRegistry.revokeActiveMcpProviderSession;
  const close = Effect.gen(function* () {
    if (yield* Ref.getAndSet(closed, true)) {
      return;
    }
    McpProviderSession.clearMcpProviderSessionIfMatches(config.threadId, config.providerSessionId);
    yield* fileSystem.remove(extensionPath, { force: true }).pipe(Effect.ignore);
    yield* revokeProviderSession(config.providerSessionId).pipe(Effect.ignore);
  });
  yield* Scope.addFinalizer(yield* Scope.Scope, close);
  yield* fileSystem
    .writeFileString(
      extensionPath,
      makePiT3McpExtensionWrapperSource({
        extensionPath: PI_T3_MCP_EXTENSION_PATH,
        config: wrapperConfig,
      }),
      { mode: 0o600 },
    )
    .pipe(Effect.orDie);

  return {
    threadId: config.threadId,
    providerSessionId: config.providerSessionId,
    extensionPath,
    close,
  };
});
