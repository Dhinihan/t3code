// Hermetic Pi RPC peer for runtime tests — plain Node, stdlib only.
//
// Speaks enough of the `pi --mode rpc` JSONL protocol for the Pi runtime to
// connect, and replays a scripted wire fixture (read from a JSON file path in
// PI_RPC_PEER_SCRIPT) keyed by the command the host sends. Records every
// received command to an append-only sidecar (PI_RPC_PEER_LOG) the test reads
// back, so correlation and shutdown behavior are asserted from the host side.
//
// It deliberately does NOT require a Pi install: this is the "peer Pi
// scriptado" of the hermetic suite (ticket 13).
import * as NodeFS from "node:fs";
import * as NodeReadline from "node:readline";

const scriptPath = process.env.PI_RPC_PEER_SCRIPT;
if (!scriptPath) {
  throw new Error("PI_RPC_PEER_SCRIPT is required");
}
const script = JSON.parse(NodeFS.readFileSync(scriptPath, "utf8"));

const write = (value) => {
  process.stdout.write(`${JSON.stringify(value)}\n`);
};

const appendLog = (line) => {
  if (process.env.PI_RPC_PEER_LOG) {
    NodeFS.appendFileSync(process.env.PI_RPC_PEER_LOG, `${JSON.stringify(line)}\n`);
  }
};

let sessionIdCounter = 0;
let waitingFor = null;

const respond = (id, command, data) => {
  appendLog({ kind: "respond", id, command });
  write({ id, type: "response", command, success: true, ...(data === undefined ? {} : { data }) });
};

const respondError = (id, command, error) => {
  appendLog({ kind: "respond-error", id, command, error });
  write({ id, type: "response", command, success: false, error });
};

const responseFor = (id, command) => {
  const canned = script.responses?.[command];
  if (canned !== undefined) {
    respond(id, command, canned);
    return;
  }
  switch (command) {
    case "get_state": {
      sessionIdCounter += 1;
      respond(id, command, {
        sessionId: script.sessionId ?? `sess-${sessionIdCounter}`,
        sessionFile: script.sessionFile ?? `/tmp/pi-peer/session.jsonl`,
        model: script.stateModel,
        thinkingLevel: script.stateThinkingLevel ?? "xhigh",
        messageCount: script.messageCount ?? 0,
      });
      return;
    }
    case "get_available_models": {
      respond(id, command, { models: script.models ?? [] });
      return;
    }
    case "get_available_thinking_levels": {
      respond(id, command, { levels: script.thinkingLevels ?? ["off", "xhigh"] });
      return;
    }
    case "set_model":
    case "set_thinking_level": {
      respond(id, command);
      return;
    }
    case "prompt": {
      // The Pi accepts the prompt before the turn streams. Emit the events the
      // host consumes, then the acceptance response, interleaved.
      write({ type: "agent_start" });
      write({ type: "turn_start" });
      if (script.promptEvents) {
        for (const event of script.promptEvents) write(event);
      }
      respond(id, command);
      write({ type: "turn_end" });
      write({ type: "agent_end", messages: [] });
      write({ type: "agent_settled" });
      return;
    }
    case "abort": {
      write({ type: "agent_end", messages: [], willRetry: false });
      write({ type: "agent_settled" });
      respond(id, command);
      return;
    }
    default: {
      respondError(id, command, `Unknown command: ${command}`);
    }
  }
};

if (script.stderrBytes) {
  process.stderr.write("x".repeat(Number(script.stderrBytes)));
}

const rl = NodeReadline.createInterface({ input: process.stdin });

rl.on("line", (line) => {
  if (line.trim().length === 0) return;
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  const id = message.id;
  const command = message.type;
  appendLog({ kind: "command", id, command, message });

  if (script.failCommand && script.failCommand === command) {
    respondError(id, command, "Model not found: no-such-provider/no-such-model");
    return;
  }

  if (script.deathOnCommand && script.deathOnCommand === command) {
    // Simulate an unexpected child death mid-protocol (SIGKILL-style, no
    // response, no clean EOF).
    process.kill(process.pid, "SIGKILL");
    return;
  }

  if (script.hangOnCommand && script.hangOnCommand === command) {
    // Never respond: proves the host's bounded deadline.
    waitingFor = command;
    return;
  }

  if (script.eofOnCommand && script.eofOnCommand === command) {
    // Clean EOF without a response: the Pi exits 0 when stdin ends.
    rl.close();
    return;
  }

  responseFor(id, command);
});

rl.on("close", () => {
  process.exit(0);
});
