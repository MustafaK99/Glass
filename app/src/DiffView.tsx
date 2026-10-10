import { parseDiff, splitRows, type Row } from "./diff";

const num = (value: number | null) => (value == null ? "" : String(value));

function UnifiedRow({ row, numbers }: { row: Row; numbers: boolean }) {
  if (row.kind === "hunk") {
    return (
      <div className="drow hunk">
        {numbers && <span className="ln" />}
        {numbers && <span className="ln" />}
        <span className="code">{row.text}</span>
      </div>
    );
  }
  const sign = row.kind === "add" ? "+" : row.kind === "del" ? "-" : " ";
  return (
    <div className={`drow ${row.kind}`}>
      {numbers && <span className="ln">{num(row.old)}</span>}
      {numbers && <span className="ln">{num(row.new)}</span>}
      <span className="sign">{sign}</span>
      <span className="code">{row.text}</span>
    </div>
  );
}

function Half({ row, side }: { row: Row | null; side: "left" | "right" }) {
  if (!row) return <div className="half empty" />;
  const tone = row.kind === "ctx" ? "ctx" : row.kind;
  return (
    <div className={`half ${tone}`}>
      <span className="ln">{num(side === "left" ? row.old : row.new)}</span>
      <span className="code">{row.text}</span>
    </div>
  );
}

/**
 * A unified diff as the worker sent it, with line numbers.
 * `split` shows removals and additions side by side, for wide panels.
 */
export function DiffView(props: { diff: string; split?: boolean; numbers?: boolean; hideHunks?: boolean }) {
  const numbers = props.numbers ?? true;
  const rows = parseDiff(props.diff).filter((row) => !(props.hideHunks && row.kind === "hunk"));
  if (props.split) {
    return (
      <div className="diffview split mono">
        {splitRows(rows).map((row, index) =>
          row.kind === "hunk" ? (
            <div key={index} className="srow hunk">
              <span className="code">{row.text}</span>
            </div>
          ) : (
            <div key={index} className="srow">
              <Half row={row.left} side="left" />
              <Half row={row.right} side="right" />
            </div>
          ),
        )}
      </div>
    );
  }
  return (
    <div className="diffview mono">
      {rows.map((row, index) => (
        <UnifiedRow key={index} row={row} numbers={numbers} />
      ))}
    </div>
  );
}
