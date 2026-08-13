// @effect-diagnostics nodeBuiltinImport:off
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  ChatAttachment,
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
  type ChatAttachment as ChatAttachmentValue,
} from "@t3tools/contracts";

import { resolveAttachmentPath } from "../../attachmentStore.ts";
import type { PiRpcImageContent, PiRpcResponse } from "./PiRpcContract.ts";

export type PiImageContent = PiRpcImageContent;

const isChatAttachment = Schema.is(ChatAttachment);

export interface PiImageAttachmentReader {
  readonly attachmentsDir: string;
  readonly readFile: (path: string) => Effect.Effect<Uint8Array, PiImageAttachmentReadError>;
}

export class PiImageAttachmentError extends Schema.TaggedErrorClass<PiImageAttachmentError>()(
  "PiImageAttachmentError",
  {
    detail: Schema.String,
    attachmentName: Schema.optionalKey(Schema.String),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    const prefix =
      this.attachmentName === undefined
        ? "Pi image attachments are invalid"
        : `Pi image attachment '${this.attachmentName}' is invalid`;
    return `${prefix}: ${this.detail}`;
  }
}

export class PiImageAttachmentReadError extends Schema.TaggedErrorClass<PiImageAttachmentReadError>()(
  "PiImageAttachmentReadError",
  {
    path: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Failed to read Pi image attachment at '${this.path}'.`;
  }
}

export type PiImageInputSupport = "supported" | "unsupported" | "unknown";

/**
 * Reads only the capability shape Pi exposes in `get_state.model.input`.
 * Missing or changing fields stay unknown so protocol drift does not disable
 * image prompts unless Pi explicitly says the current model cannot accept
 * images.
 */
export function piImageInputSupport(response: PiRpcResponse): PiImageInputSupport {
  if (response.command !== "get_state" || response.success !== true || !isRecord(response.data)) {
    return "unknown";
  }
  const model = response.data.model;
  if (!isRecord(model) || !Array.isArray(model.input)) {
    return "unknown";
  }
  return model.input.some((value) => value === "image") ? "supported" : "unsupported";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function attachmentName(value: unknown): string | undefined {
  return isRecord(value) && typeof value.name === "string" && value.name.trim().length > 0
    ? value.name
    : undefined;
}

function invalidAttachment(input: {
  readonly attachment: unknown;
  readonly detail: string;
  readonly cause?: unknown;
}): PiImageAttachmentError {
  const name = attachmentName(input.attachment);
  return new PiImageAttachmentError({
    detail: input.detail,
    ...(name === undefined ? {} : { attachmentName: name }),
    ...(input.cause === undefined ? {} : { cause: input.cause }),
  });
}

function decodeAttachment(value: unknown): ChatAttachmentValue | undefined {
  return isChatAttachment(value) ? value : undefined;
}

export const loadPiImageContents = Effect.fn("loadPiImageContents")(function* (input: {
  readonly attachments: ReadonlyArray<unknown>;
  readonly reader: PiImageAttachmentReader;
}): Effect.fn.Return<ReadonlyArray<PiImageContent>, PiImageAttachmentError> {
  if (input.attachments.length > PROVIDER_SEND_TURN_MAX_ATTACHMENTS) {
    return yield* invalidAttachment({
      attachment: undefined,
      detail: `a turn may contain at most ${PROVIDER_SEND_TURN_MAX_ATTACHMENTS} attachments.`,
    });
  }

  return yield* Effect.forEach(
    input.attachments,
    (rawAttachment) =>
      Effect.gen(function* () {
        if (isRecord(rawAttachment) && rawAttachment.type !== "image") {
          return yield* invalidAttachment({
            attachment: rawAttachment,
            detail: "the attachment type is not an image.",
          });
        }

        const attachment = decodeAttachment(rawAttachment);
        if (attachment === undefined) {
          return yield* invalidAttachment({
            attachment: rawAttachment,
            detail: "the MIME type must be a valid image MIME type.",
          });
        }

        const path = resolveAttachmentPath({
          attachmentsDir: input.reader.attachmentsDir,
          attachment,
        });
        if (path === null) {
          return yield* invalidAttachment({
            attachment,
            detail: "the attachment path is invalid.",
          });
        }

        const bytes = yield* input.reader.readFile(path).pipe(
          Effect.mapError((cause) =>
            invalidAttachment({
              attachment,
              detail: "the attachment content is missing or unreadable.",
              cause,
            }),
          ),
        );
        if (bytes.byteLength === 0) {
          return yield* invalidAttachment({
            attachment,
            detail: "the attachment content is empty.",
          });
        }
        if (bytes.byteLength > PROVIDER_SEND_TURN_MAX_IMAGE_BYTES) {
          return yield* invalidAttachment({
            attachment,
            detail: `the attachment is larger than ${PROVIDER_SEND_TURN_MAX_IMAGE_BYTES} bytes.`,
          });
        }

        return {
          type: "image",
          data: Buffer.from(bytes).toString("base64"),
          mimeType: attachment.mimeType,
        } satisfies PiImageContent;
      }),
    { concurrency: 1 },
  );
});
