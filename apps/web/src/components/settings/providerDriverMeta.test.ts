import { PiSettings, ProviderDriverKind } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { DRIVER_OPTION_BY_VALUE, DRIVER_OPTIONS } from "./providerDriverMeta";

const piDriver = ProviderDriverKind.make("pi");

describe("providerDriverMeta", () => {
  it("offers the Pi driver in the provider instance wizard", () => {
    const definition = DRIVER_OPTION_BY_VALUE[piDriver];

    expect(DRIVER_OPTIONS).toContain(definition);
    expect(definition).toMatchObject({ value: piDriver, label: "Pi" });
    expect(definition?.settingsSchema).toBe(PiSettings);
    expect(Object.keys(definition?.settingsSchema.fields ?? {})).toEqual(["binaryPath"]);
  });
});
