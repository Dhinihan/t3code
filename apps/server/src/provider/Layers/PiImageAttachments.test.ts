// @effect-diagnostics nodeBuiltinImport:off
import * as Effect from "effect/Effect";

import { assert, it } from "@effect/vitest";
import {
  PiImageAttachmentReadError,
  loadPiImageContents,
  type PiImageAttachmentReader,
  type PiImageContent,
} from "./PiImageAttachments.ts";

const attachmentsDir = "/tmp/t3-pi-attachments";

const attachment = (overrides: Record<string, unknown> = {}) => ({
  type: "image" as const,
  id: "thread-1-00000000-0000-4000-8000-000000000001",
  name: "diagram.png",
  mimeType: "image/png",
  sizeBytes: 3,
  ...overrides,
});

const reader = (files: Record<string, Uint8Array>): PiImageAttachmentReader => ({
  attachmentsDir,
  readFile: (path) => {
    const bytes = files[path];
    return bytes === undefined
      ? Effect.fail(new PiImageAttachmentReadError({ path }))
      : Effect.succeed(bytes);
  },
});

const imagePath = (id: string, extension = ".png") => `${attachmentsDir}/${id}${extension}`;

it.effect("converts one persisted image to the Pi image content shape", () =>
  Effect.gen(function* () {
    const item = attachment();
    const result = yield* loadPiImageContents({
      attachments: [item],
      reader: reader({ [imagePath(item.id)]: Uint8Array.from([1, 2, 3]) }),
    });

    assert.deepEqual(result, [
      {
        type: "image",
        data: "AQID",
        mimeType: "image/png",
      } satisfies PiImageContent,
    ]);
  }),
);

it.effect("preserves attachment order and MIME for multiple images", () =>
  Effect.gen(function* () {
    const first = attachment({
      id: "thread-1-00000000-0000-4000-8000-000000000001",
      name: "first.webp",
      mimeType: "image/webp",
      sizeBytes: 2,
    });
    const second = attachment({
      id: "thread-1-00000000-0000-4000-8000-000000000002",
      name: "second.jpeg",
      mimeType: "image/jpeg",
      sizeBytes: 1,
    });

    const result = yield* loadPiImageContents({
      attachments: [first, second],
      reader: reader({
        [imagePath(first.id, ".webp")]: Uint8Array.from([1, 2]),
        [imagePath(second.id, ".jpg")]: Uint8Array.from([3]),
      }),
    });

    assert.deepEqual(result, [
      { type: "image", data: "AQI=", mimeType: "image/webp" },
      { type: "image", data: "Aw==", mimeType: "image/jpeg" },
    ]);
  }),
);

it.effect("rejects non-image and invalid MIME attachments", () =>
  Effect.gen(function* () {
    const nonImage = yield* loadPiImageContents({
      attachments: [attachment({ type: "file", name: "notes.txt" })] as never,
      reader: reader({}),
    }).pipe(Effect.exit);
    assert.equal(nonImage._tag, "Failure");
    if (nonImage._tag === "Failure") {
      assert.include(String(nonImage.cause), "not an image");
    }

    const invalidMime = yield* loadPiImageContents({
      attachments: [attachment({ mimeType: "text/plain" })],
      reader: reader({}),
    }).pipe(Effect.exit);
    assert.equal(invalidMime._tag, "Failure");
    if (invalidMime._tag === "Failure") {
      assert.include(String(invalidMime.cause), "MIME");
    }
  }),
);

it.effect("rejects missing, empty, and oversized image content", () =>
  Effect.gen(function* () {
    const missing = yield* loadPiImageContents({
      attachments: [attachment()],
      reader: reader({}),
    }).pipe(Effect.exit);
    assert.equal(missing._tag, "Failure");

    const emptyItem = attachment({
      id: "thread-1-00000000-0000-4000-8000-000000000002",
      sizeBytes: 0,
    });
    const empty = yield* loadPiImageContents({
      attachments: [emptyItem],
      reader: reader({ [imagePath(emptyItem.id)]: new Uint8Array() }),
    }).pipe(Effect.exit);
    assert.equal(empty._tag, "Failure");

    const tooLargeItem = attachment({
      id: "thread-1-00000000-0000-4000-8000-000000000003",
      sizeBytes: 10 * 1024 * 1024 + 1,
    });
    const tooLarge = yield* loadPiImageContents({
      attachments: [tooLargeItem],
      reader: reader({ [imagePath(tooLargeItem.id)]: Uint8Array.from([1]) }),
    }).pipe(Effect.exit);
    assert.equal(tooLarge._tag, "Failure");
  }),
);

it.effect("enforces the provider attachment count limit", () =>
  Effect.gen(function* () {
    const attachments = Array.from({ length: 9 }, (_, index) =>
      attachment({
        id: `thread-1-00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
      }),
    );
    const result = yield* loadPiImageContents({
      attachments,
      reader: reader({}),
    }).pipe(Effect.exit);

    assert.equal(result._tag, "Failure");
    if (result._tag === "Failure") {
      assert.include(String(result.cause), "8");
    }
  }),
);
