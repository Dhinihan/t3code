// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { ProviderDriverKind, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";

import { connectPiRpc } from "./PiRpcConnection.ts";
import { makePiAdapter } from "./PiAdapter.ts";
import { PiImageAttachmentReadError } from "./PiImageAttachments.ts";
import { makePiSessionManager, piSessionIdForThread } from "./PiSessionManager.ts";

const PEER_PATH = NodePath.join(import.meta.dirname, "../testFixtures/piRpcMockPeer.mjs");
const PI = ProviderDriverKind.make("pi");
const INSTANCE = ProviderInstanceId.make("pi");
let peerTestCounter = 0;

const run = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.provide(NodeServices.layer), Effect.scoped);

it.live("sends the Pi image content shape across the headless JSONL boundary", () =>
  run(
    Effect.gen(function* () {
      const threadId = ThreadId.make("pi-adapter-headless-images");
      const sessionDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "pi-adapter-session-"));
      const attachmentsDir = NodeFS.mkdtempSync(
        NodePath.join(NodeOS.tmpdir(), "pi-adapter-attachments-"),
      );
      peerTestCounter += 1;
      const testSuffix = `${process.pid}-${peerTestCounter}`;
      const scriptPath = NodePath.join(
        NodeOS.tmpdir(),
        `pi-adapter-peer-script-${testSuffix}.json`,
      );
      const logPath = NodePath.join(NodeOS.tmpdir(), `pi-adapter-peer-log-${testSuffix}.jsonl`);
      const attachmentId = "pi-adapter-headless-images-00000000-0000-4000-8000-000000000001";
      const attachmentPath = NodePath.join(attachmentsDir, `${attachmentId}.png`);
      const sessionId = piSessionIdForThread(threadId);
      NodeFS.writeFileSync(attachmentPath, Buffer.from([1, 2, 3]), { mode: 0o600 });
      NodeFS.writeFileSync(
        scriptPath,
        // @effect-diagnostics-next-line preferSchemaOverJson:off
        JSON.stringify({
          sessionId,
          sessionFile: NodePath.join(sessionDir, "peer-session.jsonl"),
          stateModel: { input: ["text", "image"] },
        }),
        "utf8",
      );

      const fileSystem = yield* FileSystem.FileSystem;
      const manager = yield* makePiSessionManager({
        binaryPath: process.execPath,
        cwd: process.cwd(),
        sessionDir,
        piVersion: "0.84.1",
        args: [PEER_PATH],
        environment: {
          ...process.env,
          PI_RPC_PEER_SCRIPT: scriptPath,
          PI_RPC_PEER_LOG: logPath,
        },
        connect: connectPiRpc,
      });
      const adapter = yield* makePiAdapter({
        sessionManager: manager,
        instanceId: INSTANCE,
        attachmentReader: {
          attachmentsDir,
          readFile: (path) =>
            fileSystem
              .readFile(path)
              .pipe(Effect.mapError((cause) => new PiImageAttachmentReadError({ path, cause }))),
        },
      });

      yield* adapter.startSession({
        provider: PI,
        providerInstanceId: INSTANCE,
        threadId,
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({
        threadId,
        input: "describe this image",
        attachments: [
          {
            type: "image",
            id: attachmentId,
            name: "diagram.png",
            mimeType: "image/png",
            sizeBytes: 3,
          },
        ],
      });

      const records = NodeFS.readFileSync(logPath, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as { kind?: string; message?: Record<string, unknown> });
      const prompt = records.find(
        (record) => record.kind === "command" && record.message?.type === "prompt",
      )?.message;
      assert.isDefined(prompt);
      if (prompt === undefined) return;
      assert.isString(prompt.id);
      assert.deepEqual(
        {
          type: prompt.type,
          message: prompt.message,
          images: prompt.images,
          streamingBehavior: prompt.streamingBehavior,
        },
        {
          type: "prompt",
          message: "describe this image",
          images: [{ type: "image", data: "AQID", mimeType: "image/png" }],
          streamingBehavior: "steer",
        },
      );

      yield* adapter.stopSession(threadId);
      NodeFS.rmSync(scriptPath, { force: true });
      NodeFS.rmSync(logPath, { force: true });
      NodeFS.rmSync(sessionDir, { recursive: true, force: true });
      NodeFS.rmSync(attachmentsDir, { recursive: true, force: true });
    }),
  ),
);
