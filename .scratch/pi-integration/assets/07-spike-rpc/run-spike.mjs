#!/usr/bin/env node

/*
 * Disposable empirical probe for ticket 07.
 *
 * This intentionally speaks raw JSONL to `pi --mode rpc`; it is not an
 * adapter and must not become one. The child gets an isolated HOME, agent
 * directory, and session directory. Only the captured evidence is kept in
 * this directory after the run.
 */

import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
  chmodSync,
  copyFileSync,
  rmSync,
} from "node:fs";
import { mkdtempSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const assetDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(assetDir, "../../../..");
const transcriptDir = join(assetDir, "transcripts");
const sessionAssetDir = join(assetDir, "sessions");
const fixturePath = join(assetDir, "fixtures", "read-target.txt");
const piPath = process.env.PI_BIN || "pi";
const originalAgentDir = join(homedir(), ".pi", "agent");

const extensionPaths = [
  join(originalAgentDir, "extensions", "claude-memory.ts"),
  join(originalAgentDir, "extensions", "chrome"),
  join(originalAgentDir, "extensions", "pi-hud"),
  join(originalAgentDir, "extensions", "pi-voice-sidecar"),
  join(originalAgentDir, "extensions", "quota"),
  join(originalAgentDir, "extensions", "subagents"),
  join(originalAgentDir, "extensions", "telegram-notifier"),
  join(originalAgentDir, "extensions", "valyu.ts"),
];

const extensionArgs = extensionPaths.flatMap((path) => ["--extension", path]);

mkdirSync(transcriptDir, { recursive: true });
mkdirSync(sessionAssetDir, { recursive: true });

function now() {
  return new Date().toISOString();
}

function writeJson(name, value) {
  writeFileSync(join(transcriptDir, name), `${JSON.stringify(value, null, 2)}\n`);
}

function writeJsonl(name, values) {
  writeFileSync(
    join(transcriptDir, name),
    values.map((value) => JSON.stringify(value)).join("\n") + (values.length ? "\n" : ""),
  );
}

function makeIsolatedRuntime() {
  const root = mkdtempSync("/tmp/pi-rpc-ticket-07-");
  const home = join(root, "home");
  const agentDir = join(root, "agent");
  mkdirSync(home, { recursive: true });
  mkdirSync(agentDir, { recursive: true });

  const settings = JSON.parse(readFileSync(join(originalAgentDir, "settings.json"), "utf8"));
  settings.packages = [];
  settings.enabledModels = ["openai-codex/gpt-5.6-luna"];
  writeFileSync(join(agentDir, "settings.json"), `${JSON.stringify(settings, null, 2)}\n`);
  copyFileSync(join(originalAgentDir, "auth.json"), join(agentDir, "auth.json"));
  chmodSync(join(agentDir, "auth.json"), 0o600);
  copyFileSync(join(originalAgentDir, "models.json"), join(agentDir, "models.json"));

  return { root, home, agentDir, sessionRoot: join(root, "sessions") };
}

function descendantsOf(rootPid) {
  const children = new Map();
  for (const entry of readdirSync("/proc", { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) continue;
    try {
      const stat = readFileSync(join("/proc", entry.name, "stat"), "utf8");
      const close = stat.lastIndexOf(")");
      const fields = stat
        .slice(close + 2)
        .trim()
        .split(/\s+/);
      const pid = Number(entry.name);
      const ppid = Number(fields[1]);
      if (Number.isInteger(pid) && Number.isInteger(ppid)) {
        const list = children.get(ppid) ?? [];
        list.push(pid);
        children.set(ppid, list);
      }
    } catch {
      // A process can disappear between readdir and stat.
    }
  }

  const result = [];
  const queue = [...(children.get(rootPid) ?? [])];
  while (queue.length) {
    const pid = queue.shift();
    result.push(pid);
    queue.push(...(children.get(pid) ?? []));
  }
  return result;
}

function processSnapshot(pids) {
  return pids.map((pid) => {
    try {
      return { pid, stat: readFileSync(join("/proc", String(pid), "stat"), "utf8") };
    } catch {
      return { pid, gone: true };
    }
  });
}

function killExactPids(pids) {
  for (const pid of [...pids].reverse()) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // Already gone.
    }
  }
}

