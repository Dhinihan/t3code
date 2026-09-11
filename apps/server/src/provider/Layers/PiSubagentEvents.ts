import {
  RuntimeTaskId,
  type ProviderRuntimeEvent,
  type TaskAgentLinkage,
  type TurnId,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { PI_SUBAGENTS_STATUS_KEY } from "../pi/PiSubagentsExtension.ts";
import type { PiRpcEvent } from "./PiRpcContract.ts";

type TaskEvent = Extract<
  ProviderRuntimeEvent,
  {
    type: "task.started" | "task.progress" | "task.updated" | "task.completed";
  }
>;
type Update = {
  [K in TaskEvent["type"]]: Pick<Extract<TaskEvent, { type: K }>, "type" | "payload" | "turnId">;
}[TaskEvent["type"]];

const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const Text = Schema.String.check(Schema.isMinLength(1));
// Parse only the dashboard fields that have consumers in the existing T3 model.
const Session = Schema.Struct({
  id: Text,
  origin: Schema.Literals(["model", "btw"]),
  title: Text,
  model: Schema.NullOr(Text),
  status: Schema.Literals(["running", "done", "error"]),
  terminalReason: Schema.NullOr(Schema.Literals(["completed", "failed", "cancelled"])),
  cumulative: Schema.Struct({ tokens: Schema.NullOr(Count) }),
  generation: Schema.Struct({ active: Schema.Boolean }),
  tools: Schema.Struct({
    active: Count,
    done: Count,
    error: Count,
    activities: Schema.Array(
      Schema.Struct({
        kind: Schema.Literals(["bash", "read", "write", "edit", "search", "other"]),
        state: Schema.Literals(["running", "completed", "failed"]),
      }),
    ),
  }),
});
const decodeSnapshot = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      protocolVersion: Schema.Literal(1),
      sequence: Count,
      sessions: Schema.Array(Session),
    }),
  ),
);
const decodeSpawnResult = Schema.decodeUnknownOption(
  Schema.Struct({
    toolCallId: Text,
    result: Schema.Struct({ details: Schema.Struct({ id: Text }) }),
  }),
);

type State = {
  readonly taskId: RuntimeTaskId;
  readonly turnId: TurnId | undefined;
  linkage: TaskAgentLinkage;
  projection: string;
  live: boolean;
};

/** One reducer per Pi process. Local sa-* IDs are not durable session identities. */
export function makePiSubagentEvents({ runtimeId }: { readonly runtimeId: string }) {
  const states = new Map<string, State>();
  const launches = new Map<string, { toolUseId: string; turnId: TurnId | undefined }>();
  let sequence = -1;
  let closed = false;

  const accept = ({
    event,
    turnId,
  }: {
    readonly event: PiRpcEvent;
    readonly turnId?: TurnId | undefined;
  }): ReadonlyArray<Update> => {
    if (closed) return [];
    if (event.type === "tool_execution_end" && event.toolName === "subagent_spawn") {
      const decoded = decodeSpawnResult(event);
      if (Option.isNone(decoded)) return [];
      const { toolCallId, result } = decoded.value;
      launches.set(result.details.id, { toolUseId: toolCallId, turnId });
      const previous = states.get(result.details.id);
      if (!previous || previous.linkage.toolUseId === toolCallId) return [];
      previous.linkage = { ...previous.linkage, toolUseId: toolCallId };
      return [
        {
          type: "task.updated",
          turnId: previous.turnId,
          payload: { taskId: previous.taskId, ...previous.linkage },
        },
      ];
    }
    if (
      event.type !== "extension_ui_request" ||
      event.method !== "setStatus" ||
      event.statusKey !== PI_SUBAGENTS_STATUS_KEY
    )
      return [];
    const decoded = decodeSnapshot(event.statusText);
    if (Option.isNone(decoded) || decoded.value.sequence <= sequence) return [];
    const snapshot = decoded.value;
    sequence = snapshot.sequence;
    const updates: Update[] = [];
    for (const session of snapshot.sessions) {
      if (session.origin !== "model") continue;
      const previous = states.get(session.id);
      const launch = launches.get(session.id);
      const linkage: TaskAgentLinkage = {
        taskType: "subagent",
        agentKind: "agent",
        title: session.title,
        ...(session.model === null ? {} : { model: session.model }),
        ...(launch === undefined ? {} : { toolUseId: launch.toolUseId }),
      };
      const activeTool = session.tools.activities.findLast((tool) => tool.state === "running");
      const summary = activeTool
        ? `Running ${activeTool.kind}`
        : session.generation.active
          ? "Generating"
          : "Waiting";
      const toolUses = session.tools.active + session.tools.done + session.tools.error;
      const typedUsage =
        session.cumulative.tokens === null
          ? undefined
          : { totalTokens: session.cumulative.tokens, toolUses };
      const status =
        session.status === "running"
          ? "running"
          : session.terminalReason === "cancelled"
            ? "cancelled"
            : session.status === "done"
              ? "completed"
              : "failed";
      const projection = JSON.stringify([linkage, status, summary, typedUsage]);
      const state: State = {
        taskId: previous?.taskId ?? RuntimeTaskId.make(`pi:${runtimeId}:${session.id}`),
        turnId: previous ? previous.turnId : (launch?.turnId ?? turnId),
        linkage,
        projection,
        live: status === "running",
      };
      states.set(session.id, state);
      if (previous?.projection === projection) continue;
      const base = { taskId: state.taskId, ...linkage };
      if (!previous) {
        updates.push({
          type: "task.started",
          turnId: state.turnId,
          payload: { ...base, description: session.title },
        });
      }
      if (status === "running") {
        updates.push({
          type: "task.progress",
          turnId: state.turnId,
          payload: { ...base, description: session.title, status, summary, typedUsage },
        });
      } else {
        // A terminal snapshot can be our first observation. Preserve cancellation
        // explicitly before the completed vocabulary collapses it to "stopped".
        updates.push({ type: "task.updated", turnId: state.turnId, payload: { ...base, status } });
        updates.push({
          type: "task.completed",
          turnId: state.turnId,
          payload: { ...base, status: status === "cancelled" ? "stopped" : status, typedUsage },
        });
      }
    }
    return updates;
  };

  const close = (): ReadonlyArray<Update> => {
    if (closed) return [];
    closed = true;
    const updates: Update[] = [];
    for (const state of states.values()) {
      if (!state.live) continue;
      state.live = false;
      const base = { taskId: state.taskId, ...state.linkage };
      updates.push({
        type: "task.updated",
        turnId: state.turnId,
        payload: { ...base, status: "interrupted" },
      });
      updates.push({
        type: "task.completed",
        turnId: state.turnId,
        payload: { ...base, status: "stopped" },
      });
    }
    return updates;
  };
  return {
    accept,
    close,
    hasLiveTasks: () => !closed && [...states.values()].some((state) => state.live),
  };
}
