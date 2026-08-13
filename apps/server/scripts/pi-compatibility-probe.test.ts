import { assert, describe, it } from "@effect/vitest";

import {
  collectPiProbeNovelties,
  formatPiProbeReport,
  parsePiProbeArguments,
  type PiProbeReport,
} from "./pi-compatibility-probe.ts";

describe("Pi compatibility probe arguments", () => {
  it("parses safe maintenance options without accepting arbitrary output paths", () => {
    const parsed = parsePiProbeArguments(
      ["--binary", "/opt/bin/pi", "--cwd", "/workspace", "--model", "openai/gpt-5", "--json"],
      { cwd: "/repo" },
    );

    assert.deepEqual(parsed, {
      _tag: "options",
      options: {
        binaryPath: "/opt/bin/pi",
        cwd: "/workspace",
        model: "openai/gpt-5",
        thinking: undefined,
        output: "json",
        timeoutMs: 120_000,
      },
    });
  });

  it("rejects malformed model selections and missing flag values", () => {
    assert.deepEqual(parsePiProbeArguments(["--model", "gpt-5"], { cwd: "/repo" }), {
      _tag: "error",
      message: "--model must use the provider/model format.",
    });
    assert.deepEqual(parsePiProbeArguments(["--binary"], { cwd: "/repo" }), {
      _tag: "error",
      message: "--binary requires a value.",
    });
  });
});

describe("Pi compatibility probe drift report", () => {
  it("highlights unknown fields and event types by name only", () => {
    const novelties = collectPiProbeNovelties([
      {
        type: "response",
        id: "state-1",
        command: "get_state",
        success: true,
        data: {
          sessionId: "session-1",
          newStateField: "do not print me",
        },
      },
      {
        type: "future_event",
        newEventField: "Bearer super-secret-token",
      },
    ]);

    assert.deepEqual(novelties, [
      { kind: "field", path: "response.get_state.data.newStateField" },
      { kind: "event", path: "future_event" },
      { kind: "field", path: "event.future_event.newEventField" },
    ]);
  });

  it("formats a report without copying command payloads or secrets", () => {
    const report: PiProbeReport = {
      status: "failed",
      version: "0.84.1",
      scenarios: [
        { name: "handshake", status: "passed" },
        { name: "text", status: "failed", detail: "Pi RPC command 'prompt' failed." },
      ],
      novelties: [
        { kind: "event", path: "future_event" },
        { kind: "field", path: "response.get_state.data.newStateField" },
      ],
    };

    const formatted = formatPiProbeReport(report);
    assert.include(formatted, "FAILED");
    assert.include(formatted, "future_event");
    assert.notInclude(formatted, "do not print me");
    assert.notInclude(formatted, "Bearer super-secret-token");
  });
});
