import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";

import { PI_EXTENSION_ASSET_NAMES, resolvePiExtensionAssetPath } from "./PiExtensionAssets.ts";

describe("Pi extension assets", () => {
  it.effect("resolves source assets beside the path helper", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      for (const name of PI_EXTENSION_ASSET_NAMES) {
        assert.equal(yield* fileSystem.exists(resolvePiExtensionAssetPath(name)), true);
      }
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it("resolves bundled assets below dist/pi", () => {
    assert.equal(
      resolvePiExtensionAssetPath("PiScopedModelsExtension.ts", "/app/server/dist"),
      "/app/server/dist/pi/PiScopedModelsExtension.ts",
    );
  });

  it("resolves Windows bundle paths with Windows separators", () => {
    assert.equal(
      resolvePiExtensionAssetPath("PiT3McpExtension.ts", "C:\\app\\server\\dist"),
      "C:\\app\\server\\dist\\pi\\PiT3McpExtension.ts",
    );
  });
});
