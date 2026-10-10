// The only place the UI talks to the Rust side.
//
// Inside the desktop app this calls Tauri commands, and every agent's events
// arrive on one channel as envelopes. In a plain browser (the Vite server on
// its own, used for UI work and checks) only the replay exists, done in
// JavaScript, wrapped in the same envelopes.

import type { AgentEvent, Envelope } from "./events";
import approvedRaw from "../../fixtures/fix-failing-test.approved.jsonl?raw";
import rejectedRaw from "../../fixtures/fix-failing-test.rejected.jsonl?raw";

export const inTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

export interface Setup {
  worker: string | null;
  version: string | null;
  tested_version: string;
  keys: string[];
  api: string;
  model: string;
  base_url: string | null;
  mirror_command: string;
}

export interface AgentInfo {
  id: string;
  workspace: string;
  project: string;
  branch: string;
  model: string;
  api: string;
  base_url: string | null;
}

type Listener = (envelope: Envelope) => void;
let listener: Listener = () => {};

async function core() {
  return import("@tauri-apps/api/core");
}

/** Start receiving every agent's events. Call once. */
export async function subscribe(onEnvelope: Listener): Promise<void> {
  listener = onEnvelope;
  if (!inTauri) return;
  const { invoke, Channel } = await core();
  const events = new Channel<Envelope>();
  events.onmessage = (envelope) => listener(envelope);
  await invoke("subscribe", { events });
}

async function call<T>(command: string, args: Record<string, unknown> = {}): Promise<T> {
  const { invoke } = await core();
  return invoke<T>(command, args);
}

export async function checkSetup(): Promise<Setup | null> {
  return inTauri ? call<Setup>("check_setup") : null;
}

export async function startReplay(name: string): Promise<string> {
  return inTauri ? call<string>("start_replay", { name }) : browserReplay();
}

export const startAgent = (
  workspace: string,
  message: string,
  effort: string,
  auto: boolean,
  checkout: boolean,
  title: string,
  model: { api: string; model: string; baseUrl: string | null },
) => call<AgentInfo>("start_agent", { workspace, message, effort, auto, checkout, title, api: model.api, model: model.model, baseUrl: model.baseUrl });

export const setDefaultModel = (api: string, model: string, baseUrl: string | null) => call<void>("set_default_model", { api, model, baseUrl });

export interface Project {
  path: string;
  name: string;
  git: boolean;
  /** origin's default branch, such as origin/main. Null without an origin remote. */
  origin: string | null;
}

export async function listProjects(): Promise<Project[]> {
  return inTauri ? call<Project[]>("list_projects") : [];
}

export const addProject = (path: string) => call<Project>("add_project", { path });
export const removeProject = (path: string) => call<void>("remove_project", { path });

/** Files in a workspace, relative to it, for @ mentions. The browser build lists the recording's. */
export async function listFiles(workspace: string): Promise<string[]> {
  return inTauri ? call<string[]>("list_files", { workspace }) : ["stats.py", "test_stats.py"];
}

export interface SavedAgent {
  id: string;
  title: string;
  project: string;
  project_path: string;
  workspace: string;
  branch: string;
  api: string;
  model: string;
  base_url: string | null;
  effort: string;
  auto: boolean;
  first_message: string;
  conversation_id: string | null;
}

/** Agents from the last run, with their event logs. */
export async function restoreAgents(): Promise<{ agent: SavedAgent; events: AgentEvent[] }[]> {
  return inTauri ? call("restore_agents") : [];
}

export const quitApp = () => call<void>("quit_app");

/** Calls back when the person quits (Cmd Q or closing the window). */
export async function onQuitRequested(callback: () => void): Promise<() => void> {
  if (!inTauri) return () => {};
  const { listen } = await import("@tauri-apps/api/event");
  return listen("quit-requested", callback);
}

/** A system notification. Asks for permission the first time. */
export async function notify(title: string, body: string): Promise<void> {
  if (!inTauri) return;
  const notification = await import("@tauri-apps/plugin-notification");
  let granted = await notification.isPermissionGranted();
  if (!granted) granted = (await notification.requestPermission()) === "granted";
  if (granted) notification.sendNotification({ title, body });
}

