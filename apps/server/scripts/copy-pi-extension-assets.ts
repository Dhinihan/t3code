// @effect-diagnostics nodeBuiltinImport:off

import * as NodeFS from "node:fs/promises";
import * as NodePath from "node:path";

import { PI_EXTENSION_ASSET_NAMES } from "../src/provider/pi/PiExtensionAssets.ts";

const serverDir = NodePath.resolve(import.meta.dirname, "..");
const sourceDir = NodePath.join(serverDir, "src/provider/pi");
const targetDir = NodePath.join(serverDir, "dist/pi");

await NodeFS.mkdir(targetDir, { recursive: true });
await Promise.all(
  PI_EXTENSION_ASSET_NAMES.map((name) =>
    NodeFS.copyFile(NodePath.join(sourceDir, name), NodePath.join(targetDir, name)),
  ),
);

process.stdout.write("[build] Bundled Pi extensions into dist/pi\n");
