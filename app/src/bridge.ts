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

export const startAgent = (workspace: string, message: string, effort: string, auto: boolean, checkout: boolean, title: string) =>
  call<AgentInfo>("start_agent", { workspace, message, effort, auto, checkout, title });

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

export const setEffort = (agent: string, effort: string) => call<void>("set_effort", { agent, effort });
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

function browserSnapshot(id: string, name: string): string {
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