class RawRpcProcess {
  constructor(name, runtime, sessionFile) {
    this.name = name;
    this.runtime = runtime;
    this.sessionFile = sessionFile;
    this.records = [];
    this.commands = [];
    this.listeners = new Set();
    this.stdout = "";
    this.stderr = "";
    this.partial = "";
    this.closed = null;
    this.nextId = 0;

    const args = [
      "--mode",
      "rpc",
      "--provider",
      "openai-codex",
      "--model",
      "gpt-5.6-luna",
      "--thinking",
      "xhigh",
      "--no-skills",
      "--no-prompt-templates",
      "--no-themes",
      "--no-context-files",
      "--approve",
      ...extensionArgs,
    ];
    if (sessionFile) args.push("--session", sessionFile);

    this.child = spawn(piPath, args, {
      cwd: repoRoot,
      env: {
        ...process.env,
        HOME: runtime.home,
        PI_CODING_AGENT_DIR: runtime.agentDir,
        PI_CODING_AGENT_SESSION_DIR: runtime.sessionRoot,
        PI_OFFLINE: "1",
        PI_TELEMETRY: "0",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });

    this.child.stdout.on("data", (chunk) => {
      const text = chunk.toString();
      this.stdout += text;
      let pending = this.partial + text;
      const lines = pending.split("\n");
      this.partial = lines.pop() ?? "";
      for (const rawLine of lines) {
        const raw = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
        if (!raw) continue;
        let json;
        try {
          json = JSON.parse(raw);
        } catch {
          json = { type: "unparsed_stdout", raw };
        }
        const record = { at: now(), raw, json };
        this.records.push(record);
        for (const listener of this.listeners) listener(record);
      }
    });
    this.child.stderr.on("data", (chunk) => {
      this.stderr += chunk.toString();
    });
    this.child.once("close", (code, signal) => {
      this.closed = { at: now(), code, signal };
      for (const listener of this.listeners) listener({ closed: this.closed });
    });
  }

  waitFor(predicate, timeoutMs = 30_000) {
    for (const record of this.records) {
      if (predicate(record)) return Promise.resolve(record);
    }
    if (this.closed)
      return Promise.reject(new Error(`${this.name} closed before expected RPC record`));
    return new Promise((resolvePromise, reject) => {
      const timer = setTimeout(() => {
        this.listeners.delete(listener);
        reject(new Error(`${this.name} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      const listener = (record) => {
        if (record.closed) {
          clearTimeout(timer);
          this.listeners.delete(listener);
          reject(new Error(`${this.name} closed before expected RPC record`));
        } else if (predicate(record)) {
          clearTimeout(timer);
          this.listeners.delete(listener);
          resolvePromise(record);
        }
      };
      this.listeners.add(listener);
    });
  }

  send(command, waitForResponse = true) {
    const id = `ticket07-${this.name}-${++this.nextId}`;
    const fullCommand = { ...command, id };
    this.commands.push({ at: now(), command: fullCommand });
    this.child.stdin.write(`${JSON.stringify(fullCommand)}\n`);
    if (!waitForResponse) return Promise.resolve(undefined);
    return this.waitFor(
      (record) => record.json?.type === "response" && record.json.id === id,
      45_000,
    ).then((record) => record.json);
  }

  waitForSettled(timeoutMs = 90_000) {
    return this.waitFor((record) => record.json?.type === "agent_settled", timeoutMs);
  }

  async stop(signal = "SIGTERM") {
    if (!this.closed) {
      this.child.kill(signal);
      await this.waitFor(() => Boolean(this.closed), 10_000).catch(() => undefined);
    }
    if (this.partial) writeFileSync(join(transcriptDir, `${this.name}.partial`), this.partial);
  }

  save() {
    writeFileSync(join(transcriptDir, `${this.name}.raw.jsonl`), this.stdout);
    writeFileSync(join(transcriptDir, `${this.name}.stderr`), this.stderr);
    writeJsonl(`${this.name}.commands.jsonl`, this.commands);
    writeJson(`${this.name}.records.json`, this.records);
    writeJson(`${this.name}.exit.json`, this.closed);
  }
}

async function runHandshake(runtime) {
  const rpc = new RawRpcProcess("01-handshake-extensions", runtime);
  const state = await rpc.send({ type: "get_state" });
  const commands = await rpc.send({ type: "get_commands" });
  await rpc.stop();
  rpc.save();
  writeJson("01-handshake-result.json", { state, commands, stderr: rpc.stderr });
  return { state: state.data, commands: commands.data, sessionFile: state.data.sessionFile };
}

async function runTurn(runtime, name, message) {
  const rpc = new RawRpcProcess(name, runtime);
  const promptResponsePromise = rpc.send({ type: "prompt", message });
  const settledPromise = rpc.waitForSettled();
  const promptResponse = await promptResponsePromise;
  await settledPromise;
  const state = await rpc.send({ type: "get_state" });
  await rpc.stop();
  rpc.save();
  writeJson(`${name}.result.json`, { promptResponse, state, stderr: rpc.stderr });
  return { state: state.data, records: rpc.records };
}

async function runAbort(runtime) {
  const rpc = new RawRpcProcess("04-abort", runtime);
  const promptResponsePromise = rpc.send({
    type: "prompt",
    message:
      "Use the built-in bash tool to run `sleep 8`. Do not answer until that command finishes.",
  });
  const started = await rpc.waitFor(
    (record) => record.json?.type === "tool_execution_start",
    20_000,
  );
  const updated = await rpc.waitFor(
    (record) => record.json?.type === "tool_execution_update",
    20_000,
  );
  const promptResponse = await promptResponsePromise;
  const abortResponse = await rpc.send({ type: "abort" });
  await rpc.waitForSettled();
  await rpc.stop();
  rpc.save();
  writeJson("04-abort.result.json", {
    started,
    updated,
    promptResponse,
    abortResponse,
    stderr: rpc.stderr,
  });
}

async function runDeath(runtime) {
  const rpc = new RawRpcProcess("05-death", runtime);
  const stateResponse = await rpc.send({ type: "get_state" });
  const sessionFile = stateResponse.data.sessionFile;
  const promptResponsePromise = rpc.send({
    type: "prompt",
    message:
      "Use the built-in bash tool to run `sleep 8`. Do not answer until that command finishes.",
  });
  await rpc.waitFor((record) => record.json?.type === "tool_execution_start", 20_000);
  await rpc.waitFor((record) => record.json?.type === "tool_execution_update", 20_000);
  const descendantPids = descendantsOf(rpc.child.pid);
  const beforeKill = processSnapshot([rpc.child.pid, ...descendantPids]);
  const killedAt = now();
  rpc.child.kill("SIGKILL");
  await rpc.waitFor(() => Boolean(rpc.closed), 10_000).catch(() => undefined);
  const afterKill = processSnapshot([rpc.child.pid, ...descendantPids]);
  const promptResponse = await promptResponsePromise.catch((error) => ({ error: String(error) }));
  const sessionFiles = readdirSync(runtime.sessionRoot, { recursive: true })
    .filter((path) => String(path).endsWith(".jsonl"))
    .map((path) => join(runtime.sessionRoot, String(path)));
  const sessionInspection = sessionFiles.map((path) => {
    const content = readFileSync(path, "utf8");
    const lines = content.split("\n").filter(Boolean);
    const invalidLines = lines.filter((line) => {
      try {
        JSON.parse(line);
        return false;
      } catch {
        return true;
      }
    });
    return {
      path,
      bytes: Buffer.byteLength(content),
      lineCount: lines.length,
      invalidLineCount: invalidLines.length,
      lastLine: lines.at(-1) ?? null,
    };
  });
  killExactPids(descendantPids);
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
  const afterCleanup = processSnapshot(descendantPids);
  rpc.save();
  writeJson("05-death.result.json", {
    stateResponse,
    promptResponse,
    sessionFile,
    killedAt,
    childPid: rpc.child.pid,
    descendantPids,
    beforeKill,
    afterKill,
    afterCleanup,
    sessionInspection,
    stderr: rpc.stderr,
  });
  return { sessionFile, sessionFiles };
}

async function runRecovery(runtime, sessionFile) {
  const rpc = new RawRpcProcess("06-recovery", runtime, sessionFile);
  const state = await rpc.send({ type: "get_state" });
  const promptResponsePromise = rpc.send({
    type: "prompt",
    message:
      "The previous process was interrupted. Reply exactly RECOVERED if this session can continue.",
  });
  const promptResponse = await promptResponsePromise;
  await rpc.waitForSettled();
  const lastText = await rpc.send({ type: "get_last_assistant_text" });
  await rpc.stop();
  rpc.save();
  writeJson("06-recovery.result.json", { state, promptResponse, lastText, stderr: rpc.stderr });
}

async function copySessionAssets(runtime, label) {
  const destination = join(sessionAssetDir, label);
  mkdirSync(destination, { recursive: true });
  const copied = [];
  if (!existsSync(runtime.sessionRoot)) return copied;
  for (const path of readdirSync(runtime.sessionRoot, { recursive: true })) {
    const source = join(runtime.sessionRoot, String(path));
    if (!source.endsWith(".jsonl")) continue;
    const target = join(destination, String(path));
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(source, target);
    copied.push(target);
  }
  return copied;
}

async function main() {
  if (!existsSync(fixturePath)) throw new Error(`Missing fixture: ${fixturePath}`);
  for (const path of extensionPaths) {
    if (!existsSync(path)) throw new Error(`Missing current extension: ${path}`);
  }

  const handshakeRuntime = makeIsolatedRuntime();
  const handshake = await runHandshake(handshakeRuntime);

  const textRuntime = makeIsolatedRuntime();
  await runTurn(
    textRuntime,
    "02-text-turn",
    "Reply exactly with SPI_TEXT_OK and nothing else. Do not use tools.",
  );

  const toolRuntime = makeIsolatedRuntime();
  await runTurn(
    toolRuntime,
    "03-tool-turn",
    `You must call the built-in read tool exactly once to read ${fixturePath}. After it returns, answer exactly with the marker contained in that file and nothing else.`,
  );

  const abortRuntime = makeIsolatedRuntime();
  await runAbort(abortRuntime);

  const deathRuntime = makeIsolatedRuntime();
  const death = await runDeath(deathRuntime);
  await runRecovery(deathRuntime, death.sessionFile);

  const copiedSessions = [
    ...(await copySessionAssets(handshakeRuntime, "handshake")),
    ...(await copySessionAssets(textRuntime, "text")),
    ...(await copySessionAssets(toolRuntime, "tool")),
    ...(await copySessionAssets(abortRuntime, "abort")),
    ...(await copySessionAssets(deathRuntime, "death-and-recovery")),
  ];
  writeJson("run-summary.json", {
    at: now(),
    repoRoot,
    piPath,
    piVersion: "0.84.1 (captured before run with pi --version)",
    fixturePath,
    extensionPaths,
    handshake,
    copiedSessions,
  });

  for (const runtime of [handshakeRuntime, textRuntime, toolRuntime, abortRuntime, deathRuntime]) {
    rmSync(runtime.root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
