// @effect-diagnostics globalFetch:off globalConsole:off
/**
 * The T3 MCP bridge loaded only by the main Pi process.
 *
 * This file intentionally has no imports. The server writes a short wrapper
 * next to it with the endpoint and bearer for one provider session, then Pi
 * loads that wrapper through --extension. Subagent sessions do not inherit
 * that CLI argument, and no Pi settings or project files are changed.
 */

export const PI_T3_MCP_TOOL_PREFIX = "t3_";
const MCP_PROTOCOL_VERSION = "2025-06-18";

export interface PiT3McpConfig {
  readonly endpoint: string;
  readonly authorizationHeader: string;
}

export interface PiT3McpToolResult {
  readonly content: ReadonlyArray<Record<string, unknown>>;
  readonly details?: unknown;
  readonly isError?: boolean;
}

export interface PiT3McpToolDefinition {
  readonly name: string;
  readonly label: string;
  readonly description: string;
  readonly parameters: Record<string, unknown>;
  readonly execute: (
    toolCallId: string,
    params: Record<string, unknown>,
    signal: AbortSignal | undefined,
  ) => Promise<PiT3McpToolResult>;
}

interface PiT3McpExtensionApi {
  readonly on: (
    event: "session_start" | "session_shutdown",
    handler: (...args: ReadonlyArray<unknown>) => unknown,
  ) => void;
  readonly registerTool: (tool: PiT3McpToolDefinition) => void;
}

interface JsonObject {
  [key: string]: unknown;
}

interface McpToolResult {
  readonly content?: ReadonlyArray<JsonObject>;
  readonly structuredContent?: unknown;
  readonly isError?: boolean;
}

const isRecord = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const asRecord = (value: unknown): JsonObject => (isRecord(value) ? value : {});

const asString = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "request failed";
}

function sanitizeToolName(name: string): string {
  const sanitized = name.replace(/[^A-Za-z0-9_-]/g, "_").replace(/^[^A-Za-z_]/, "_");
  return sanitized || "tool";
}

function makeUniqueToolName(name: string, usedNames: Set<string>): string {
  const baseName = `${PI_T3_MCP_TOOL_PREFIX}${sanitizeToolName(name)}`;
  let candidate = baseName;
  let suffix = 2;
  while (usedNames.has(candidate)) {
    candidate = `${baseName}_${suffix}`;
    suffix += 1;
  }
  usedNames.add(candidate);
  return candidate;
}

async function readResponseBody(response: Response): Promise<JsonObject | undefined> {
  const text = await response.text();
  if (!text.trim()) {
    return undefined;
  }

  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("text/event-stream")) {
    const data = text
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice("data:".length).trim())
      .filter(Boolean)
      .join("\n");
    if (!data) {
      return undefined;
    }
    return asRecord(JSON.parse(data));
  }

  return asRecord(JSON.parse(text));
}

function responseError(response: JsonObject): Error | undefined {
  const error = asRecord(response.error);
  const message = asString(error.message);
  return message ? new Error(message) : undefined;
}

function mapMcpContent(content: ReadonlyArray<JsonObject>): ReadonlyArray<Record<string, unknown>> {
  return content.map((block) => {
    if (block.type === "text" && typeof block.text === "string") {
      return { type: "text", text: block.text };
    }
    if (
      block.type === "image" &&
      typeof block.data === "string" &&
      typeof block.mimeType === "string"
    ) {
      return { type: "image", data: block.data, mimeType: block.mimeType };
    }
    return { type: "text", text: JSON.stringify(block) };
  });
}

function mapMcpToolResult(result: McpToolResult): PiT3McpToolResult {
  const content = result.content ? mapMcpContent(result.content) : [];
  const mappedContent =
    content.length > 0
      ? content
      : result.structuredContent === undefined
        ? [{ type: "text", text: "The T3 MCP tool returned no content." }]
        : [{ type: "text", text: JSON.stringify(result.structuredContent) }];

  return {
    content: mappedContent,
    ...(result.structuredContent !== undefined ? { details: result.structuredContent } : {}),
    ...(result.isError !== undefined ? { isError: result.isError } : {}),
  };
}

export function makePiT3McpExtensionWrapperSource(input: {
  readonly extensionPath: string;
  readonly config: PiT3McpConfig;
}): string {
  return [
    `import extension from ${JSON.stringify(input.extensionPath)};`,
    `const config = ${JSON.stringify(input.config)};`,
    "export default function (pi) { return extension(pi, config); }",
    "",
  ].join("\n");
}

