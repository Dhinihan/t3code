// @effect-diagnostics nodeBuiltinImport:off globalFetch:off
import * as NodeHttp from "node:http";

import { assert, it } from "@effect/vitest";

import extension, {
  makePiT3McpExtensionWrapperSource,
  PI_T3_MCP_TOOL_PREFIX,
  type PiT3McpToolDefinition,
} from "./PiT3McpExtension.ts";

interface RecordedRequest {
  readonly method: string;
  readonly authorization: string | undefined;
  readonly sessionId: string | undefined;
  readonly body: Record<string, unknown> | undefined;
}

const readRequestBody = async (request: NodeHttp.IncomingMessage): Promise<string> => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
};

it("connects eagerly, forwards authenticated tool calls, and closes the MCP session", async () => {
  const authorizationHeader = "Bearer disposable-ticket-19";
  const requests: RecordedRequest[] = [];
  const sessionId = "mcp-session-ticket-19";
  let credentialRevoked = false;

  const server = NodeHttp.createServer(async (request, responseStream) => {
    const rawBody = await readRequestBody(request);
    const body =
      rawBody.length === 0 ? undefined : (JSON.parse(rawBody) as Record<string, unknown>);
    requests.push({
      method: request.method ?? "",
      authorization: request.headers.authorization,
      sessionId: request.headers["mcp-session-id"]?.toString(),
      body,
    });

    if (credentialRevoked || request.headers.authorization !== authorizationHeader) {
      responseStream.writeHead(401, { "content-type": "application/json" });
      responseStream.end(JSON.stringify({ error: "invalid_mcp_credential" }));
      return;
    }

    if (request.method === "DELETE") {
      credentialRevoked = true;
      responseStream.writeHead(204);
      responseStream.end();
      return;
    }

    const method = body?.method;
    if (method === "initialize") {
      responseStream.writeHead(200, {
        "content-type": "application/json",
        "mcp-session-id": sessionId,
      });
      responseStream.end(
        JSON.stringify({
          jsonrpc: "2.0",
          id: body?.id,
          result: {
            protocolVersion: "2025-06-18",
            capabilities: { tools: {} },
            serverInfo: { name: "T3 test MCP", version: "test" },
          },
        }),
      );
      return;
    }

    if (method === "notifications/initialized") {
      responseStream.writeHead(202);
      responseStream.end();
      return;
    }

    if (request.headers["mcp-session-id"] !== sessionId) {
      responseStream.writeHead(400, { "content-type": "application/json" });
      responseStream.end(JSON.stringify({ error: "missing_session" }));
      return;
    }

    if (method === "tools/list") {
      responseStream.writeHead(200, { "content-type": "application/json" });
      responseStream.end(
        JSON.stringify({
          jsonrpc: "2.0",
          id: body?.id,
          result: {
            tools: [
              {
                name: "preview_status",
                description: "Read the disposable preview status.",
                inputSchema: {
                  type: "object",
                  properties: { tabId: { type: "string" } },
                  additionalProperties: false,
                },
              },
            ],
          },
        }),
      );
      return;
    }

    if (method === "tools/call") {
      responseStream.writeHead(200, { "content-type": "application/json" });
      responseStream.end(
        JSON.stringify({
          jsonrpc: "2.0",
          id: body?.id,
          result: {
            content: [{ type: "text", text: "preview is ready" }],
            structuredContent: { available: true },
            isError: false,
          },
        }),
      );
      return;
    }

    responseStream.writeHead(404);
    responseStream.end();
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.isObject(address);
  if (!address || typeof address === "string") {
    server.close();
    return;
  }

  const registeredTools: PiT3McpToolDefinition[] = [];
  const handlers = new Map<string, (...args: ReadonlyArray<unknown>) => unknown>();
  const api = {
    on: (event: string, handler: (...args: ReadonlyArray<unknown>) => unknown) => {
      handlers.set(event, handler);
    },
    registerTool: (tool: PiT3McpToolDefinition) => {
      registeredTools.push(tool);
    },
  };

  try {
    extension(api, {
      endpoint: `http://127.0.0.1:${address.port}/mcp`,
      authorizationHeader,
    });

    await handlers.get("session_start")?.({ reason: "startup" }, {});

    assert.equal(registeredTools.length, 1);
    const tool = registeredTools[0];
    assert.isDefined(tool);
    if (!tool) return;
    assert.equal(tool.name, `${PI_T3_MCP_TOOL_PREFIX}preview_status`);
    assert.deepEqual(tool.parameters, {
      type: "object",
      properties: { tabId: { type: "string" } },
      additionalProperties: false,
    });

    const result = await tool.execute("tool-call-1", { tabId: "tab-1" }, undefined);
    assert.deepEqual(result.content, [{ type: "text", text: "preview is ready" }]);
    assert.deepEqual(result.details, { available: true });

    const call = requests.find((request) => request.body?.method === "tools/call");
    assert.deepEqual(call?.body?.params, {
      name: "preview_status",
      arguments: { tabId: "tab-1" },
    });
    assert.equal(call?.authorization, authorizationHeader);
    assert.equal(call?.sessionId, sessionId);

    await handlers.get("session_shutdown")?.({ reason: "quit" }, {});
    assert.equal(requests.at(-1)?.method, "DELETE");
    assert.equal(requests.at(-1)?.authorization, authorizationHeader);
    assert.equal(requests.at(-1)?.sessionId, sessionId);
    assert.equal(credentialRevoked, true);

    const rejected = await fetch(`http://127.0.0.1:${address.port}/mcp`, {
      method: "POST",
      headers: { authorization: authorizationHeader },
      body: JSON.stringify({ jsonrpc: "2.0", id: 99, method: "ping", params: {} }),
    });
    assert.equal(rejected.status, 401);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

it("builds a wrapper that keeps session configuration out of the environment", () => {
  const source = makePiT3McpExtensionWrapperSource({
    extensionPath: "/tmp/PiT3McpExtension.ts",
    config: {
      endpoint: "http://127.0.0.1:43123/mcp",
      authorizationHeader: "Bearer wrapper-secret",
    },
  });

  assert.include(source, "/tmp/PiT3McpExtension.ts");
  assert.include(source, "Bearer wrapper-secret");
  assert.notInclude(source, "process.env");
  assert.notInclude(source, "T3_MCP_BEARER_TOKEN");
});