/** Calls back when the app window gains focus. */
export async function onWindowFocus(callback: () => void): Promise<() => void> {
  if (!inTauri) {
    window.addEventListener("focus", callback);
    return () => window.removeEventListener("focus", callback);
  }
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  return getCurrentWindow().onFocusChanged(({ payload: focused }) => focused && callback());
}

export const sendMessage = (agent: string, message: string) => call<string>("send_message", { agent, message });

export async function resolveApproval(agent: string, callId: string, approved: boolean): Promise<void> {
  if (!inTauri) return browserResolve(agent, callId, approved);
  return call("resolve_approval", { agent, callId, approved });
}

export async function interrupt(agent: string): Promise<void> {
  if (!inTauri) return browserStop(agent, true);
  return call("interrupt", { agent });
}

export async function stopAgent(agent: string): Promise<void> {
  if (!inTauri) return browserStop(agent, false);
  return call("stop_agent", { agent });
}

export const setInference = (agent: string, api: string, model: string, baseUrl: string | null, effort: string) =>
  call<void>("set_inference", { agent, api, model, baseUrl, effort });
export const setApprovalMode = (agent: string, auto: boolean) => call<void>("set_approval_mode", { agent, auto });
export const restartAgent = (agent: string) => call<void>("restart_agent", { agent });
export const openInEditor = (path: string) => call<void>("open_in_editor", { path });

export interface GitFile {
  path: string;
  status: "modified" | "added" | "deleted" | "renamed" | "untracked";
  diff: string;
  add: number;
  del: number;
  binary: boolean;
}

export interface GitChanges {
  git: boolean;
  branch: string;
  base: string;
  root: string;
  warning: string | null;
  files: GitFile[];
}

export const workspaceChanges = (workspace: string, context: number) =>
  call<GitChanges>("workspace_changes", { workspace, context });

/** Ask for a project folder. Null if the person cancels. */
export async function pickFolder(): Promise<string | null> {
  const { open } = await import("@tauri-apps/plugin-dialog");
  const picked = await open({ directory: true, multiple: false, title: "Open a project" });
  return typeof picked === "string" ? picked : null;
}

// Browser replay. Same pacing and branching as app/src-tauri/src/replay.rs.

const parse = (raw: string) =>
  raw.split("\n").filter((line) => line.trim()).map((line) => JSON.parse(line) as AgentEvent);

interface BrowserRun {
  resolve(callId: string, approved: boolean): void;
  stop(): void;
  emit(event: AgentEvent): void;
}
const runs = new Map<string, BrowserRun>();
let browserSerial = 0;

/**
 * Dev only: `?snap=approved-edit`, `approved-end` or `rejected-end` folds a recording
 * straight to that point, with no pacing, so a screenshot tool can capture it.
 */
export const snapshot = typeof location !== "undefined" ? new URLSearchParams(location.search).get("snap") : null;

// A reply with the markdown real models write, for checking formatting. Dev only.
const MARKDOWN_REPLY = [
  "## What I changed",
  "",
  "The `average` function divided by **one too many**. Two things changed:",
  "",
  "1. The denominator is now `len(nums)`.",
  "2. An empty list raises `ValueError` instead of dividing by zero.",
  "",
  "```python",
  "def average(nums):",
  "    if not nums:",
  '        raise ValueError("average of an empty list")',
  "    return sum(nums) / len(nums)",
  "```",
  "",
  "| test | before | after |",
  "| - | - | - |",
  "| `[2, 4, 6]` | 3.0 | 4.0 |",
  "| `[]` | ZeroDivisionError | ValueError |",
  "",
  "> Run `python3 -m unittest` to check. See [the unittest docs](https://docs.python.org/3/library/unittest.html).",
].join("\n");

function markdownEvents(): AgentEvent[] {
  const message = (id: string, role: "user" | "assistant", content: string, reasoning: string | null = null): AgentEvent => ({
    type: "message", id, role, content, reasoning, tool_calls: [], tool_call_id: null, display: null, success: true, touched: [], exit_code: null, usage: null,
  });
  return [
    { type: "turn_started" },
    message("u1", "user", "Fix the average function and explain what you changed."),
    { type: "reasoning", delta: "The test expects 4 for [2, 4, 6].\n\nThe code divides by len + 1, so it returns 3. " },
    { type: "reasoning", delta: "I should also guard the empty list." },
    { type: "text", delta: MARKDOWN_REPLY },
    message("a1", "assistant", MARKDOWN_REPLY, "The test expects 4 for [2, 4, 6].\n\nThe code divides by len + 1, so it returns 3. I should also guard the empty list."),
    { type: "turn_completed" },
  ];
}

