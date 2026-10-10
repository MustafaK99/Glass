// Folds the event stream into what the screen shows for one agent.

import type { AgentEvent, Message, Touched } from "./events";

export type Status = "idle" | "running" | "attention" | "done" | "failed" | "stopped";

export const STATUS_WORD: Record<Status, string> = {
  idle: "idle",
  running: "running",
  attention: "needs you",
  done: "done",
  failed: "failed",
  stopped: "stopped",
};

export interface ToolResult {
  content: string;
  display: string | null;
  success: boolean;
  exitCode: number | null;
}

export type Item =
  | { kind: "user"; id: string; text: string }
  | { kind: "reasoning"; id: string; text: string; streaming: boolean }
  | { kind: "text"; id: string; text: string; streaming: boolean }
  | {
      kind: "tool";
      id: string;
      name: string;
      args: Record<string, unknown>;
      approval: "pending" | "approved" | "rejected" | null;
      result: ToolResult | null;
    }
  | { kind: "notice"; id: string; tone: "fail" | "idle"; text: string };

export interface AgentMeta {
  id: string;
  title: string;
  project: string;
  branch: string;
  workspace: string;
  model: string;
  api: string;
  effort: string;
  mode: "manual" | "auto";
  source: string;
}

export interface AgentState {
  meta: AgentMeta;
  items: Item[];
  status: Status;
  stopRequested: boolean;
  ctx: { tokens: number; window: number } | null;
  speed: number | null;
  tools: string[];
  touched: Touched[];
  /** Call ids waiting on the user, oldest first. */
  pending: string[];
}

export function newAgent(meta: AgentMeta): AgentState {
  return {
    meta,
    items: [],
    status: "idle",
    stopRequested: false,
    ctx: null,
    speed: null,
    tools: [],
    touched: [],
    pending: [],
  };
}

let serial = 0;
const localId = (prefix: string) => `${prefix}-${++serial}`;

function parseArgs(text: string): Record<string, unknown> {
  try {
    const value = JSON.parse(text);
    return value && typeof value === "object" ? value : { value };
  } catch {
    return { raw: text };
  }
}

function closeStreams(items: Item[]): Item[] {
  return items.map((item) =>
    (item.kind === "text" || item.kind === "reasoning") && item.streaming
      ? { ...item, streaming: false }
      : item,
  );
}

function appendDelta(items: Item[], kind: "text" | "reasoning", delta: string): Item[] {
  const last = items[items.length - 1];
  if (last && last.kind === kind && last.streaming) {
    return [...items.slice(0, -1), { ...last, text: last.text + delta }];
  }
  return [...closeStreams(items), { kind, id: localId(kind), text: delta, streaming: true }];
}

function applyAssistant(items: Item[], message: Message): Item[] {
  let next = items;
  const streamedReasoning = next.some((item) => item.kind === "reasoning" && item.streaming);
  const streamedText = next.some((item) => item.kind === "text" && item.streaming);
  if (message.reasoning && !streamedReasoning) {
    next = [...next, { kind: "reasoning", id: localId("reasoning"), text: message.reasoning, streaming: false }];
  }
  if (message.content) {
    if (streamedText) {
      // The finished record is the source of truth for the streamed text.
      next = next.map((item) =>
        item.kind === "text" && item.streaming ? { ...item, text: message.content } : item,
      );
    } else {
      next = [...next, { kind: "text", id: message.id, text: message.content, streaming: false }];
    }
  }
  next = closeStreams(next);
  for (const call of message.tool_calls) {
    next = [
      ...next,
      { kind: "tool", id: call.id, name: call.name, args: parseArgs(call.arguments), approval: null, result: null },
    ];
  }
  return next;
}

function mergeTouched(current: Touched[], added: Touched[]): Touched[] {
  const out = [...current];
  for (const touched of added) {
    const at = out.findIndex((entry) => entry.path === touched.path);
    if (at === -1) out.push(touched);
    else if (touched.kind !== "read") out[at] = touched;
  }
  return out;
}

function settle(state: AgentState): Status {
  return state.pending.length > 0 ? "attention" : "running";
}

