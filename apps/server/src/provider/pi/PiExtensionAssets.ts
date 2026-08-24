export const PI_EXTENSION_ASSET_NAMES = [
  "PiScopedModelsExtension.ts",
  "PiT3McpExtension.ts",
] as const;

export type PiExtensionAssetName = (typeof PI_EXTENSION_ASSET_NAMES)[number];

export function resolvePiExtensionAssetPath(
  name: PiExtensionAssetName,
  moduleDirectory: string = import.meta.dirname,
): string {
  const directory = moduleDirectory.replace(/[\\/]+$/, "");
  const separator = directory.includes("\\") ? "\\" : "/";
  const basename = directory.slice(
    Math.max(directory.lastIndexOf("/"), directory.lastIndexOf("\\")) + 1,
  );
  const assetDirectory = basename === "dist" ? `${directory}${separator}pi` : directory;
  return `${assetDirectory}${separator}${name}`;
}
