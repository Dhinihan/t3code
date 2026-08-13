/**
 * Pi RPC wire contract — schemas for the minimum command/response surface
 * ticket 14 needs, and the tolerant decoder that implements ticket 11's
 * "novidade se ignora, ausência derruba".
 *
 * The Pi speaks its own JSONL protocol on stdio (no JSON-RPC 2.0 envelope, no
 * handshake). A line is one of:
 *
 *   - a response   `{ id, type: "response", command, success, data|error }`
 *   - an event     `{ type: "agent_start" | ... | "extension_ui_request" }`
 *   - an extension UI request (also an event, handled by the host's UI policy)
 *
 * Decoding is deliberately TOLERANT: response fields that are not consumed by
 * the handshake are ignored, while event records retain their unknown fields
 * for adapter mapping and diagnostics. A future Pi release that adds fields or
 * event types is therefore non-fatal. It is STRICT only about the fields this
 * ticket consumes — missing `sessionId` in `get_state`, a malformed envelope,
 * or a non-correlating `id` are real incompatibilities and decode to `None`.
 */
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

/** Base64 image content accepted by Pi's `prompt` RPC command. */
export const PiRpcImageContent = Schema.Struct({
  type: Schema.Literal("image"),
  data: Schema.String,
  mimeType: Schema.String,
});
export type PiRpcImageContent = typeof PiRpcImageContent.Type;

// ---------------------------------------------------------------------------
// Command surface — the minimum shared by probe and session spawn.
// ---------------------------------------------------------------------------

export const PiRpcCommand = Schema.Union([
  Schema.Struct({ type: Schema.Literal("get_state") }),
  Schema.Struct({ type: Schema.Literal("get_available_models") }),
  Schema.Struct({ type: Schema.Literal("get_available_thinking_levels") }),
  Schema.Struct({
    type: Schema.Literal("set_model"),
    provider: Schema.String,
    modelId: Schema.String,
  }),
  Schema.Struct({
    type: Schema.Literal("set_thinking_level"),
    level: Schema.String,
  }),
  Schema.Struct({
    type: Schema.Literal("prompt"),
    message: Schema.String,
    images: Schema.optional(Schema.Array(PiRpcImageContent)),
  }),
  Schema.Struct({ type: Schema.Literal("abort") }),
]);
export type PiRpcCommand = typeof PiRpcCommand.Type;

/** One-way host message used to cancel a blocking extension UI request. */
export const PiRpcExtensionUiResponse = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("extension_ui_response"),
    id: Schema.String,
    value: Schema.Unknown,
  }),
  Schema.Struct({
    type: Schema.Literal("extension_ui_response"),
    id: Schema.String,
    confirmed: Schema.Boolean,
  }),
  Schema.Struct({
    type: Schema.Literal("extension_ui_response"),
    id: Schema.String,
    cancelled: Schema.Literal(true),
  }),
]);
export type PiRpcExtensionUiResponse = typeof PiRpcExtensionUiResponse.Type;

// ---------------------------------------------------------------------------
// Response envelope
// ---------------------------------------------------------------------------

/**
 * `data.sessionId` is the ONLY consumed handshake requirement (ticket 11).
 * `model`/`thinkingLevel`/`sessionFile` are decoded as tolerant `Unknown` so a
 * future Pi changing their shape (or making them null) never invalidates the
 * whole handshake — "novidade se ignora". Later tickets consume them through
 * their own decoders.
 */
const PiRpcGetStateData = Schema.Struct({
  sessionId: Schema.String,
  model: Schema.optional(Schema.Unknown),
  thinkingLevel: Schema.optional(Schema.Unknown),
  sessionFile: Schema.optional(Schema.Unknown),
  messageCount: Schema.optional(Schema.Number),
});

const PiRpcResponse = Schema.Struct({
  type: Schema.Literal("response"),
  id: Schema.String,
  command: Schema.String,
  success: Schema.Boolean,
  data: Schema.optional(Schema.Unknown),
  error: Schema.optional(Schema.String),
});
export type PiRpcResponse = typeof PiRpcResponse.Type;

/** A response whose `data` is strictly the consumed `get_state` handshake. */
export interface PiRpcGetStateResponse {
  readonly type: "response";
  readonly id: string;
  readonly command: "get_state";
  readonly success: true;
  readonly data: {
    readonly sessionId: string;
    /** Tolerated, not consumed by the handshake; decode on demand later. */
    readonly model?: Readonly<Record<string, unknown>>;
    readonly thinkingLevel?: unknown;
    readonly sessionFile?: unknown;
    readonly messageCount?: number | undefined;
  };
}

const PiRpcAvailableThinkingLevelsData = Schema.Struct({
  levels: Schema.Array(Schema.String),
});

