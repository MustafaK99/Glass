import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { apply, applyEnvelope, changes, newAgent, type AgentMeta, type AgentState, type ToolItem } from "./agent";
import type { AgentEvent } from "./events";
import { parseDiff, previewEdit, splitRows } from "./diff";

const meta: AgentMeta = {
  id: "test",
  title: "Fix the failing average test",
  project: "stats-demo",
  projectPath: "/workspace/stats-demo",
  branch: "main",
  workspace: "/workspace/stats-demo",
  model: "fake",
  api: "openai-chat-completions",
  baseUrl: null,
  effort: "high",
  mode: "manual",
  live: false,
  source: "test",
};

function fold(name: string): AgentState {
  const lines = readFileSync(new URL(`../../fixtures/${name}`, import.meta.url), "utf8").split("\n").filter(Boolean);
  return lines.map((line) => JSON.parse(line) as AgentEvent).reduce(apply, newAgent(meta));
}

const tools = (state: AgentState) => state.items.filter((item): item is ToolItem => item.kind === "tool");

describe("approved recording", () => {
  const state = fold("fix-failing-test.approved.jsonl");

  it("ends done with nothing pending", () => {
    expect(state.status).toBe("done");
    expect(state.pending).toEqual([]);
    expect(state.items.some((item) => item.kind === "draft")).toBe(false);
  });

  it("runs the tests, reads, edits, and runs the tests again", () => {
    expect(tools(state).map((item) => [item.name, item.approval])).toEqual([
      ["bash", "approved"],
      ["read", null],
      ["edit", "approved"],
      ["bash", "approved"],
    ]);
    const [first, , , last] = tools(state);
    expect(first.result?.exitCode).toBe(1);
    expect(last.result?.exitCode).toBe(0);
  });

  it("shows one changed file with the worker's diff", () => {
    const files = changes(state);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatchObject({ path: "/workspace/stats-demo/stats.py", add: 1, del: 1, proposed: false });
    expect(files[0].diffs[0].diff).toContain("+    return sum(nums) / len(nums)");
  });

  it("keeps the user message, reasoning and closing text", () => {
    expect(state.items[0]).toMatchObject({ kind: "user" });
    expect(state.items.some((item) => item.kind === "reasoning")).toBe(true);
    const texts = state.items.filter((item) => item.kind === "text").map((item) => (item as { text: string }).text);
    // Streamed once, confirmed by the finished record, never shown twice.
    expect(texts).toEqual(["The average function divides by len(nums) + 1. It should divide by len(nums).", "Fixed. The test passes."]);
    expect(state.items.filter((item) => item.kind === "reasoning")).toHaveLength(1);
  });
});

describe("rejected recording", () => {
  const state = fold("fix-failing-test.rejected.jsonl");

  it("ends with every request rejected and no changes", () => {
    expect(state.status).toBe("done");
    expect(tools(state).filter((item) => item.approval).map((item) => item.approval)).toEqual(["rejected", "rejected", "rejected"]);
    expect(changes(state)).toEqual([]);
  });
});

describe("mid-run states", () => {
  const lines = readFileSync(new URL("../../fixtures/fix-failing-test.approved.jsonl", import.meta.url), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as AgentEvent);

  it("needs you while the edit waits, with a whole-line preview from the read", () => {
    const at = lines.findIndex((event) => event.type === "approval_requested" && event.call_id === "call_3_0");
    const state = lines.slice(0, at + 1).reduce(apply, newAgent(meta));
    expect(state.status).toBe("attention");
    expect(state.pending).toEqual(["call_3_0"]);
    const [file] = changes(state);
    expect(file.proposed).toBe(true);
    expect(parseDiff(file.diffs[0].diff).map((row) => [row.kind, row.old, row.new, row.text])).toEqual([
      ["hunk", null, null, "@@ -1,2 +1,2 @@"],
      ["ctx", 1, 1, "def average(nums):"],
      ["del", 2, null, "    return sum(nums) / (len(nums) + 1)"],
      ["add", null, 2, "    return sum(nums) / len(nums)"],
    ]);
  });

  it("an unrequested interrupt is a failure that keeps the stderr lines", () => {
    let state = lines.slice(0, 8).reduce(apply, newAgent(meta));
    state = apply(state, { type: "log", level: "stderr", text: "model metadata connection unavailable" });
    state = apply(state, { type: "turn_interrupted" });
    expect(state.status).toBe("failed");
    expect(state.items.at(-1)).toMatchObject({ kind: "notice", tone: "fail", lines: ["model metadata connection unavailable"] });
  });

  it("a requested interrupt is a stop", () => {
    const state = apply({ ...lines.slice(0, 8).reduce(apply, newAgent(meta)), stopRequested: true }, { type: "turn_interrupted" });
    expect(state.status).toBe("stopped");
  });

  it("a worker that dies leaves the transcript and fails the agent", () => {
    const before = lines.slice(0, 20).reduce(apply, newAgent(meta));
    const state = apply(before, { type: "closed", error: "mirror-agent exited" });
    expect(state.status).toBe("failed");
    expect(state.closedError).toBe("mirror-agent exited");
    expect(state.items.length).toBe(before.items.length);
  });

  it("notices a gap in the sequence", () => {
    let state = applyEnvelope(newAgent(meta), 0, lines[0]);
    state = applyEnvelope(state, 3, lines[1]);
    expect(state.items.at(-1)).toMatchObject({ kind: "notice", text: "2 events were lost here" });
  });
});

describe("diffs", () => {
  it("previews an edit in the middle of a file with context", () => {
    const file = "a\nb\nc\nd\ne\nf\ng\n";
    expect(previewEdit(file, "d", "D", 1)).toBe("@@ -3,3 +3,3 @@\n c\n-d\n+D\n e");
  });

  it("falls back to the bare strings when the text is not in the file", () => {
    expect(previewEdit("x\n", "nope", "yes")).toBe("-nope\n+yes");
  });

  it("pairs removals and additions side by side", () => {
    const rows = splitRows(parseDiff("@@ -1,2 +1,2 @@\n a\n-b\n+B\n+C"));
    expect(rows.map((row) => [row.left?.text ?? null, row.right?.text ?? null])).toEqual([
      [null, null],
      ["a", "a"],
      ["b", "B"],
      [null, "C"],
    ]);
  });
});

describe("explore recording: read-only tools and a subagent", () => {
  const state = fold("explore.jsonl");
  it("keeps what each read-only tool found", () => {
    const byName = Object.fromEntries(tools(state).map((item) => [item.name, item.result?.content ?? ""]));
    expect(byName.ls).toContain("stats.py");
    expect(byName.glob).toBe("stats.py\ntest_stats.py");
    expect(byName.grep).toMatch(/^Found 2 lines/);
    expect(byName.read).toContain("class TestAverage");
  });
  it("tracks the subagent as a running background task", () => {
    expect(state.tasks["1000"]).toMatchObject({ tool: "subagent", status: "running", display: "Thinking…" });
    expect(state.status).toBe("done");
  });
});