function browserSnapshot(id: string, name: string): string {
  if (name === "long") {
    // The approved run forty times over, with fresh ids, then left open for streaming.
    const base = parse(approvedRaw).filter((event) => event.type !== "turn_completed" && event.type !== "approval_requested" && event.type !== "approval_resolved");
    const events: AgentEvent[] = [];
    for (let round = 0; round < 40; round++) {
      for (const event of base) {
        const copy = JSON.parse(JSON.stringify(event)) as Record<string, unknown>;
        for (const key of ["id", "tool_call_id"]) if (typeof copy[key] === "string") copy[key] = `${copy[key]}-${round}`;
        if (Array.isArray(copy.tool_calls)) copy.tool_calls = (copy.tool_calls as { id: string }[]).map((call) => ({ ...call, id: `${call.id}-${round}` }));
        events.push(copy as unknown as AgentEvent);
      }
    }
    let seq = 0;
    setTimeout(() => events.forEach((event) => listener({ agent_id: id, seq: seq++, event })), 0);
    // Lets a check stream more text into this agent and time it.
    (window as unknown as { __glassEmit: (event: AgentEvent) => void }).__glassEmit = (event) => listener({ agent_id: id, seq: seq++, event });
    return id;
  }
  if (name === "markdown") {
    setTimeout(() => markdownEvents().forEach((event, seq) => listener({ agent_id: id, seq, event })), 0);
    return id;
  }
  const lines = parse(name.startsWith("rejected") ? rejectedRaw : approvedRaw);
  const stop = name === "approved-edit"
    ? lines.findIndex((event) => event.type === "approval_requested" && event.call_id === "call_3_0") + 1
    : lines.length;
  // After the agent is registered, so nothing waits in the early queue.
  setTimeout(() => lines.slice(0, stop).forEach((event, seq) => listener({ agent_id: id, seq, event })), 0);
  return id;
}

function browserReplay(): string {
  const id = `replay-${++browserSerial}`;
  if (snapshot) return browserSnapshot(id, snapshot);
  const approved = parse(approvedRaw);
  const rejected = parse(rejectedRaw);
  let lines = approved;
  let index = 0;
  let seq = 0;
  let branchChosen = false;
  let waitingFor: string | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  const emit = (event: AgentEvent) => listener({ agent_id: id, seq: seq++, event });

  const pause = (event: AgentEvent) => {
    if (event.type === "text" || event.type === "reasoning") return 60;
    if (event.type === "tool_call_delta") return 40;
    if (event.type === "message") return event.role === "tool" ? 500 : 150;
    if (event.type === "turn_started") return 300;
    return 30;
  };
  const step = () => {
    if (stopped) return;
    if (index >= lines.length) return emit({ type: "closed", error: null });
    const event = lines[index];
    timer = setTimeout(() => {
      if (stopped) return;
      emit(event);
      index++;
      if (event.type === "approval_requested") waitingFor = event.call_id;
      else step();
    }, pause(event));
  };
  setTimeout(step, 0);

  runs.set(id, {
    resolve(callId, yes) {
      if (callId !== waitingFor) return;
      waitingFor = null;
      if (!branchChosen && !yes) lines = rejected;
      branchChosen = true;
      step();
    },
    stop() {
      stopped = true;
      waitingFor = null;
      clearTimeout(timer);
    },
    emit,
  });
  return id;
}

async function browserResolve(agent: string, callId: string, approved: boolean) {
  runs.get(agent)?.resolve(callId, approved);
}

// A recording has no worker to confirm an interrupt, so confirm it here.
async function browserStop(agent: string, confirm: boolean) {
  const run = runs.get(agent);
  run?.stop();
  if (confirm) run?.emit({ type: "turn_interrupted" });
}