/** Decode the thinking-level catalog consumed by the manual compatibility probe. */
export function decodeAvailableThinkingLevelsResponse(
  input: unknown,
): Option.Option<ReadonlyArray<string>> {
  const response = decodeResponse(input);
  if (response._tag === "None") return Option.none();
  if (
    response.value.command !== "get_available_thinking_levels" ||
    response.value.success !== true
  ) {
    return Option.none();
  }
  const data = decodeAvailableThinkingLevelsData(response.value.data);
  return data._tag === "Some" ? Option.some(data.value.levels) : Option.none();
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

const PiRpcEvent = Schema.StructWithRest(
  Schema.Struct({
    type: Schema.String,
    // Extension UI requests are events, not responses. Keep the small set of
    // fields consumed by the scoped-model bridge while retaining all other
    // fields for adapter mapping and diagnostics.
    id: Schema.optional(Schema.String),
    method: Schema.optional(Schema.String),
    statusKey: Schema.optional(Schema.String),
    statusText: Schema.optional(Schema.String),
    // Preserve the provider payloads consumed by the adapter. These remain
    // Unknown on purpose: event variants evolve independently of the envelope,
    // and the adapter performs the small discriminated reads it needs.
    assistantMessageEvent: Schema.optional(Schema.Unknown),
    message: Schema.optional(Schema.Unknown),
    toolCallId: Schema.optional(Schema.Unknown),
    toolName: Schema.optional(Schema.Unknown),
    args: Schema.optional(Schema.Unknown),
    partialResult: Schema.optional(Schema.Unknown),
    result: Schema.optional(Schema.Unknown),
    isError: Schema.optional(Schema.Unknown),
    willRetry: Schema.optional(Schema.Unknown),
  }),
  [Schema.Record(Schema.String, Schema.Unknown)],
);

export type PiRpcEvent = typeof PiRpcEvent.Type;

// ---------------------------------------------------------------------------
// Tolerant wire decoder
// ---------------------------------------------------------------------------

const decodeResponse = Schema.decodeUnknownOption(PiRpcResponse);
const decodeEvent = Schema.decodeUnknownOption(PiRpcEvent);
const decodeGetStateData = Schema.decodeUnknownOption(PiRpcGetStateData);
const decodeAvailableThinkingLevelsData = Schema.decodeUnknownOption(
  PiRpcAvailableThinkingLevelsData,
);

/** Categorizes a decoded record into the shapes the runtime routes on. */
export function classifyRecord(record: PiRpcResponse | PiRpcEvent): "response" | "event" {
  return record.type === "response" ? "response" : "event";
}

/**
 * Decode one raw JSON record from the Pi. Tolerant: unknown fields and event
 * types pass through; a malformed envelope or a response that cannot even be
 * shaped as `{ type, command, success }` decodes to `None`.
 */
export function decodeWireRecord(input: unknown): PiRpcResponse | PiRpcEvent {
  const option = decodeWireRecordOption(input);
  if (option._tag === "None") {
    throw new Error("Pi RPC record does not match the response or event envelope");
  }
  return option.value;
}

/** `Option` variant of {@link decodeWireRecord} for tolerating unknown shapes. */
export function decodeWireRecordOption(input: unknown): Option.Option<PiRpcResponse | PiRpcEvent> {
  const response = decodeResponse(input);
  if (response._tag === "Some") {
    return Option.some(response.value);
  }
  // A record that CLAIMS to be a response (`type: "response"`) but is missing
  // required fields is an incompatibility, not an event — do not fall through
  // to the tolerant event decoder and silently swallow it.
  if (isObject(input) && input.type === "response") {
    return Option.none();
  }
  const event = decodeEvent(input);
  if (event._tag === "Some") {
    return Option.some(event.value);
  }
  return Option.none();
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Decode a `get_state` response strictly on the consumed handshake fields.
 * Tolerant of unknown fields, strict about `sessionId` — a response whose
 * `data` is not a valid `get_state` handshake decodes to `None`.
 */
export function decodeGetStateResponse(input: unknown): Option.Option<PiRpcGetStateResponse> {
  const record = decodeResponse(input);
  if (record._tag === "None") return Option.none();
  const value = record.value;
  if (value.command !== "get_state" || value.success !== true) {
    return Option.none();
  }
  const data = decodeGetStateData(value.data);
  if (data._tag === "None") {
    return Option.none();
  }
  const decodedData = data.value;
  return Option.some({
    type: "response",
    id: value.id,
    command: "get_state",
    success: true,
    data: {
      sessionId: decodedData.sessionId,
      ...(isObject(decodedData.model) ? { model: decodedData.model } : {}),
      ...(decodedData.thinkingLevel === undefined
        ? {}
        : { thinkingLevel: decodedData.thinkingLevel }),
      ...(decodedData.sessionFile === undefined ? {} : { sessionFile: decodedData.sessionFile }),
      ...(decodedData.messageCount === undefined ? {} : { messageCount: decodedData.messageCount }),
    },
  });
}
