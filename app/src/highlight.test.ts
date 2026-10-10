import { describe, expect, it } from "vitest";
import { changedSpan, highlight, highlightWithMark, languageFor } from "./highlight";

describe("changed words", () => {
  it("marks only the part of the line that changed, on word edges", () => {
    const before = "    return sum(nums) / (len(nums) + 1)";
    const after = "    return sum(nums) / len(nums)";
    const span = changedSpan(before, after)!;
    expect(before.slice(span.start, span.endBefore)).toBe("(len(nums) + 1");
    expect(after.slice(span.start, span.endAfter)).toBe("len(nums");
  });

  it("does not mark identical lines or lines that changed almost everywhere", () => {
    expect(changedSpan("same", "same")).toBeNull();
    expect(changedSpan("abcdef", "uvwxyz")).toBeNull();
  });
});

describe("syntax colours", () => {
  it("picks a language from the extension", () => {
    expect(languageFor("src/stats.py")).toBe("python");
    expect(languageFor("Cargo.toml")).toBe("ini");
    expect(languageFor("README")).toBeNull();
  });

  it("escapes text it cannot colour, and keeps marks around coloured text", () => {
    expect(highlight("<b>", null)).toBe("&lt;b&gt;");
    expect(highlight("def f():", "python")).toContain('class="hljs-keyword"');
    expect(highlightWithMark("x = 1", null, 4, 5)).toBe('x = <mark class="word">1</mark>');
  });
});
