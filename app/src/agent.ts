// Folds one agent's event log into what the screen shows. Pure: (state, event) -> state.
// See docs/architecture.md: anything that works from a fixture works live.

import type { AgentEvent, Message, Touched } from "./events";
import { diffStat, previewEdit, previewWrite } from "./diff";

export type Status = "starting" | "idle" | "running" | "attention" | "done" | "failed" | "stopped";

export const STATUS_WORD: Record<Status, string> = {
  starting: "starting",
  idle: "idle",
  running: "running",
  attention: "needs you",
  done: "done",
  failed: "failed",
  stopped: "stopped",
};

/** The dot colour for a status. Starting reads as running. */
export const STATUS_DOT: Record<Status, string> = { ...STATUS_WORD, starting: "running", attention: "attention" };

export interface ToolResult {
  content: string;
  display: string | null;
  success: boolean;
  exitCode: number | null;
}

export interface ToolItem {
  kind: "tool";
  id: string;
  name: string;
  args: Record<string, unknown>;
  approval: "pending" | "approved" | "rejected" | null;
  result: ToolResult | null;
}

export type Item =
  | { kind: "user"; id: string; text: string }
  /** `open` until the finished record confirms it; `streaming` while deltas arrive. */
  | { kind: "reasoning"; id: string; text: string; streaming: boolean; open: boolean }
  | { kind: "text"; id: string; text: string; streaming: boolean; open: boolean }
  | ToolItem
  /** A tool call the model is still writing. Replaced by the finished call. */
  | { kind: "draft"; id: string; index: number; name: string; arguments: string }
  | { kind: "notice"; id: string; tone: "fail" | "quiet"; text: string; lines: string[] };

export interface AgentMeta {
  id: string;
  title: string;
  project: string;
  /** The project folder. `workspace` differs when the agent has its own checkout. */
  projectPath: string;
  branch: string;
  workspace: string;
  model: string;
  api: string;
  baseUrl: string | null;
  effort: string;
  mode: "manual" | "auto";
  live: boolean;
  source: string;
}

export interface TaskInfo {
  id: string;
  tool: string;
  /** running, succeeded, failed or cancelled. */
  status: string;
  display: string | null;
}

export interface AgentState {
  meta: AgentMeta;
  items: Item[];
  status: Status;
  stopRequested: boolean;
  streaming: boolean;
  ctx: { tokens: number; window: number } | null;
  report: { system: number; tools: number } | null;
  speed: number | null;
  tools: string[];
  touched: Touched[];
  /** Call ids waiting on the user, oldest first. */
  pending: string[];
  /** Messages sent while the agent was busy, until the worker picks them up. */
  queued: { id: string; text: string }[];
  /** The worker's recent stderr lines, for failure screens. */
  logs: string[];
  /** Set when the session ended badly: the worker died or would not start. */
  closedError: string | null;
  /** Whether the worker ever accepted anything, so a restart can resume. */
  started: boolean;
  /** File text as the agent last read it, by path, for edit previews. */
  files: Record<string, string>;
  /** Last event sequence number seen, to notice gaps. */
  seq: number;
  /** Background tasks started by tools, such as a subagent, by id. */
  tasks: Record<string, TaskInfo>;
}