export function apply(state: AgentState, event: AgentEvent): AgentState {
  switch (event.type) {
    case "turn_started":
      return { ...state, status: "running", stopRequested: false };
    case "text":
      return { ...state, items: appendDelta(state.items, "text", event.delta) };
    case "reasoning":
      return { ...state, items: appendDelta(state.items, "reasoning", event.delta) };
    case "message": {
      if (event.role === "user") {
        return { ...state, items: [...closeStreams(state.items), { kind: "user", id: event.id, text: event.content }] };
      }
      if (event.role === "assistant") {
        return { ...state, items: applyAssistant(state.items, event) };
      }
      if (event.role === "tool" && event.tool_call_id) {
        const result: ToolResult = {
          content: event.content,
          display: event.display,
          success: event.success,
          exitCode: event.exit_code,
        };
        return {
          ...state,
          touched: mergeTouched(state.touched, event.touched),
          items: state.items.map((item) =>
            item.kind === "tool" && item.id === event.tool_call_id ? { ...item, result } : item,
          ),
        };
      }
      return state;
    }
    case "approval_requested": {
      const known = state.items.some((item) => item.kind === "tool" && item.id === event.call_id);
      const items = known
        ? state.items.map((item) =>
            item.kind === "tool" && item.id === event.call_id ? { ...item, approval: "pending" as const } : item,
          )
        : [
            ...state.items,
            {
              kind: "tool" as const,
              id: event.call_id,
              name: event.tool,
              args: parseArgs(event.arguments),
              approval: "pending" as const,
              result: null,
            },
          ];
      const next = { ...state, items, pending: [...state.pending, event.call_id] };
      return { ...next, status: "attention" };
    }
    case "approval_resolved": {
      const next = {
        ...state,
        pending: state.pending.filter((id) => id !== event.call_id),
        items: state.items.map((item) =>
          item.kind === "tool" && item.id === event.call_id
            ? { ...item, approval: event.approved ? ("approved" as const) : ("rejected" as const) }
            : item,
        ),
      };
      return { ...next, status: settle(next) };
    }
    case "context_usage":
      return { ...state, ctx: { tokens: event.tokens, window: event.window } };
    case "context_report":
      return { ...state, tools: event.tools };
    case "speed":
      return { ...state, speed: event.tokens_per_second };
    case "turn_completed":
      return { ...state, items: closeStreams(state.items), status: "done" };
    case "turn_interrupted":
      if (state.stopRequested) {
        return { ...state, items: closeStreams(state.items), status: "stopped", pending: [] };
      }
      // The worker reports a failed model request this way, with no reason attached.
      return {
        ...state,
        items: [
          ...closeStreams(state.items),
          { kind: "notice", id: localId("notice"), tone: "fail", text: "The turn stopped without a reason. The model request probably failed. Check the provider key and endpoint." },
        ],
        status: "failed",
        pending: [],
      };
    case "turn_error":
      return {
        ...state,
        items: [...closeStreams(state.items), { kind: "notice", id: localId("notice"), tone: "fail", text: event.message }],
        status: "failed",
        pending: [],
      };
    case "input_rejected":
      return {
        ...state,
        items: [...state.items, { kind: "notice", id: localId("notice"), tone: "fail", text: `Message not accepted: ${event.reason}` }],
      };
    case "closed":
      if (event.error) {
        return {
          ...state,
          items: [...state.items, { kind: "notice", id: localId("notice"), tone: "fail", text: event.error }],
          status: "failed",
          pending: [],
        };
      }
      return state;
    default:
      return state;
  }
}

/** A path relative to the agent's workspace, for display. */
export function relative(path: string, workspace: string): string {
  const root = workspace.endsWith("/") ? workspace : `${workspace}/`;
  return path.startsWith(root) ? path.slice(root.length) : path;
}

/** Count added and removed lines in a unified diff. */
export function diffStat(diff: string): { add: number; del: number } {
  let add = 0;
  let del = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+")) add++;
    else if (line.startsWith("-")) del++;
  }
  return { add, del };
}
