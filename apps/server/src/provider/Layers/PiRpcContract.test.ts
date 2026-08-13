/**
 * Pure Pi RPC protocol contract — level 1 of the hermetic Pi adapter suite
 * (see ticket 13). No process, no timer: decodes real captured Pi records
 * through the production schemas and pins the "novidade se ignora, ausência
 * derruba" tolerance of ticket 11.
 *
 * Fixture provenance: Pi 0.84.1 captures from
 * `.scratch/pi-integration/assets/07-spike-rpc/transcripts/` and
 * `01-rpc-*.transcript.md`.
 */
import { assert, describe, it } from "vite-plus/test";

import piRpcWire from "../testFixtures/piRpcWire.json" with { type: "json" };
import * as PiRpc from "./PiRpcContract.ts";

const realGetState = {
  id: "ticket07-01-handshake-extensions-1",
  type: "response",
  command: "get_state",
  success: true,
  data: {
    model: {
      id: "gpt-5.6-luna",
      name: "GPT-5.6 Luna",
      api: "openai-codex-responses",
      provider: "openai-codex",
      baseUrl: "https://chatgpt.com/backend-api",
      reasoning: true,
      input: ["text", "image"],
      cost: {
        input: 0.2,
        output: 1.2,
        cacheRead: 0.02,
        cacheWrite: 0.25,
      },
      contextWindow: 272000,
      maxTokens: 128000,
      thinkingLevelMap: { xhigh: "xhigh", max: "max", minimal: "low" },
      compat: { supportsOpenAIGrammarTools: true, supportsToolSearch: true },
    },
    thinkingLevel: "xhigh",
    isStreaming: false,
    isCompacting: false,
    steeringMode: "one-at-a-time",
    followUpMode: "one-at-a-time",
    sessionFile: "/tmp/pi-rpc-ticket-07-doEioI/sessions/019ff830-f4fe-79a9-8a3e-467d7b7f10fb.jsonl",
    sessionId: "019ff830-f4fe-79a9-8a3e-467d7b7f10fb",
    autoCompactionEnabled: true,
    messageCount: 0,
    pendingMessageCount: 0,
  },
};

const asResponse = (record: PiRpc.PiRpcResponse | PiRpc.PiRpcEvent): PiRpc.PiRpcResponse => {
  assert.equal(PiRpc.classifyRecord(record), "response");
  return record as PiRpc.PiRpcResponse;
};

