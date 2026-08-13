// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import * as McpProviderSession from "../../mcp/McpProviderSession.ts";
import { makePiMcpSessionLease } from "./PiMcpSession.ts";

const run = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.provide(NodeServices.layer), Effect.scoped);

const makeConfig = (providerSessionId: string) => ({
  environmentId: EnvironmentId.make("environment-pi-mcp"),
  threadId: ThreadId.make("thread-pi-mcp"),
  providerSessionId,
  providerInstanceId: ProviderInstanceId.make("pi"),
  endpoint: "http://127.0.0.1:43123/mcp",
  authorizationHeader: "Bearer disposable-pi-mcp-secret",
});

it.effect("leases an ephemeral wrapper and cleans the exact provider credential", () =>
  run(
    Effect.gen(function* () {
      const config = makeConfig("provider-session-19");
      const revoked: string[] = [];
      McpProviderSession.setMcpProviderSession(config);

      const lease = yield* makePiMcpSessionLease(config, {
        revokeProviderSession: (providerSessionId) =>
          Effect.sync(() => {
            revoked.push(providerSessionId);
          }),
      });

      try {
        assert.notEqual(NodePath.dirname(lease.extensionPath), "/repo");
        assert.equal(NodeFS.existsSync(lease.extensionPath), true);
        const source = NodeFS.readFileSync(lease.extensionPath, "utf8");
        assert.include(source, config.endpoint);
        assert.include(source, config.authorizationHeader);
        assert.notInclude(source, "T3_MCP_BEARER_TOKEN");

        const replacement = makeConfig("provider-session-replacement");
        McpProviderSession.setMcpProviderSession(replacement);
        yield* lease.close;
        yield* lease.close;

        assert.equal(NodeFS.existsSync(lease.extensionPath), false);
        assert.deepEqual(revoked, [config.providerSessionId]);
        assert.equal(
          McpProviderSession.readMcpProviderSession(config.threadId)?.providerSessionId,
          replacement.providerSessionId,
        );
      } finally {
        McpProviderSession.clearAllMcpProviderSessions();
      }
    }),
  ),
);
