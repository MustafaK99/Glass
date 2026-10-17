// The only place the UI talks to the Rust side.
//
// Inside the desktop app this calls Tauri commands, and every agent's events
// arrive on one channel as envelopes. Outside it (the Vite server alone, in
// development) calls do nothing; src/dev/preview.ts can feed recorded events.

import type { AgentEvent, Envelope } from "./events";

export const inTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

export interface Setup {
  worker: string | null;
  version: string | null;
  tested_version: string;
  /** Mirror's saved approval mode for new sessions. */
  approval_mode: "auto" | "manual";
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

/** Development only: hand an envelope to the UI as if it came from the Rust side. */
export function emitForPreview(envelope: Envelope) {
  listener(envelope);
}

export const startAgent = (
  workspace: string,
  message: string,
  effort: string,
  auto: boolean,
  checkout: boolean,
  title: string,
  model: { api: string; model: string; baseUrl: string | null },
  race = false,
) => call<AgentInfo>("start_agent", { workspace, message, effort, auto, checkout, title, api: model.api, model: model.model, baseUrl: model.baseUrl, race });

export interface CheckResult {
  exit_code: number | null;
  tail: string;
  seconds: number;
}
/** Run an effort race's check command in one runner's workspace. */
export const runCheck = (workspace: string, command: string) => call<CheckResult>("run_check", { workspace, command });

export const setDefaultModel = (api: string, model: string, baseUrl: string | null) => call<void>("set_default_model", { api, model, baseUrl });

export interface Project {
  path: string;
  name: string;
  git: boolean;
  /** origin's default branch, such as origin/main. Null without an origin remote. */
  origin: string | null;
  /** Run in each new checkout before its agent starts. */
  setup?: string | null;
}

export async function listProjects(): Promise<Project[]> {
  return inTauri ? call<Project[]>("list_projects") : [];
}

export const addProject = (path: string) => call<Project>("add_project", { path });
export interface McpServer {
  name: string;
  kind: "command" | "url" | "unknown";
  status: "connected" | "failed" | "needs sign-in";
  detail: string | null;
  tools: string[];
}

/** MCP servers from Mirror's config, connected on first use. Outside the app there are none. */
export async function mcpServers(): Promise<McpServer[]> {
  return inTauri ? call<McpServer[]>("mcp_servers") : [];
}

/** Ask where to save, then write `contents` there. False if the person cancels. */
export async function saveText(name: string, contents: string): Promise<boolean> {
  const { save } = await import("@tauri-apps/plugin-dialog");
  const path = await save({ defaultPath: name, filters: [{ name: "Markdown", extensions: ["md"] }] });
  if (!path) return false;
  await call<void>("save_text", { path, contents });
  return true;
}

export const commitChanges = (workspace: string, message: string, push: boolean, prTitle: string | null, prBody: string | null) =>
  call<{ sha: string; branch: string; pushed: boolean; pull_request: string | null }>("commit_changes", { workspace, message, push, prTitle, prBody });

export interface Skill {
  name: string;
  description: string;
  path: string;
  scope: "personal" | "project";
}
/** Mirror skills an agent in `workspace` can use, or only personal ones with none. */
export async function listSkills(workspace: string | null): Promise<Skill[]> {
  return inTauri ? call<Skill[]>("list_skills", { workspace }) : import.meta.env.DEV ? [{ name: "tidy", description: "Clean up Python files to house style.", path: "~/.mirror/skills/tidy/SKILL.md", scope: "personal" }] : [];
}

export interface MemoryInfo {
  enabled: boolean;
  store: string;
  skills_dir: string;
  records: { id: string; key: string; situation: string; kind: string; content: string; repository: string; actor: string; updated_at: number }[];
}
export async function memoryInfo(): Promise<MemoryInfo | null> {
  return inTauri ? call<MemoryInfo>("memory_info") : null;
}
export const setMemory = (enabled: boolean) => call<void>("set_memory", { enabled });

export const skillSave = (scope: "personal" | "project", project: string | null, name: string, description: string, instructions: string, previous: string | null) =>
  call<string>("skill_save", { scope, project, name, description, instructions, previous });
export const skillInstructions = (path: string) => call<string>("skill_instructions", { path });
export const skillDelete = (path: string) => call<void>("skill_delete", { path });
/** Mirror's own memory tool, run directly: remember, forget, and replace. */
export const memorySave = (args: Record<string, unknown>) => call<string>("memory_save", { arguments: args });
export const setProjectSetup = (path: string, command: string | null) => call<void>("set_project_setup", { path, command });

/** The number on the Dock icon; zero clears it. */
export async function setBadge(count: number): Promise<void> {
  if (!inTauri) return;
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  await getCurrentWindow().setBadgeCount(count > 0 ? count : undefined);
}

export const removeProject = (path: string) => call<void>("remove_project", { path });

/** Files in a workspace, relative to it, for @ mentions.  */
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
  if (!inTauri) return;
  return call("resolve_approval", { agent, callId, approved });
}

