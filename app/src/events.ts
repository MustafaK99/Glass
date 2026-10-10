// The events glass-core emits, as they arrive over the channel.
// Mirrors `glass_core::Event` in crates/core/src/event.rs; keep the two in step.

export type Role = "system" | "user" | "assistant" | "tool";

export interface ToolCall {
  id: string;
  name: string;
  arguments: string;
}

export interface Touched {
  path: string;
  kind: string;
}

export interface Usage {
  prompt_tokens: number;
  completion_tokens: number;
  cached_tokens: number;
}

export interface Message {
  id: string;
  role: Role;
  content: string;
  reasoning: string | null;
  tool_calls: ToolCall[];
  tool_call_id: string | null;
  display: string | null;
  success: boolean;
  touched: Touched[];
  exit_code: number | null;
  usage: Usage | null;
}

export type AgentEvent =
  | { type: "input_accepted"; message_id: string }
  | { type: "input_rejected"; message_id: string; reason: string }
  | { type: "turn_started" }
  | { type: "text"; delta: string }
  | { type: "reasoning"; delta: string }
  | { type: "tool_call_delta"; index: number; name: string; arguments: string }
  | { type: "approval_requested"; call_id: string; tool: string; arguments: string }
  | { type: "approval_resolved"; call_id: string; approved: boolean }
  | ({ type: "message" } & Message)
  | { type: "task"; id: string; tool: string; status: string; display: string | null }
  | { type: "context_usage"; tokens: number; window: number }
  | { type: "context_report"; system_tokens: number; tool_tokens: number; tools: string[] }
  | { type: "speed"; tokens_per_second: number }
  | { type: "compaction_started" }
  | { type: "rewound"; entry_id: string; removed_entries: number }
  | { type: "log"; level: string; text: string }
  | { type: "turn_completed" }
  | { type: "turn_interrupted" }
  | { type: "turn_error"; message: string }
  | { type: "closed"; error: string | null };

/** What the Rust side sends on the channel, for every agent. */
export interface Envelope {
  agent_id: string;
  seq: number;
  event: AgentEvent;
}
