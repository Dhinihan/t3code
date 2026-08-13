/**
 * Pi compatibility policy — the single shared gate (ticket 11) that the later
 * probe and session-spawn call sites both use. Covers only the policy
 * boundaries; the semver comparator matrix lives in `@t3tools/shared/semver`.
 * Pins the stable public message required by ticket 13.
 */
import { assert, describe, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import * as PiCompatibility from "./PiCompatibility.ts";
import { PiRpcCompatibilityError } from "./PiRpcErrors.ts";
import type { PiRpcGetStateResponse } from "./PiRpcContract.ts";

const state = (sessionId: string): PiRpcGetStateResponse => ({
  type: "response",
  id: "id-1",
  command: "get_state",
  success: true,
  data: { sessionId },
});

const assess = (input: PiCompatibility.PiCompatibilityInput) =>
  PiCompatibility.assessPiCompatibility(input);

const asFailure = (result: ReturnType<typeof assess>): PiRpcCompatibilityError => {
  if (result._tag === "Failure") {
    return result.failure;
  }
  throw new Error("Expected compatibility assessment to fail");
};

describe("PiCompatibility", () => {
  it("accepts exactly the minimum version", () => {
    const result = assess({ version: "0.84.1", state: state("sess-1") });
    assert.equal(result._tag, "Success");
    if (result._tag === "Success") {
      assert.equal(result.success, "sess-1");
    }
  });

  it("accepts a newer version", () => {
    const result = assess({ version: "0.95.0", state: state("sess-1") });
    assert.equal(result._tag, "Success");
  });

  it("rejects a version below the floor with a typed error", () => {
    const error = asFailure(assess({ version: "0.84.0", state: state("sess-1") }));
    assert.isTrue(Schema.is(PiRpcCompatibilityError)(error));
    assert.equal(error.operation, "version");
    assert.equal(error.piVersion, "0.84.0");
  });

  it("produces a legible error for a malformed version", () => {
    const error = asFailure(assess({ version: "not-a-version", state: state("sess-1") }));
    assert.equal(error.operation, "version");
  });

  it("fails when get_state is missing sessionId with the stable message", () => {
    const error = asFailure(assess({ version: "0.84.1", state: { data: {} } }));
    assert.equal(error.operation, "get_state");
    assert.equal(error.missingRequirement, "data.sessionId");
    assert.equal(error.piVersion, "0.84.1");
    assert.equal(
      error.message,
      "Pi RPC get_state is incompatible: required field data.sessionId is missing (Pi 0.84.1).",
    );
  });
});