describe("PiRpcContract", () => {
  it("decodes a real get_state response", () => {
    const state = PiRpc.decodeGetStateResponse(realGetState);
    assert.equal(state._tag, "Some");
    if (state._tag === "None") return;
    assert.equal(state.value.command, "get_state");
    assert.equal(state.value.data.sessionId, "019ff830-f4fe-79a9-8a3e-467d7b7f10fb");
    const model = state.value.data.model as { provider?: string } | undefined;
    assert.equal(model?.provider, "openai-codex");
  });

  it("tolerates a future Pi adding fields it does not consume", () => {
    const future = {
      ...realGetState,
      data: {
        ...realGetState.data,
        brandNewField: { nested: true },
        anotherFutureFlag: "sparkle",
      },
    };
    const state = PiRpc.decodeGetStateResponse(future);
    assert.equal(state._tag, "Some");
    if (state._tag === "None") return;
    assert.equal(state.value.data.sessionId, "019ff830-f4fe-79a9-8a3e-467d7b7f10fb");
  });

  it("rejects a get_state response missing the consumed sessionId", () => {
    const { sessionId: _dropped, ...dataWithoutSessionId } = realGetState.data;
    const missing = { ...realGetState, data: dataWithoutSessionId };
    const result = PiRpc.decodeGetStateResponse(missing);
    assert.equal(result._tag, "None");
  });

  it("tolerates a future Pi changing the shape of optional get_state fields", () => {
    // Novidade se ignora: `model`/`thinkingLevel`/`sessionFile` are not
    // consumed by the handshake, so a future Pi changing their shape must not
    // invalidate the whole get_state.
    const variants: Array<Record<string, unknown>> = [
      { ...realGetState.data, model: "gpt-5.6-luna" },
      { ...realGetState.data, model: { provider: "openai-codex" } },
      { ...realGetState.data, thinkingLevel: 3 },
      { ...realGetState.data, model: null },
      { ...realGetState.data, sessionFile: 12345 },
    ];
    for (const data of variants) {
      const result = PiRpc.decodeGetStateResponse({ ...realGetState, data });
      assert.equal(result._tag, "Some", JSON.stringify(data));
    }
  });

  it("classifies known and unknown event records", () => {
    const settled = { type: "agent_settled" };
    const unknown = { type: "brand_new_event", payload: { any: "thing" } };
    assert.equal(PiRpc.classifyRecord(settled), "event");
    assert.equal(PiRpc.classifyRecord(unknown), "event");
    assert.equal(PiRpc.classifyRecord(realGetState), "response");
  });

  it("decodes a prompt acceptance response", () => {
    const record = PiRpc.decodeWireRecord({
      id: "ticket07-04-abort-1",
      type: "response",
      command: "prompt",
      success: true,
    });
    const response = asResponse(record);
    assert.equal(response.command, "prompt");
    assert.equal(response.success, true);
  });

  it("decodes a command error response", () => {
    const record = PiRpc.decodeWireRecord({
      id: "bad-model",
      type: "response",
      command: "set_model",
      success: false,
      error: "Model not found: no-such-provider/no-such-model",
    });
    const response = asResponse(record);
    assert.equal(response.success, false);
    assert.equal(response.error, "Model not found: no-such-provider/no-such-model");
  });

  it("classifies an extension_ui_request as an event", () => {
    const record = PiRpc.decodeWireRecord({
      type: "extension_ui_request",
      id: "6a970a0f-eb85-4a87-a109-e69438555182",
      method: "setStatus",
      statusKey: "subagents",
    });
    assert.equal(PiRpc.classifyRecord(record), "event");
  });

  it("rejects a malformed response envelope instead of treating it as an event", () => {
    // A record that claims to be a response but is missing required fields must
    // NOT fall through to the event decoder and get silently dropped.
    const missingSuccess = PiRpc.decodeWireRecordOption({
      id: "x",
      type: "response",
      command: "get_state",
    });
    assert.equal(missingSuccess._tag, "None");

    const missingCommand = PiRpc.decodeWireRecordOption({
      id: "x",
      type: "response",
      success: true,
    });
    assert.equal(missingCommand._tag, "None");

    const numericId = PiRpc.decodeWireRecordOption({
      id: 123,
      type: "response",
      command: "get_state",
      success: true,
    });
    assert.equal(numericId._tag, "None");
  });

  it("decodes the curated real-wire fixture through the production schemas", () => {
    const wire = piRpcWire as {
      responses: {
        get_state: Record<string, unknown>;
        get_available_models: { models: Array<Record<string, unknown>> };
        get_available_thinking_levels: { levels: ReadonlyArray<string> };
      };
      events: {
        textTurn: ReadonlyArray<Record<string, unknown>>;
        abortTurn: ReadonlyArray<Record<string, unknown>>;
      };
      provenance: { piVersion: string };
    };

    const state = PiRpc.decodeGetStateResponse({
      id: "fixture-1",
      type: "response",
      command: "get_state",
      success: true,
      data: wire.responses.get_state,
    });
    assert.equal(state._tag, "Some");
    if (state._tag === "None") return;
    assert.equal(state.value.data.sessionId, "019ff830-f4fe-79a9-8a3e-467d7b7f10fb");
    assert.equal(state.value.data.model?.provider, "openai-codex");

    for (const event of [...wire.events.textTurn, ...wire.events.abortTurn]) {
      const record = PiRpc.decodeWireRecord(event);
      assert.equal(PiRpc.classifyRecord(record), "event");
    }

    assert.equal(wire.provenance.piVersion, "0.84.1");
  });
});