export default function (pi: PiT3McpExtensionApi, config: PiT3McpConfig): void {
  let requestId = 0;
  let mcpSessionId: string | undefined;
  let shutdownPromise: Promise<void> | undefined;
  const registeredToolNames = new Set<string>();

  const request = async (
    method: string,
    params: JsonObject | undefined,
    signal: AbortSignal | undefined,
    sessionId: string | undefined = mcpSessionId,
  ): Promise<JsonObject | undefined> => {
    const headers: Record<string, string> = {
      accept: "application/json, text/event-stream",
      authorization: config.authorizationHeader,
      "content-type": "application/json",
      "mcp-protocol-version": MCP_PROTOCOL_VERSION,
    };
    if (sessionId) {
      headers["mcp-session-id"] = sessionId;
    }

    const body: JsonObject = {
      jsonrpc: "2.0",
      method,
      ...(params ? { params } : {}),
    };
    if (method !== "notifications/initialized") {
      body.id = ++requestId;
    }

    const response = await fetch(config.endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      ...(signal ? { signal } : {}),
    });
    if (!response.ok && response.status !== 202 && response.status !== 204) {
      throw new Error(`HTTP ${response.status}`);
    }

    const responseSessionId = response.headers.get("mcp-session-id");
    if (responseSessionId) {
      mcpSessionId = responseSessionId;
    }

    const payload = await readResponseBody(response);
    if (payload) {
      const rpcError = responseError(payload);
      if (rpcError) {
        throw rpcError;
      }
    }
    return payload;
  };

  const closeMcpSession = async (): Promise<void> => {
    const sessionId = mcpSessionId;
    mcpSessionId = undefined;
    registeredToolNames.clear();
    if (!sessionId) {
      return;
    }

    try {
      const response = await fetch(config.endpoint, {
        method: "DELETE",
        headers: {
          accept: "application/json, text/event-stream",
          authorization: config.authorizationHeader,
          "mcp-protocol-version": MCP_PROTOCOL_VERSION,
          "mcp-session-id": sessionId,
        },
      });
      if (!response.ok && response.status !== 404 && response.status !== 410) {
        throw new Error(`HTTP ${response.status}`);
      }
    } catch {
      // The bearer is scoped and expires server-side. Shutdown must remain
      // best-effort so a dead T3 server cannot keep Pi alive.
    }
  };

  const connectMcpSession = async (): Promise<void> => {
    await closeMcpSession();
    await request(
      "initialize",
      {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "t3-code-pi", version: "1" },
      },
      undefined,
      undefined,
    );
    // Streamable HTTP carries the session id in a response header, not in the
    // JSON-RPC result. The request helper records that header above.
    const sessionId = mcpSessionId;
    if (!sessionId) {
      throw new Error("T3 MCP did not return a session id");
    }
    mcpSessionId = sessionId;

    await request("notifications/initialized", undefined, undefined);
    const toolsResponse = await request("tools/list", {}, undefined);
    const result = asRecord(toolsResponse?.result);
    const tools = Array.isArray(result.tools) ? result.tools : [];

    for (const rawTool of tools) {
      const tool = asRecord(rawTool);
      const remoteName = asString(tool.name);
      if (!remoteName) {
        continue;
      }
      const exposedName = makeUniqueToolName(remoteName, registeredToolNames);
      pi.registerTool({
        name: exposedName,
        label: remoteName,
        description: asString(tool.description) ?? `T3 MCP tool ${remoteName}`,
        parameters: isRecord(tool.inputSchema)
          ? tool.inputSchema
          : { type: "object", properties: {} },
        execute: async (_toolCallId, params, signal) => {
          const response = await request(
            "tools/call",
            { name: remoteName, arguments: params },
            signal,
          );
          return mapMcpToolResult(asRecord(response?.result) as McpToolResult);
        },
      });
    }
  };

  pi.on("session_start", async () => {
    try {
      await connectMcpSession();
    } catch (error) {
      mcpSessionId = undefined;
      console.error(`T3 MCP extension unavailable: ${errorMessage(error)}`);
    }
  });

  pi.on("session_shutdown", async () => {
    if (!shutdownPromise) {
      shutdownPromise = closeMcpSession();
    }
    await shutdownPromise;
    shutdownPromise = undefined;
  });
}
