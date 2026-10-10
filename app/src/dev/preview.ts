// Development only, never in the app or a release build: screens built from the
// recordings in fixtures/, so the UI can be checked in a plain browser. Loaded by
// App.tsx only when import.meta.env.DEV and not inside Tauri.
//
//   ?preview=approved-edit | approved-end | rejected-end | markdown | long | explore | mcp
//   ?setup=1  ?new=1  ?launcher=1  ?mcp=1  ?theme=dark  ?tab=session

import { apply, newAgent, type AgentMeta, type AgentState } from "../agent";
import { emitForPreview, type McpServer, type Project, type Setup } from "../bridge";
import type { AgentEvent } from "../events";
import approvedRaw from "../../../fixtures/fix-failing-test.approved.jsonl?raw";
import rejectedRaw from "../../../fixtures/fix-failing-test.rejected.jsonl?raw";
import exploreRaw from "../../../fixtures/explore.jsonl?raw";
import mcpRaw from "../../../fixtures/mcp-search.jsonl?raw";

const parse = (raw: string) => raw.split("\n").filter((line) => line.trim()).map((line) => JSON.parse(line) as AgentEvent);

const META: AgentMeta = {
  id: "preview",
  title: "Fix the failing average test",
  project: "stats-demo",
  projectPath: "/workspace/stats-demo",
  branch: "main",
  workspace: "/workspace/stats-demo",
  model: "gpt-5-nano",
  api: "openai-responses",
  baseUrl: null,
  effort: "high",
  mode: "manual",
  live: true,
  source: "preview",
};

const PROJECT: Project = { path: META.projectPath, name: META.project, git: true, origin: "origin/main" };

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
].join("\n");

function events(name: string): AgentEvent[] {
  const approved = parse(approvedRaw);
  switch (name) {
    case "approved-edit":
      return approved.slice(0, approved.findIndex((event) => event.type === "approval_requested" && event.call_id === "call_3_0") + 1);
    case "approved-end":
      return approved;
    case "rejected-end":
      return parse(rejectedRaw);
    case "explore":
      return parse(exploreRaw);
    case "mcp":
      return parse(mcpRaw);
    case "long": {
      // The approved run forty times over, with fresh ids.
      const base = approved.filter((event) => !["turn_completed", "approval_requested", "approval_resolved"].includes(event.type));
      return Array.from({ length: 40 }, (_, round) =>
        base.map((event) => {
          const copy = JSON.parse(JSON.stringify(event)) as Record<string, unknown>;
          for (const key of ["id", "tool_call_id"]) if (typeof copy[key] === "string") copy[key] = `${copy[key]}-${round}`;
          if (Array.isArray(copy.tool_calls)) copy.tool_calls = (copy.tool_calls as { id: string }[]).map((call) => ({ ...call, id: `${call.id}-${round}` }));
          return copy as unknown as AgentEvent;
        }),
      ).flat();
    }
    case "markdown": {
      const message = (id: string, role: "user" | "assistant", content: string, reasoning: string | null = null): AgentEvent => ({
        type: "message", id, role, content, reasoning, tool_calls: [], tool_call_id: null, display: null, success: true, touched: [], exit_code: null, usage: null,
      });
      return [
        { type: "turn_started" },
        message("u1", "user", "Fix the average function and explain what you changed."),
        { type: "reasoning", delta: "The test expects 4 for [2, 4, 6]. The code divides by len + 1." },
        message("a1", "assistant", MARKDOWN_REPLY, "The test expects 4 for [2, 4, 6]. The code divides by len + 1."),
        { type: "turn_completed" },
      ];
    }
    default:
      return [];
  }
}

export interface Preview {
  agent: AgentState | null;
  projects: Project[];
  servers: McpServer[];
  setup: Setup;
  page: boolean;
  launcher: boolean;
}

export function preview(): Preview {
  const query = new URLSearchParams(location.search);
  const name = query.get("preview");
  let agent: AgentState | null = null;
  if (name) {
    const start = Date.now() - 60_000;
    agent = events(name).reduce((state, event, index) => apply(state, event, start + index * 400), newAgent(META));
    // Lets a check stream more into the long preview and time it.
    let seq = 100_000;
    (window as unknown as { __glassEmit: (event: AgentEvent) => void }).__glassEmit = (event) => emitForPreview({ agent_id: META.id, seq: seq++, event });
  }
  return {
    agent,
    projects: [PROJECT],
    servers: query.get("mcp")
      ? [
          { name: "fake", kind: "command", status: "connected", detail: null, tools: ["search", "add"] },
          { name: "linear", kind: "url", status: "needs sign-in", detail: "Glass cannot sign in yet.", tools: [] },
        ]
      : [],
    setup: { worker: "/Users/you/.local/share/uv/tools/mirror/bin/mirror-agent", version: "0.1.0", tested_version: "0.1.0", keys: ["OPENAI_API_KEY"], api: "openai-responses", model: "gpt-5-nano", base_url: null, mirror_command: "" },
    page: Boolean(query.get("new")) || !name,
    launcher: Boolean(query.get("launcher")),
  };
}
