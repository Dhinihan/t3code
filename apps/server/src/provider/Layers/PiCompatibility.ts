/**
 * Pi compatibility policy — the single shared gate required by ticket 11.
 *
 * Both the provider probe (ticket 15) and the session-spawn handshake
 * (ticket 16) call this one pure function, so "UI green, turn explodes" cannot
 * happen by construction. It combines the two empirical layers:
 *
 *   1. a semver floor on the Pi binary (`0.84.1`, no ceiling);
 *   2. a `get_state` handshake validated on the consumed `sessionId`.
 *
 * On failure it returns a `Left` with a typed {@link PiRpcCompatibilityError}
 * whose public message is the stable sentence pinned by ticket 13 — the probe
 * and spawn call sites can distinguish "version floor violated" from
 * "get_state missing sessionId" and render a useful message.
 */
import * as Result from "effect/Result";

import { compareSemverVersions, parseSemver } from "@t3tools/shared/semver";
import { PiRpcCompatibilityError } from "./PiRpcErrors.ts";

export const MINIMUM_PI_VERSION = "0.84.1";

export interface PiCompatibilityInput {
  readonly version: string;
  /**
   * The `get_state` handshake. `sessionId` is intentionally optional here so
   * the missing-requirement path is representable; the production call site
   * feeds it a fully decoded get_state response.
   */
  readonly state: {
    readonly data: { readonly sessionId?: string | undefined };
  };
}

/**
 * Assess Pi compatibility. Returns `Success` with the confirmed session id
 * when both layers pass; `Failure` with a typed
 * {@link PiRpcCompatibilityError} otherwise.
 */
export function assessPiCompatibility(
  input: PiCompatibilityInput,
): Result.Result<string, PiRpcCompatibilityError> {
  const versionError = assessVersion(input.version);
  if (versionError) {
    return Result.fail(versionError);
  }
  const sessionId = input.state.data.sessionId;
  if (typeof sessionId !== "string" || sessionId.length === 0) {
    return Result.fail(
      new PiRpcCompatibilityError({
        operation: "get_state",
        piVersion: input.version,
        missingRequirement: "data.sessionId",
      }),
    );
  }
  return Result.succeed(sessionId);
}

function assessVersion(version: string): PiRpcCompatibilityError | null {
  if (!parseSemver(version)) {
    return new PiRpcCompatibilityError({
      operation: "version",
      piVersion: version,
    });
  }
  if (compareSemverVersions(version, MINIMUM_PI_VERSION) < 0) {
    return new PiRpcCompatibilityError({
      operation: "version",
      piVersion: version,
    });
  }
  return null;
}
