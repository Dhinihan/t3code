/**
 * Forwards the installed subagents dashboard snapshots through Pi's RPC UI
 * event channel. This file is intentionally import-free and owns no state
 * outside the current Pi session.
 */

export const PI_SUBAGENTS_STATUS_KEY = "t3-subagents:v1";
export const PI_SUBAGENTS_SNAPSHOT_CHANNEL = "dashboard:subagents:snapshot";

interface PiSubagentsUi {
  readonly setStatus: (key: string, text: string | undefined) => void;
}

interface PiSubagentsEventBus {
  readonly on: (channel: string, listener: (payload: unknown) => void) => () => void;
}

interface PiSubagentsContext {
  readonly ui: PiSubagentsUi;
}

interface PiSubagentsExtensionApi {
  readonly events: PiSubagentsEventBus;
  readonly on: (
    event: "session_start" | "session_shutdown",
    handler: (event: unknown, ctx: PiSubagentsContext) => unknown,
  ) => void;
}

export default function (pi: PiSubagentsExtensionApi): void {
  let unsubscribe: (() => void) | undefined;
  let ui: PiSubagentsUi | undefined;

  const detach = () => {
    unsubscribe?.();
    unsubscribe = undefined;
    ui?.setStatus(PI_SUBAGENTS_STATUS_KEY, undefined);
    ui = undefined;
  };

  pi.on("session_start", (_event, ctx) => {
    detach();
    ui = ctx.ui;
    unsubscribe = pi.events.on(PI_SUBAGENTS_SNAPSHOT_CHANNEL, (payload) => {
      const text = JSON.stringify(payload);
      if (text !== undefined) ui?.setStatus(PI_SUBAGENTS_STATUS_KEY, text);
    });
  });

  pi.on("session_shutdown", (_event, _ctx) => {
    detach();
  });
}
