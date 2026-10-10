// Unified diffs: parsing for display, and a preview for edits not yet run.

export interface Row {
  kind: "hunk" | "ctx" | "add" | "del";
  text: string;
  old: number | null;
  new: number | null;
}

/** Rows with line numbers, from a unified diff. File headers are dropped. */
export function parseDiff(diff: string): Row[] {
  const rows: Row[] = [];
  let oldLine = 0;
  let newLine = 0;
  // A bare fragment has no hunk header, so its lines have no numbers.
  let numbered = false;
  const n = (value: number) => (numbered ? value : null);
  for (const line of diff.replace(/\n$/, "").split("\n")) {
    if (line.startsWith("---") || line.startsWith("+++")) continue;
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/.exec(line);
    if (hunk) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      numbered = true;
      rows.push({ kind: "hunk", text: line, old: null, new: null });
    } else if (line.startsWith("+")) {
      rows.push({ kind: "add", text: line.slice(1), old: null, new: n(newLine++) });
    } else if (line.startsWith("-")) {
      rows.push({ kind: "del", text: line.slice(1), old: n(oldLine++), new: null });
    } else if (line.startsWith("\\")) {
      continue; // "\ No newline at end of file"
    } else {
      rows.push({ kind: "ctx", text: line.slice(1), old: n(oldLine++), new: n(newLine++) });
    }
  }
  return rows;
}

export interface SplitRow {
  kind: "hunk" | "pair";
  text?: string;
  left: Row | null;
  right: Row | null;
}

/** Side-by-side rows: context on both sides, removals left, additions right. */
export function splitRows(rows: Row[]): SplitRow[] {
  const out: SplitRow[] = [];
  let dels: Row[] = [];
  let adds: Row[] = [];
  const flush = () => {
    for (let i = 0; i < Math.max(dels.length, adds.length); i++) {
      out.push({ kind: "pair", left: dels[i] ?? null, right: adds[i] ?? null });
    }
    dels = [];
    adds = [];
  };
  for (const row of rows) {
    if (row.kind === "del") dels.push(row);
    else if (row.kind === "add") adds.push(row);
    else {
      flush();
      if (row.kind === "hunk") out.push({ kind: "hunk", text: row.text, left: null, right: null });
      else out.push({ kind: "pair", left: row, right: row });
    }
  }
  flush();
  return out;
}

export function diffStat(diff: string): { add: number; del: number } {
  let add = 0;
  let del = 0;
  for (const row of parseDiff(diff)) {
    if (row.kind === "add") add++;
    else if (row.kind === "del") del++;
  }
  return { add, del };
}

/**
 * What an edit would change, before the worker runs it.
 *
 * The worker sends its own diff only after an edit is approved. Until then this
 * builds one from the file as the agent last read it, so the person reviews whole
 * lines. If the text is not found there, it falls back to the bare strings.
 */
export function previewEdit(file: string | null, oldText: string, newText: string, context = 3): string {
  const at = file ? file.indexOf(oldText) : -1;
  if (!file || at === -1 || !oldText) {
    const before = oldText ? oldText.split("\n").map((line) => `-${line}`) : [];
    const after = newText.split("\n").map((line) => `+${line}`);
    return [...before, ...after].join("\n");
  }
  const lines = file.replace(/\n$/, "").split("\n");
  const firstLine = file.slice(0, at).split("\n").length - 1;
  const lastLine = file.slice(0, at + oldText.length).split("\n").length - 1;
  const lineStart = file.lastIndexOf("\n", at - 1) + 1;
  const prefix = file.slice(lineStart, at);
  const endBreak = file.indexOf("\n", at + oldText.length);
  const suffix = file.slice(at + oldText.length, endBreak === -1 ? undefined : endBreak);
  const removed = lines.slice(firstLine, lastLine + 1);
  const added = (prefix + newText + suffix).split("\n");
  const from = Math.max(0, firstLine - context);
  const to = Math.min(lines.length, lastLine + 1 + context);
  const before = lines.slice(from, firstLine);
  const after = lines.slice(lastLine + 1, to);
  const header = `@@ -${from + 1},${before.length + removed.length + after.length} +${from + 1},${before.length + added.length + after.length} @@`;
  return [
    header,
    ...before.map((line) => ` ${line}`),
    ...removed.map((line) => `-${line}`),
    ...added.map((line) => `+${line}`),
    ...after.map((line) => ` ${line}`),
  ].join("\n");
}

/** A new file as an all-added diff. */
export function previewWrite(content: string): string {
  const lines = content.replace(/\n$/, "").split("\n");
  return [`@@ -0,0 +1,${lines.length} @@`, ...lines.map((line) => `+${line}`)].join("\n");
}
