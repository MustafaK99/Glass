// The only place the UI talks to the Rust side.
//
// Inside the desktop app this calls Tauri commands. In a plain browser (the
// Vite dev server on its own, used for UI work and checks) it replays the same
// fixtures in JavaScript so every screen can still be reached.

import type { AgentEvent } from "./events";
import approvedRaw from "../../fixtures/fix-failing-test.approved.jsonl?raw";
import rejectedRaw from "../../fixtures/fix-failing-test.rejected.jsonl?raw";

export interface AgentHandle {
  id: string;
  resolve(callId: string, approved: boolean): Promise<void>;
  stop(): Promise<void>;
}

const inTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

export async function startReplay(name: string, onEvent: (event: AgentEvent) => void): Promise<AgentHandle> {
  if (inTauri) return tauriReplay(name, onEvent);
  return browserReplay(onEvent);
}

async function tauriReplay(name: string, onEvent: (event: AgentEvent) => void): Promise<AgentHandle> {
  const { invoke, Channel } = await import("@tauri-apps/api/core");
  const events = new Channel<AgentEvent>();
  events.onmessage = onEvent;
  const id = await invoke<string>("start_replay", { name, events });
  return {
    id,
    resolve: (callId, approved) => invoke("resolve_approval", { agent: id, callId, approved }),
    stop: () => invoke("stop", { agent: id }),
  };
}

const parse = (raw: string) =>
  raw.split("\n").filter((line) => line.trim()).map((line) => JSON.parse(line) as AgentEvent);

// Same pacing and branching as app/src-tauri/src/replay.rs.
function browserReplay(onEvent: (event: AgentEvent) => void): AgentHandle {
  const approved = parse(approvedRaw);
  const rejected = parse(rejectedRaw);
  let lines = approved;
  let index = 0;
  let branchChosen = false;
  let waitingFor: string | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;

  const pause = (event: AgentEvent) => {
    if (event.type === "text" || event.type === "reasoning") return 60;
    if (event.type === "tool_call_delta") return 40;
    if (event.type === "message") return event.role === "tool" ? 500 : 150;
    if (event.type === "turn_started") return 300;
    return 30;
  };

  const step = () => {
    if (stopped) return;
    if (index >= lines.length) {
      onEvent({ type: "closed", error: null });
      return;
    }
    const event = lines[index];
    timer = setTimeout(() => {
      if (stopped) return;
      onEvent(event);
      index++;
      if (event.type === "approval_requested") {
        waitingFor = event.call_id;
        return;
      }
      step();
    }, pause(event));
  };
  step();

  return {
    id: `browser-replay-${Date.now()}`,
    resolve: async (callId, yes) => {
      if (callId !== waitingFor) return;
      waitingFor = null;
      if (!branchChosen && !yes) lines = rejected;
      branchChosen = true;
      step();
    },
    stop: async () => {
      stopped = true;
      clearTimeout(timer);
    },
  };
}
