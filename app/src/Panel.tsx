import { useState } from "react";
import { diffStat, relative, type AgentState, type Item } from "./agent";
import { Diff, proposedDiff, toolSummary } from "./Transcript";

type ToolItem = Extract<Item, { kind: "tool" }>;

const compact = (n: number) => (n >= 1000 ? `${Math.round(n / 1000)}K` : String(n));

function Changes({ agent }: { agent: AgentState }) {
  const edits = agent.items.filter(
    (item): item is ToolItem => item.kind === "tool" && (item.name === "edit" || item.name === "write"),
  );
  const proposed = edits.filter((item) => item.approval === "pending");
  const applied = edits.filter((item) => item.approval !== "rejected" && item.approval !== "pending" && item.result?.success);
  const rejected = edits.filter((item) => item.approval === "rejected");

  let title = "No changes";
  let note = "";
  if (proposed.length) {
    title = `${proposed.length} edit${proposed.length > 1 ? "s" : ""} proposed`;
    note = "waiting on you";
  } else if (applied.length) {
    title = `${applied.length} file${applied.length > 1 ? "s" : ""} changed`;
  } else if (rejected.length) {
    note = `${rejected.length} rejected`;
  }

  const workspace = agent.meta.workspace;
  const shown = [...proposed, ...applied];
  return (
    <>
      <div className="panel-head">
        <span>{title}</span>
        <span className="mono faint">{note}</span>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        {shown.map((item) => {
          const diff = item.result?.display ?? (item.name === "edit" ? proposedDiff(item) : "");
          const { add, del } = diffStat(diff);
          return (
            <div key={item.id} className="block">
              <div className="block-head mono">
                <span>{toolSummary(item, workspace)}</span>
                <span className="faint">
                  +{add} -{del}
                </span>
              </div>
              {diff && (
                <div style={{ borderTop: "1px solid var(--line)" }}>
                  <Diff text={diff} />
                </div>
              )}
            </div>
          );
        })}
        {!shown.length && (
          <span className="muted">
            {rejected.length ? "Every proposed change was rejected. The workspace is unchanged." : "Edits the agent makes show here."}
          </span>
        )}
      </div>
      {agent.touched.length > 0 && (
        <div className="files">
          <span className="cap">Files touched</span>
          {agent.touched.map((touched) => (
            <div key={touched.path} className="mono">
              <span>{relative(touched.path, workspace)}</span>
              <span className="faint">{touched.kind}</span>
            </div>
          ))}
        </div>
      )}
    </>
  );
}

function Session({ agent }: { agent: AgentState }) {
  const { meta, ctx } = agent;
  const rows: [string, string][] = [
    ["model", meta.model],
    ["api", meta.api],
    ["reasoning", meta.effort],
    ["mode", meta.mode],
    ["ctx", ctx ? `${compact(ctx.tokens)} of ${compact(ctx.window)} · ${Math.round((ctx.tokens / ctx.window) * 100)}%` : "–"],
    ["speed", agent.speed ? `${Math.round(agent.speed)} tok/s` : "–"],
    ["tools", agent.tools.length ? agent.tools.join(" · ") : "–"],
    ["workspace", meta.workspace],
    ["source", meta.source],
  ];
  return (
    <>
      <div className="panel-head">
        <span>Session</span>
        <span className="mono faint">{meta.branch}</span>
      </div>
      <div className="kv mono">
        {rows.map(([key, value]) => (
          <div key={key}>
            <span className="faint">{key}</span>
            <span>{value}</span>
          </div>
        ))}
      </div>
    </>
  );
}

export function Panel({ agent }: { agent: AgentState }) {
  const [tab, setTab] = useState<"changes" | "session">("changes");
  return (
    <aside aria-label="Changes and session" className="panel scroll">
      <div role="group" aria-label="Panel" className="segs wide">
        {(["changes", "session"] as const).map((name) => (
          <button key={name} type="button" className="seg" aria-pressed={tab === name} onClick={() => setTab(name)}>
            <span className="segin mono">{name}</span>
          </button>
        ))}
      </div>
      {tab === "changes" ? <Changes agent={agent} /> : <Session agent={agent} />}
    </aside>
  );
}
