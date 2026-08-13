import { TextGenerationError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import type { TextGenerationShape } from "./TextGeneration.ts";

export const PI_TEXT_GENERATION_UNSUPPORTED_DETAIL =
  "Pi does not provide auxiliary text generation. Choose another provider in Settings → Text generation.";

type TextGenerationOperation =
  | "generateCommitMessage"
  | "generatePrContent"
  | "generateBranchName"
  | "generateThreadTitle";

const unsupported = (operation: TextGenerationOperation) =>
  Effect.fail(
    new TextGenerationError({
      operation,
      detail: PI_TEXT_GENERATION_UNSUPPORTED_DETAIL,
    }),
  );

/**
 * Pi deliberately does not own T3's auxiliary text-generation slot.
 *
 * The driver still has to provide the SPI member, but every operation fails
 * before a Pi process is created. This keeps title/branch/PR helpers
 * deterministic and prevents an auxiliary request from sharing a thread's
 * durable Pi session.
 */
export const makePiTextGeneration = (): Effect.Effect<TextGenerationShape> =>
  Effect.succeed({
    generateCommitMessage: () => unsupported("generateCommitMessage"),
    generatePrContent: () => unsupported("generatePrContent"),
    generateBranchName: () => unsupported("generateBranchName"),
    generateThreadTitle: () => unsupported("generateThreadTitle"),
  } satisfies TextGenerationShape);
