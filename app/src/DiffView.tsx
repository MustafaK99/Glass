import { Fragment, useMemo, type ReactNode } from "react";
import { parseDiff, splitRows, type Row } from "./diff";
import { changedSpan, highlight, highlightWithMark, languageFor } from "./highlight";

const num = (value: number | null) => (value == null ? "" : String(value));

/** HTML for each row: syntax colours, and the changed words marked on paired lines. */
function render(rows: Row[], language: string | null): string[] {
  const html = rows.map((row) => (row.kind === "hunk" ? "" : highlight(row.text, language)));
  // Pair the removals and additions in each change block, line by line.
  let index = 0;
  while (index < rows.length) {
    if (rows[index].kind !== "del" && rows[index].kind !== "add") {
      index++;
      continue;
    }
    const dels: number[] = [];
    const adds: number[] = [];
    while (index < rows.length && (rows[index].kind === "del" || rows[index].kind === "add")) {
      (rows[index].kind === "del" ? dels : adds).push(index);
      index++;
    }
    for (let pair = 0; pair < Math.min(dels.length, adds.length); pair++) {
      const before = rows[dels[pair]].text;
      const after = rows[adds[pair]].text;
      const span = changedSpan(before, after);
      if (!span) continue;
      html[dels[pair]] = highlightWithMark(before, language, span.start, span.endBefore);
      html[adds[pair]] = highlightWithMark(after, language, span.start, span.endAfter);
    }
  }
  return html;
}

/**
 * A unified diff with line numbers, syntax colours and changed words marked.
 * `split` shows removals and additions side by side; `wrap` wraps long lines.
 */
export function DiffView(props: {
  diff: string;
  path?: string;
  split?: boolean;
  wrap?: boolean;
  numbers?: boolean;
  hideHunks?: boolean;
  /** Unified view only: clicking a line, for comments. */
  onLine?: (row: Row) => void;
  /** Shown under a line: its comments, or the comment being written. */
  after?: (row: Row) => ReactNode;
}) {
  const numbers = props.numbers ?? true;
  const language = props.path ? languageFor(props.path) : null;
  const rows = useMemo(
    () => parseDiff(props.diff).filter((row) => !(props.hideHunks && row.kind === "hunk")),
    [props.diff, props.hideHunks],
  );
  const html = useMemo(() => render(rows, language), [rows, language]);
  const htmlFor = new Map(rows.map((row, index) => [row, html[index]]));
  const className = `diffview mono hl${props.wrap ? " wrap" : ""}`;

  if (props.split) {
    return (
      <div className={`${className} split`}>
        {splitRows(rows).map((row, index) =>
          row.kind === "hunk" ? (
            <div key={index} className="srow hunk">
              <span className="code">{row.text}</span>
            </div>
          ) : (
            <div key={index} className="srow">
              {[row.left, row.right].map((half, side) =>
                half ? (
                  <div key={side} className={`half ${half.kind}`}>
                    <span className="ln">{num(side === 0 ? half.old : half.new)}</span>
                    <span className="code" dangerouslySetInnerHTML={{ __html: htmlFor.get(half) ?? "" }} />
                  </div>
                ) : (
                  <div key={side} className="half empty" />
                ),
              )}
            </div>
          ),
        )}
      </div>
    );
  }

  return (
    <div className={className}>
      {rows.map((row, index) => {
        if (row.kind === "hunk") {
          return (
            <div key={index} className="drow hunk">
              {numbers && <span className="ln" />}
              {numbers && <span className="ln" />}
              <span className="code">{row.text}</span>
            </div>
          );
        }
        const sign = row.kind === "add" ? "+" : row.kind === "del" ? "-" : " ";
        const below = props.after?.(row);
        return (
          <Fragment key={index}>
          <div
            className={`drow ${row.kind}${props.onLine ? " commentable" : ""}`}
            onClick={props.onLine ? () => props.onLine?.(row) : undefined}
            title={props.onLine ? "Comment on this line" : undefined}
          >
            {numbers && <span className="ln">{num(row.old)}</span>}
            {numbers && <span className="ln">{num(row.new)}</span>}
            <span className="sign">{sign}</span>
            {/* highlight.js escapes the text; only its own spans and our mark are HTML. */}
            <span className="code" dangerouslySetInnerHTML={{ __html: html[index] }} />
          </div>
          {below}
          </Fragment>
        );
      })}
    </div>
  );
}
