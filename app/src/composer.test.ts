import { describe, expect, it } from "vitest";
import { rankFiles } from "./Composer";

describe("@ file mentions", () => {
  const files = ["README.md", "src/stats.py", "tests/test_stats.py", "docs/statistics.md", "src/util.py"];
  it("ranks names that start with the query first, then names, then paths", () => {
    expect(rankFiles(files, "stat")).toEqual(["src/stats.py", "docs/statistics.md", "tests/test_stats.py"]);
    expect(rankFiles(files, "src/")).toEqual(["src/util.py", "src/stats.py"]);
  });
  it("lists the first files when nothing is typed yet", () => {
    expect(rankFiles(files, "")).toHaveLength(5);
  });
});

import { stepEffort } from "./Controls";
describe("reasoning shortcuts", () => {
  it("steps one level and stops at the ends", () => {
    expect(stepEffort("high", 1)).toBe("xhigh");
    expect(stepEffort("high", -1)).toBe("medium");
    expect(stepEffort("max", 1)).toBe("max");
    expect(stepEffort("low", -1)).toBe("low");
  });
});

import { mcpParts, toolLabel } from "./Transcript";
describe("MCP tool names", () => {
  it("splits Mirror's mcp__server__tool names", () => {
    expect(mcpParts("mcp__linear__create_issue")).toEqual({ server: "linear", tool: "create_issue" });
    expect(toolLabel("mcp__fake__search")).toBe("fake · search");
    expect(toolLabel("bash")).toBe("bash");
  });
});

import { ago } from "./agent";
describe("sidebar times", () => {
  it("rounds to now, minutes, hours and days", () => {
    const now = 10_000_000;
    expect(ago(now - 10_000, now)).toBe("now");
    expect(ago(now - 4 * 60_000, now)).toBe("4m");
    expect(ago(now - 2 * 3_600_000, now)).toBe("2h");
    expect(ago(now - 3 * 86_400_000, now)).toBe("3d");
  });
});

import { readFileSync } from "node:fs";
import { apply, newAgent } from "./agent";
import type { AgentEvent } from "./events";
import { toMarkdown } from "./exportMarkdown";
describe("export as Markdown", () => {
  it("writes the conversation, tool calls, diffs and the summary", () => {
    const events = readFileSync(new URL("../../fixtures/fix-failing-test.approved.jsonl", import.meta.url), "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as AgentEvent);
    const agent = events.reduce((state, event) => apply(state, event), newAgent({ id: "x", title: "Fix the test", project: "stats-demo", projectPath: "/w", branch: "main", workspace: "/workspace/stats-demo", model: "fake", api: "openai", baseUrl: null, effort: "high", mode: "manual", live: true, source: "" }));
    const text = toMarkdown(agent);
    expect(text).toContain("# Fix the test");
    expect(text).toContain("**bash** · `python3 -m unittest` · exit 1");
    expect(text).toContain("```diff");
    expect(text).toContain("stats.py +1 -1");
  });
});

import { reviewMessage } from "./review";
describe("review comments", () => {
  it("quotes each line with its file and number, in file order", () => {
    const text = reviewMessage([
      { id: "2", path: "stats.py", line: 2, side: "new", code: "    return sum(nums) / len(nums)", body: "Guard the empty list." },
      { id: "1", path: "app.py", line: 9, side: "old", code: "x = 1", body: "Why remove this?" },
    ]);
    expect(text).toBe(
      "Review comments on your changes. Please address each one.\n\napp.py, line 9 (a removed line):\n> x = 1\nWhy remove this?\n\nstats.py, line 2:\n> return sum(nums) / len(nums)\nGuard the empty list.",
    );
  });
});
