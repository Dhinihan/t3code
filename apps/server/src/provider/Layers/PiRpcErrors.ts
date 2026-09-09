/**
 * Pi RPC error taxonomy — typed `Schema.TaggedError` errors in the same
 * style as `packages/effect-codex-app-server/src/errors.ts`. The public
 * `message` of `PiRpcCompatibilityError` is the stable sentence pinned by the
 * suite (ticket 13); the structured fields are asserted separately.
 */
import * as Schema from "effect/Schema";

import type { PiRpcResponse } from "./PiRpcContract.ts";

export class PiRpcCompatibilityError extends Schema.TaggedError<PiRpcCompatibilityError>()(
  "PiRpcCompatibilityError",
  {
    operation: Schema.String,
    piVersion: Schema.optionalKey(Schema.String),
    missingRequirement: Schema.optionalKey(Schema.String),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    const version = this.piVersion === undefined ? "" : ` (Pi ${this.piVersion})`;
    if (this.missingRequirement !== undefined) {
      return `Pi RPC ${this.operation} is incompatible: required field ${this.missingRequirement} is missing${version}.`;
    }
    return `Pi RPC ${this.operation} is incompatible${version}.`;
  }
}

export class PiRpcSpawnError extends Schema.TaggedError<PiRpcSpawnError>()("PiRpcSpawnError", {
  command: Schema.optionalKey(Schema.String),
  cause: Schema.Defect(),
}) {
  override get message(): string {
    return this.command === undefined
      ? "Failed to spawn Pi RPC process"
      : `Failed to spawn Pi RPC process for command: ${this.command}`;
  }
}

export class PiRpcProcessExitedError extends Schema.TaggedError<PiRpcProcessExitedError>()(
  "PiRpcProcessExitedError",
  {
    code: Schema.optionalKey(Schema.Number),
    pid: Schema.optionalKey(Schema.Int),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return this.code === undefined
      ? "Pi RPC process exited"
      : `Pi RPC process exited with code ${this.code}`;
  }
}

export class PiRpcTransportError extends Schema.TaggedError<PiRpcTransportError>()(
  "PiRpcTransportError",
  {
    operation: Schema.optionalKey(Schema.String),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return "Pi RPC transport failed.";
  }
}

export class PiRpcTerminatedError extends Schema.TaggedError<PiRpcTerminatedError>()(
  "PiRpcTerminatedError",
  {},
) {
  override get message(): string {
    return "Pi RPC input stream ended.";
  }
}

export class PiRpcRequestTimeoutError extends Schema.TaggedError<PiRpcRequestTimeoutError>()(
  "PiRpcRequestTimeoutError",
  {
    command: Schema.String,
    timeoutMs: Schema.Number,
  },
) {
  override get message(): string {
    return `Pi RPC command '${this.command}' timed out after ${this.timeoutMs}ms`;
  }
}

export class PiRpcRequestError extends Schema.TaggedError<PiRpcRequestError>()(
  "PiRpcRequestError",
  {
    command: Schema.String,
    detail: Schema.optionalKey(Schema.String),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return this.detail === undefined
      ? `Pi RPC command '${this.command}' failed`
      : `Pi RPC command '${this.command}' failed: ${this.detail}`;
  }

  static fromResponse(response: PiRpcResponse): PiRpcRequestError {
    return new PiRpcRequestError({
      command: response.command,
      ...(response.error === undefined ? {} : { detail: response.error }),
      cause: response,
    });
  }
}

export type PiRpcError =
  | PiRpcCompatibilityError
  | PiRpcSpawnError
  | PiRpcProcessExitedError
  | PiRpcTransportError
  | PiRpcTerminatedError
  | PiRpcRequestError
  | PiRpcRequestTimeoutError;