export async function interrupt(agent: string): Promise<void> {
  if (!inTauri) return;
  return call("interrupt", { agent });
}

export async function stopAgent(agent: string): Promise<void> {
  if (!inTauri) return;
  return call("stop_agent", { agent });
}

export const setInference = (agent: string, api: string, model: string, baseUrl: string | null, effort: string) =>
  call<void>("set_inference", { agent, api, model, baseUrl, effort });
export const setApprovalMode = (agent: string, auto: boolean) => call<void>("set_approval_mode", { agent, auto });
export const cancelTask = (agent: string, taskId: string) => call<void>("cancel_task", { agent, taskId });
export const rewindAgent = (agent: string, entryId: string, restoreFiles: boolean) =>
  call<{ files_restored: boolean; removed: string[] }>("rewind_agent", { agent, entryId, restoreFiles });
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
  remote: boolean;
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


/** A shell in `cwd` for the terminal drawer, keyed by agent. Output is raw bytes. */
export async function terminalOpen(id: string, cwd: string, cols: number, rows: number, onData: (bytes: Uint8Array) => void, onExit: () => void): Promise<void> {
  const { invoke, Channel } = await core();
  const output = new Channel<{ data?: string; exit?: boolean }>();
  output.onmessage = (message) => {
    if (message.exit) return onExit();
    if (message.data) onData(Uint8Array.from(atob(message.data), (char) => char.charCodeAt(0)));
  };
  await invoke("terminal_open", { id, cwd, cols, rows, output });
}
export const terminalWrite = (id: string, data: string) => call<void>("terminal_write", { id, data });
export const terminalResize = (id: string, cols: number, rows: number) => call<void>("terminal_resize", { id, cols, rows });
export const terminalClose = (id: string) => call<void>("terminal_close", { id });

export interface SecretStatus {
  name: string;
  provider: string | null;
  source: "keychain" | "environment" | "none";
  hint: string | null;
}
/** Where each key comes from, and its last four characters. Never a value. */
export async function secretsStatus(): Promise<SecretStatus[]> {
  if (inTauri) return call<SecretStatus[]>("secrets_status");
  // Development outside the app: the rows, empty, so Settings can be laid out.
  return import.meta.env.DEV
    ? [
        { name: "REFLECTION_API_KEY", provider: "Reflection", source: "none", hint: null },
        { name: "OPENAI_API_KEY", provider: "OpenAI", source: "keychain", hint: "x7Qa" },
        { name: "ANTHROPIC_API_KEY", provider: "Anthropic", source: "environment", hint: "9fTe" },
        { name: "OPENROUTER_API_KEY", provider: "OpenRouter", source: "none", hint: null },
      ]
    : [];
}
export const secretSet = (name: string, value: string) => call<void>("secret_set", { name, value });
export const secretRemove = (name: string) => call<void>("secret_remove", { name });
/** The folder Mirror reads MCP servers from, opened in Finder. */
export const openPath = (path: string) => call<void>("open_in_editor", { path });

/** The demo script, when Glass was started to record its own demo (`GLASS_DEMO`). */
export const demoScript = () => (inTauri ? call<string | null>("demo_script") : Promise.resolve(null));
export const demoMark = (name: string) => call<void>("demo_mark", { name });
export const demoWaitGo = () => call<void>("demo_wait_go");

/** What "Always allow" or "Remember" would save for a waiting request. */
export interface ApprovalOffer {
  label: string;
  detail: string;
}
export const approvalOffer = (agent: string, callId: string) =>
  inTauri ? call<ApprovalOffer | null>("approval_offer", { agent, callId }) : Promise.resolve(null);
/** Approve and save the rule in Mirror's shared tool_approvals.json. */
export const approveAndRemember = (agent: string, callId: string) => call<void>("approve_and_remember", { agent, callId });
/** Ask Mirror to compact the context now. */
export const compact = (agent: string) => call<void>("compact", { agent });
/** Mirror's own import of Claude Code and Codex memories; returns its report. */
export const memoryImport = () => call<string>("memory_import");
/** ~/.mirror/PINNED_MEMORIES.md, created empty if missing. */
export const pinnedMemoriesPath = () => call<string>("pinned_memories_path");
/** An entry of Mirror's ~/.mirror/models.json. */
export interface MirrorModel {
  id: string;
  label: string;
  description: string | null;
  api: string | null;
  base_url: string | null;
}
export const mirrorModels = () => (inTauri ? call<MirrorModel[]>("mirror_models") : Promise.resolve([] as MirrorModel[]));
