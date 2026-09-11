import { assert, it } from "@effect/vitest";

import extension, {
  PI_SUBAGENTS_SNAPSHOT_CHANNEL,
  PI_SUBAGENTS_STATUS_KEY,
} from "./PiSubagentsExtension.ts";

interface Ui {
  readonly setStatus: (key: string, text: string | undefined) => void;
}

it("forwards snapshots and cleans the subscription across session lifecycles", () => {
  const handlers = new Map<string, (event: unknown, ctx: { readonly ui: Ui }) => unknown>();
  const listeners = new Map<string, Set<(payload: unknown) => void>>();
  const statuses: Array<{ key: string; text: string | undefined }> = [];
  let unsubscribeCount = 0;
  const ui: Ui = {
    setStatus: (key, text) => statuses.push({ key, text }),
  };

  extension({
    events: {
      on: (channel, listener) => {
        const channelListeners = listeners.get(channel) ?? new Set();
        channelListeners.add(listener);
        listeners.set(channel, channelListeners);
        return () => {
          unsubscribeCount += 1;
          channelListeners.delete(listener);
        };
      },
    },
    on: (event, handler) => handlers.set(event, handler),
  });

  const start = handlers.get("session_start");
  const shutdown = handlers.get("session_shutdown");
  assert.isDefined(start);
  assert.isDefined(shutdown);
  if (!start || !shutdown) return;

  start(undefined, { ui });
  const snapshot = { protocolVersion: 1, sequence: 7, sessions: [] };
  for (const listener of listeners.get(PI_SUBAGENTS_SNAPSHOT_CHANNEL) ?? []) listener(snapshot);
  assert.deepEqual(statuses.at(-1), {
    key: PI_SUBAGENTS_STATUS_KEY,
    text: JSON.stringify(snapshot),
  });

  start(undefined, { ui });
  assert.equal(unsubscribeCount, 1);
  shutdown(undefined, { ui });
  assert.equal(unsubscribeCount, 2);
  assert.deepEqual(statuses.at(-1), { key: PI_SUBAGENTS_STATUS_KEY, text: undefined });
});
