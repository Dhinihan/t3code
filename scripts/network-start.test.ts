import { NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";

it.effect("keeps the persistent network server on the established Tailscale port", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const rootPackageJson = yield* fileSystem.readFileString(
      new URL("../package.json", import.meta.url).pathname,
    );

    expect(rootPackageJson).toMatch(
      /"start:network": ".*--tailscale-serve --tailscale-serve-port 8443 .*"/,
    );
    expect(rootPackageJson).toMatch(/"start:network": ".*--base-dir ~\/\.t3\/pi-travel .*"/);
  }).pipe(Effect.provide(NodeServices.layer)),
);
