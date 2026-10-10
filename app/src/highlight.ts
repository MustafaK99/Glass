// Syntax colours and changed-word marks for diff lines.

import hljs from "highlight.js/lib/core";
import bash from "highlight.js/lib/languages/bash";
import css from "highlight.js/lib/languages/css";
import go from "highlight.js/lib/languages/go";
import java from "highlight.js/lib/languages/java";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import markdown from "highlight.js/lib/languages/markdown";
import python from "highlight.js/lib/languages/python";
import rust from "highlight.js/lib/languages/rust";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";
import ini from "highlight.js/lib/languages/ini";
import cpp from "highlight.js/lib/languages/cpp";
import ruby from "highlight.js/lib/languages/ruby";
import sql from "highlight.js/lib/languages/sql";

const LANGUAGES = { bash, css, go, java, javascript, json, markdown, python, rust, typescript, xml, yaml, ini, cpp, ruby, sql };
for (const [name, language] of Object.entries(LANGUAGES)) hljs.registerLanguage(name, language);

const BY_EXTENSION: Record<string, string> = {
  py: "python", rs: "rust", ts: "typescript", tsx: "typescript", js: "javascript", jsx: "javascript", mjs: "javascript",
  cjs: "javascript", json: "json", css: "css", html: "xml", xml: "xml", svg: "xml", md: "markdown", yml: "yaml",
  yaml: "yaml", toml: "ini", ini: "ini", sh: "bash", zsh: "bash", bash: "bash", go: "go", java: "java", kt: "java",
  c: "cpp", h: "cpp", cc: "cpp", cpp: "cpp", hpp: "cpp", rb: "ruby", sql: "sql",
};

export function languageFor(path: string): string | null {
  const extension = path.split(".").pop()?.toLowerCase() ?? "";
  return BY_EXTENSION[extension] ?? null;
}

const escape = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** A whole code block as HTML. Unknown languages are guessed, briefly. */
export function highlightBlock(code: string, language: string | null): string {
  try {
    if (language && hljs.getLanguage(language)) return hljs.highlight(code, { language, ignoreIllegals: true }).value;
    if (code.length < 20_000) return hljs.highlightAuto(code).value;
  } catch {
    // Fall through to plain text.
  }
  return escape(code);
}

/** One line as HTML. Lines are coloured on their own, so a multi-line string can be off. */
export function highlight(text: string, language: string | null): string {
  if (!language || !text) return escape(text);
  try {
    return hljs.highlight(text, { language, ignoreIllegals: true }).value;
  } catch {
    return escape(text);
  }
}

/**
 * Where two versions of a line differ: the common start and end are left alone,
 * the middle is marked. Snapped outward to word edges so marks cover whole words.
 */
export function changedSpan(before: string, after: string): { start: number; endBefore: number; endAfter: number } | null {
  if (before === after) return null;
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) start++;
  let tail = 0;
  while (
    tail < before.length - start &&
    tail < after.length - start &&
    before[before.length - 1 - tail] === after[after.length - 1 - tail]
  ) tail++;
  const word = /\w/;
  while (start > 0 && word.test(before[start - 1]) && word.test(after[start - 1] ?? "")) start--;
  let endBefore = before.length - tail;
  let endAfter = after.length - tail;
  while (endBefore < before.length && endAfter < after.length && word.test(before[endBefore]) && before[endBefore] === after[endAfter]) {
    endBefore++;
    endAfter++;
  }
  // A line that changed almost everywhere reads better without a mark.
  if (endBefore - start > before.length * 0.8 && endAfter - start > after.length * 0.8) return null;
  return { start, endBefore, endAfter };
}

/** A line as HTML, with `[from, to)` wrapped in a change mark. */
export function highlightWithMark(text: string, language: string | null, from: number, to: number): string {
  if (from >= to) return highlight(text, language);
  return (
    highlight(text.slice(0, from), language) +
    `<mark class="word">${highlight(text.slice(from, to), language)}</mark>` +
    highlight(text.slice(to), language)
  );
}
