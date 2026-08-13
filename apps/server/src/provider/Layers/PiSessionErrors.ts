import * as Schema from "effect/Schema";

export class PiSessionLifecycleError extends Schema.TaggedErrorClass<PiSessionLifecycleError>()(
  "PiSessionLifecycleError",
  {
    operation: Schema.String,
    threadId: Schema.String,
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return this.operation === "resume"
      ? `Pi session for thread '${this.threadId}' cannot be resumed: ${this.detail}`
      : `Pi session lifecycle ${this.operation} failed for thread '${this.threadId}': ${this.detail}`;
  }
}