export function newAgent(meta: AgentMeta, status: Status = "idle"): AgentState {
  return {
    meta,
    items: [],
    status,
    stopRequested: false,
    streaming: false,
    ctx: null,
    report: null,
    speed: null,
    tools: [],
    touched: [],
    pending: [],
    queued: [],
    logs: [],
    closedError: null,
    started: false,
    files: {},
    seq: -1,
    tasks: {},
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

const str = (value: unknown) => (typeof value === "string" ? value : "");

function closeStreams(items: Item[]): Item[] {
  return items.map((item) =>
    (item.kind === "text" || item.kind === "reasoning") && item.streaming ? { ...item, streaming: false } : item,
  );
}

function appendDelta(items: Item[], kind: "text" | "reasoning", delta: string): Item[] {
  const last = items[items.length - 1];
  if (last && last.kind === kind && last.streaming) {
    return [...items.slice(0, -1), { ...last, text: last.text + delta }];
  }
  return [...closeStreams(items), { kind, id: localId(kind), text: delta, streaming: true, open: true }];
}

function appendDraft(items: Item[], index: number, name: string, args: string): Item[] {
  const at = items.findIndex((item) => item.kind === "draft" && item.index === index);
  if (at === -1) {
    return [...closeStreams(items), { kind: "draft", id: localId("draft"), index, name, arguments: args }];
  }
  const draft = items[at] as Extract<Item, { kind: "draft" }>;
  const next = { ...draft, name: draft.name || name, arguments: draft.arguments + args };
  return [...items.slice(0, at), next, ...items.slice(at + 1)];
}

function applyAssistant(items: Item[], message: Message): Item[] {
  let next: Item[] = items.filter((item) => item.kind !== "draft");
  const streamedReasoning = next.some((item) => item.kind === "reasoning" && item.open);
  const streamedText = next.some((item) => item.kind === "text" && item.open);
  if (message.reasoning && !streamedReasoning) {
    next = [...next, { kind: "reasoning", id: localId("reasoning"), text: message.reasoning, streaming: false, open: false }];
  }
  if (message.content) {
    if (streamedText) {
      // The finished record is the source of truth for the streamed text.
      next = next.map((item) => (item.kind === "text" && item.open ? { ...item, text: message.content } : item));
    } else {
      next = [...next, { kind: "text", id: message.id, text: message.content, streaming: false, open: false }];
    }
  }
  next = closeStreams(next).map((item) => ((item.kind === "text" || item.kind === "reasoning") && item.open ? { ...item, open: false } : item));
  for (const call of message.tool_calls) {
    if (next.some((item) => item.kind === "tool" && item.id === call.id)) continue;
    next = [...next, { kind: "tool", id: call.id, name: call.name, args: parseArgs(call.arguments), approval: null, result: null }];
  }
  return next;
}

function mergeTouched(current: Touched[], added: Touched[]): Touched[] {
  const out = [...current];
  for (const touched of added) {
    const at = out.findIndex((entry) => entry.path === touched.path);
    if (at === -1) out.push(touched);
    else if (out[at].kind !== touched.kind && !out[at].kind.includes(touched.kind)) {
      out[at] = { ...out[at], kind: `${out[at].kind} · ${touched.kind}` };
    }
  }
  return out;
}

function notice(state: AgentState, text: string, withLogs: boolean): Item {
  return { kind: "notice", id: localId("notice"), tone: "fail", text, lines: withLogs ? state.logs.slice(-6) : [] };
}

export function apply(state: AgentState, event: AgentEvent): AgentState {
  switch (event.type) {
    case "input_accepted":
      return { ...state, started: true, status: state.status === "starting" ? "running" : state.status };
    case "turn_started":
      return { ...state, status: state.pending.length ? "attention" : "running", stopRequested: false, started: true, closedError: null };
    case "text":
      return { ...state, streaming: true, items: appendDelta(state.items, "text", event.delta) };
    case "reasoning":
      return { ...state, streaming: true, items: appendDelta(state.items, "reasoning", event.delta) };
    case "tool_call_delta":
      return { ...state, streaming: true, items: appendDraft(state.items, event.index, event.name, event.arguments) };
    case "message": {
      if (event.role === "user") {
        return {
          ...state,
          queued: state.queued.filter((entry) => entry.id !== event.id),
          items: [...closeStreams(state.items), { kind: "user", id: event.id, text: event.content }],
        };
      }
      if (event.role === "assistant") {
        return { ...state, streaming: false, items: applyAssistant(state.items, event) };
      }
      if (event.role === "tool" && event.tool_call_id) {
        const result: ToolResult = { content: event.content, display: event.display, success: event.success, exitCode: event.exit_code };
        const call = state.items.find((item): item is ToolItem => item.kind === "tool" && item.id === event.tool_call_id);
        let files = state.files;
        if (call?.name === "read" && event.success) {
          // The call names the path one way and the touched list may another; keep both.
          for (const path of [toolPath(call), ...event.touched.map((touched) => touched.path)]) {
            if (path) files = { ...files, [path]: event.content, [relative(path, state.meta.workspace)]: event.content };
          }
        }
        return {
          ...state,
          files,
          touched: mergeTouched(state.touched, event.touched),
          items: state.items.map((item) => (item.kind === "tool" && item.id === event.tool_call_id ? { ...item, result } : item)),
        };
      }
      return state;
    }
    case "approval_requested": {
      const known = state.items.some((item) => item.kind === "tool" && item.id === event.call_id);
      const items: Item[] = known
        ? state.items.map((item) => (item.kind === "tool" && item.id === event.call_id ? { ...item, approval: "pending" as const } : item))
        : [...state.items, { kind: "tool", id: event.call_id, name: event.tool, args: parseArgs(event.arguments), approval: "pending", result: null }];
      return { ...state, items, pending: [...state.pending, event.call_id], status: "attention" };
    }
    case "approval_resolved": {
      const pending = state.pending.filter((id) => id !== event.call_id);
      return {
        ...state,
        pending,
        status: pending.length ? "attention" : state.status === "attention" ? "running" : state.status,
        items: state.items.map((item) =>
          item.kind === "tool" && item.id === event.call_id ? { ...item, approval: event.approved ? ("approved" as const) : ("rejected" as const) } : item,
        ),
      };
    }
    case "context_usage":
      return { ...state, ctx: { tokens: event.tokens, window: event.window } };
    case "context_report":
      return { ...state, tools: event.tools, report: { system: event.system_tokens, tools: event.tool_tokens } };
    case "task":
      return { ...state, tasks: { ...state.tasks, [event.id]: { id: event.id, tool: event.tool, status: event.status, display: event.display } } };
    case "speed":
      return { ...state, speed: event.tokens_per_second };
    case "compaction_started":
      return { ...state, items: [...state.items, { kind: "notice", id: localId("notice"), tone: "quiet", text: "Mirror is compacting the context", lines: [] }] };
    case "log":
      return { ...state, logs: [...state.logs, event.text].slice(-40) };
    case "turn_completed":
      return { ...state, streaming: false, items: closeStreams(state.items), status: "done", pending: [] };
    case "turn_interrupted":
      if (state.stopRequested) {
        return { ...state, streaming: false, items: closeStreams(state.items), status: "stopped", pending: [] };
      }
      // Mirror reports a failed model request this way, with no reason attached.
      return {
        ...state,
        streaming: false,
        items: [
          ...closeStreams(state.items),
          notice(state, "The model request failed. Mirror stopped the turn without a reason. The usual causes are a missing key, a bad key or an unreachable endpoint.", true),
        ],
        status: "failed",
        pending: [],
      };
    case "turn_error":
      return { ...state, streaming: false, items: [...closeStreams(state.items), notice(state, event.message, true)], status: "failed", pending: [] };
    case "input_rejected":
      return { ...state, items: [...state.items, notice(state, `Mirror did not accept the message: ${event.reason}`, false)] };
    case "closed":
      if (event.error) {
        return { ...state, streaming: false, items: closeStreams(state.items), closedError: event.error, status: "failed", pending: [] };
      }
      return state;
    default:
      return state;
  }
}

/** Fold an envelope, noting a gap in the sequence. */
export function applyEnvelope(state: AgentState, seq: number, event: AgentEvent): AgentState {
  let next = state;
  if (state.seq >= 0 && seq !== state.seq + 1) {
    next = { ...next, items: [...next.items, { kind: "notice", id: localId("notice"), tone: "quiet", text: `${seq - state.seq - 1} events were lost here`, lines: [] }] };
  }
  return { ...apply(next, event), seq };
}

/** A path relative to the agent's workspace, for display. */
export function relative(path: string, workspace: string): string {
  const root = workspace.endsWith("/") ? workspace : `${workspace}/`;
  return path.startsWith(root) ? path.slice(root.length) : path;
}

export function toolPath(item: ToolItem): string {
  return str(item.args.file_path) || str(item.args.path);
}

/** The diff for an edit or write: the worker's own once it ran, a preview before. */
export function toolDiff(item: ToolItem, files: Record<string, string>, workspace: string): string {
  if (item.result?.display && item.result.success && item.approval !== "rejected") return item.result.display;
  const path = toolPath(item);
  const file = files[path] ?? files[relative(path, workspace)] ?? null;
  if (item.name === "edit") return previewEdit(file, str(item.args.old_string), str(item.args.new_string));
  if (item.name === "write") return previewWrite(str(item.args.content));
  return "";
}

export interface FileChange {
  path: string;
  /** One entry per edit, oldest first. */
  diffs: { id: string; diff: string; proposed: boolean }[];
  add: number;
  del: number;
  proposed: boolean;
}

/** Files the agent changed or proposes to change this session, in first-touched order. */
export function changes(state: AgentState): FileChange[] {
  const byPath = new Map<string, FileChange>();
  for (const item of state.items) {
    if (item.kind !== "tool" || (item.name !== "edit" && item.name !== "write")) continue;
    const proposed = item.approval === "pending";
    const applied = item.approval !== "rejected" && item.result?.success === true;
    if (!proposed && !applied) continue;
    const path = toolPath(item);
    const diff = toolDiff(item, state.files, state.meta.workspace);
    const entry = byPath.get(path) ?? { path, diffs: [], add: 0, del: 0, proposed: false };
    const { add, del } = diffStat(diff);
    entry.diffs.push({ id: item.id, diff, proposed });
    entry.add += add;
    entry.del += del;
    entry.proposed ||= proposed;
    byPath.set(path, entry);
  }
  return [...byPath.values()];
}

const ORDER: Status[] = ["attention", "running", "starting", "failed", "done", "stopped", "idle"];

/** Context used, as Mirror's status line shows it. */
export function ctxPercent(ctx: { tokens: number; window: number } | null): string {
  if (!ctx || !ctx.window) return "–";
  const share = ctx.tokens / ctx.window;
  return share > 0 && share < 0.01 ? "<1%" : `${Math.round(share * 100)}%`;
}

/** Within a project: needs you, running, failed, done. */
export function byAttention(a: AgentState, b: AgentState): number {
  return ORDER.indexOf(a.status) - ORDER.indexOf(b.status);
}
