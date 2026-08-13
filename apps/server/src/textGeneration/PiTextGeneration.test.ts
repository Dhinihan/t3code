import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { ProviderInstanceId } from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import { expect } from "vite-plus/test";

import { makePiTextGeneration, PI_TEXT_GENERATION_UNSUPPORTED_DETAIL } from "./PiTextGeneration.ts";

const modelSelection = createModelSelection(ProviderInstanceId.make("pi"), "openai/gpt-5");

it.effect("fails every auxiliary operation explicitly without starting Pi", () =>
  Effect.gen(function* () {
    const textGeneration = yield* makePiTextGeneration();

    const outcomes = yield* Effect.all(
      [
        textGeneration
          .generateCommitMessage({
            cwd: process.cwd(),
            branch: "feature/pi",
            stagedSummary: "M apps/server/src/provider/Drivers/PiDriver.ts",
            stagedPatch: "diff --git a/PiDriver.ts b/PiDriver.ts",
            modelSelection,
          })
          .pipe(Effect.result),
        textGeneration
          .generatePrContent({
            cwd: process.cwd(),
            baseBranch: "main",
            headBranch: "feature/pi",
            commitSummary: "feat: add Pi provider",
            diffSummary: "M apps/server/src/provider/Drivers/PiDriver.ts",
            diffPatch: "diff --git a/PiDriver.ts b/PiDriver.ts",
            modelSelection,
          })
          .pipe(Effect.result),
        textGeneration
          .generateBranchName({
            cwd: process.cwd(),
            message: "add Pi provider",
            modelSelection,
          })
          .pipe(Effect.result),
        textGeneration
          .generateThreadTitle({
            cwd: process.cwd(),
            message: "add Pi provider",
            modelSelection,
          })
          .pipe(Effect.result),
      ],
      { concurrency: "unbounded" },
    );

    for (const outcome of outcomes) {
      expect(outcome._tag).toBe("Failure");
      if (outcome._tag === "Failure") {
        expect(outcome.failure._tag).toBe("TextGenerationError");
        expect(outcome.failure.detail).toBe(PI_TEXT_GENERATION_UNSUPPORTED_DETAIL);
      }
    }
  }),
);
