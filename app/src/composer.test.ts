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
