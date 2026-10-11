import { useEffect, useState } from "react";
import { ctxPercent, relative, STATUS_DOT, STATUS_WORD, type AgentState } from "./agent";
import { inTauri, saveText, type CheckResult, type McpServer } from "./bridge";
import { toMarkdown } from "./exportMarkdown";
import { Changes } from "./Changes";
import type { ReviewComment } from "./review";

const compact = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 100_000 ? 0 : 1).replace(/\.0$/, "")}K` : String(n));

/** Where the model runs, in words. */
function runsOn(api: string, baseUrl: string | null): string {
  if (baseUrl) {
    try {
      return new URL(baseUrl).host;
    } catch {
      return baseUrl;
    }
  }
  return (
    { reflection: "Reflection API", "openai-responses": "OpenAI", "openai-chat-completions": "OpenRouter", "anthropic-messages": "Anthropic" }[api] ??
    api
  );
}

function Dots({ share }: { share: number }) {
  const total = 40;
  const on = Math.max(share > 0 ? 1 : 0, Math.round(share * total));
  return (
    <div className="meter" aria-hidden="true">
      {Array.from({ length: total }, (_, index) => (
        <span key={index} className="md" data-on={index < on ? "y" : "n"} />
      ))}
    </div>
  );
}

function Session({ agent, servers }: { agent: AgentState; servers: McpServer[] }) {
  const { meta, ctx, report } = agent;
  const share = ctx ? ctx.tokens / ctx.window : 0;
  const conversation = ctx && report ? Math.max(0, ctx.tokens - report.system - report.tools) : null;
  const words: Record<string, string> = { write: "written", read: "read" };
  return (
    <>
      <section className="kv-section">
        <span className="cap">Context</span>
        <div className="ctx-big">
          <span>{ctxPercent(ctx)}</span>
          {ctx && (
            <span className="mono faint">
              {compact(ctx.tokens)} of {compact(ctx.window)}
            </span>
          )}
        </div>
        <Dots share={share} />
        <div className="kv mono">
          <div>
            <span className="faint">system prompt</span>
            <span>{report ? report.system.toLocaleString() : "–"}</span>
          </div>
          <div>
            <span className="faint">tools</span>
            <span>{report ? report.tools.toLocaleString() : "–"}</span>
          </div>
          <div>
            <span className="faint">conversation</span>
            <span>{conversation != null ? compact(conversation) : "–"}</span>
          </div>
        </div>
      </section>
      <section className="kv-section">
        <span className="cap">Model</span>
        <div className="kv mono">
          <div>
            <span className="faint">model</span>
            <span>{meta.model}</span>
          </div>
          <div>
            <span className="faint">runs on</span>
            <span>{runsOn(meta.api, meta.baseUrl)}</span>
          </div>
          <div>
            <span className="faint">reasoning</span>
            <span>{meta.effort}</span>
          </div>
          <div>
            <span className="faint">speed</span>
            <span>{agent.streaming && agent.speed ? `${Math.round(agent.speed)} tok/s` : "idle"}</span>
          </div>
        </div>
      </section>
      {inTauri && (
        <div>
          <button
            type="button"
            className="btn ghost"
            style={{ fontWeight: 400 }}
            title="Save this conversation, its tool calls and diffs as a Markdown file"
            onClick={() => saveText(`${meta.title.replace(/[^\w -]+/g, "").trim().slice(0, 60) || "session"}.md`, toMarkdown(agent)).catch(() => {})}
          >
            export as Markdown
          </button>
        </div>
      )}
      {servers.length > 0 && (
        <section className="kv-section">
          <span className="cap">Connections</span>
          <div className="kv mono">
            {servers.map((server) => (
              <div key={server.name} data-state={server.status === "connected" ? "done" : server.status === "failed" ? "failed" : "attention"} title={server.detail ?? undefined}>
                <span className="conn-name">
                  <span className="sdot still" />
                  {server.name}
                </span>
                <span className="faint">{server.status === "connected" ? `${server.tools.length} tools · ${server.tools.slice(0, 4).join(", ")}` : server.status}</span>
              </div>
            ))}
          </div>
          <span className="mono faint">From ~/.mirror/mcp. New agents get these tools; Mirror asks before each call in manual mode.</span>
        </section>
      )}
      {Object.keys(agent.tasks).length > 0 && (
        <section className="kv-section">
          <span className="cap">Background tasks</span>
          <div className="kv mono">
            {Object.values(agent.tasks).map((task) => (
              <div key={task.id}>
                <span>
                  {task.tool} · {task.id}
                </span>
                <span className="faint">{task.status === "running" ? (task.display ?? "running") : task.status}</span>
              </div>
            ))}
          </div>
        </section>
      )}
      {agent.touched.length > 0 && (
        <section className="kv-section">
          <span className="cap">Files touched</span>
          <div className="kv mono">
            {agent.touched.map((touched) => (
              <div key={touched.path}>
                <span>{relative(touched.path, meta.workspace)}</span>
                <span className="faint">
                  {touched.kind
                    .split(" · ")
                    .map((kind) => words[kind] ?? kind)
                    .join(" · ")}
                </span>
              </div>
            ))}
          </div>
        </section>
      )}
    </>
  );
}

/** Totals for one race runner, from its turn summaries. */
export function runnerTotals(agent: AgentState) {
  let seconds = 0;
  let tokens = 0;
  let add = 0;
  let del = 0;
  const files = new Set<string>();
  for (const item of agent.items) {
    if (item.kind !== "summary") continue;
    seconds += item.seconds ?? 0;
    tokens += item.tokens;
    for (const file of item.files) {
      files.add(file.path);
      add += file.add;
      del += file.del;
    }
  }
  return { seconds, tokens, add, del, files: files.size };
}

/** The effort race: each runner's state, time, tokens, changes and check, side by side. */
function Race(props: { runners: AgentState[]; checks: Record<string, CheckResult | "running">; current: string; onSelect: (id: string) => void }) {
  const order = ["low", "medium", "high", "xhigh", "max"];
  const rows = [...props.runners]
    .sort((a, b) => order.indexOf(a.meta.effort) - order.indexOf(b.meta.effort))
    .map((runner) => ({ runner, totals: runnerTotals(runner), check: props.checks[runner.meta.id] }));
  const check = props.runners[0]?.meta.race?.check;
  const passed = rows.filter((row) => row.check && row.check !== "running" && row.check.exit_code === 0);
  // Fastest passing runner, then fewest tokens: the one to look at first.
  const best = [...passed].sort((a, b) => a.totals.seconds - b.totals.seconds || a.totals.tokens - b.totals.tokens)[0];
  return (
    <>
      <div className="panel-head">
        <span>Comparing efforts</span>
      </div>
      <span className="mono faint">{check ? `test command · ${check}` : "no test command"}</span>
      <div className="race">
        <div className="race-row race-head mono faint">
          <span>effort</span>
          <span>state</span>
          <span>time</span>
          <span>tokens</span>
          <span>changes</span>
          <span>test</span>
        </div>
        {rows.map(({ runner, totals, check: result }) => (
          <button
            key={runner.meta.id}
            type="button"
            className="race-row row mono"
            aria-current={runner.meta.id === props.current}
            data-best={best?.runner.meta.id === runner.meta.id}
            onClick={() => props.onSelect(runner.meta.id)}
          >
            <span>{runner.meta.effort}</span>
            <span data-state={STATUS_DOT[runner.status]} className="race-state">
              <span className="sdot still" />
              {STATUS_WORD[runner.status]}
            </span>
            <span>{totals.seconds ? `${totals.seconds}s` : "–"}</span>
            <span>{totals.tokens ? (totals.tokens >= 1000 ? `${(totals.tokens / 1000).toFixed(1)}K` : totals.tokens) : "–"}</span>
            <span title={totals.files ? `${totals.files} file${totals.files === 1 ? "" : "s"}` : undefined}>{totals.files ? `+${totals.add} -${totals.del}` : "–"}</span>
            <span className={result && result !== "running" && result.exit_code !== null ? (result.exit_code === 0 ? "pass" : "fail") : "faint"} title={result && result !== "running" ? result.tail : undefined}>
              {!check ? "–" : !result ? "waiting" : result === "running" ? "running" : result.exit_code === null ? "couldn't run" : result.exit_code === 0 ? `pass · ${result.seconds}s` : `fail · exit ${result.exit_code}`}
            </span>
          </button>
        ))}
      </div>
      {best && <span className="mono faint">{best.runner.meta.effort} passed fastest. Open it to review its diff, then commit or open a pull request from its branch.</span>}
      {!check && <span className="mono faint">Without a check command, compare the diffs yourself: each row opens that runner.</span>}
    </>
  );
}

const MIN = 320;
const DEFAULT = 400;

function loadNumber(key: string, fallback: number): number {
  try {
    const value = Number(localStorage.getItem(key));
    return value > 0 ? value : fallback;
  } catch {
    return fallback;
  }
}

function save(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Storage can be unavailable; the setting just will not persist.
  }
}

/**
 * The right column. Drag its left edge to resize; double-click the edge to reset.
 * "Review" widens it to most of the window for reading diffs; at that width the
 * diff can show side by side.
 */
export function Panel(props: {
  agent: AgentState;
  focusFile: { path: string; at: number } | null;
  servers: McpServer[];
  comments: ReviewComment[];
  onComments: (comments: ReviewComment[]) => void;
  onSendReview: () => void;
  /** Every runner of this agent's effort race, if it is in one. */
  race: AgentState[];
  checks: Record<string, CheckResult | "running">;
  onSelectAgent: (id: string) => void;
}) {
  const [tab, setTab] = useState<"changes" | "session" | "race">(() =>
    {
      const asked = import.meta.env.DEV ? new URLSearchParams(location.search).get("tab") : null;
      return asked === "session" || asked === "race" ? asked : "changes";
    },
  );
  const [width, setWidth] = useState(() => loadNumber("glass.panel", DEFAULT));
  const [review, setReview] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);

  // A click on an edit in the transcript opens that file here.
  useEffect(() => {
    if (!props.focusFile) return;
    setTab("changes");
    setSelected(props.focusFile.path);
  }, [props.focusFile]);

  const maxWidth = () => Math.max(MIN, window.innerWidth - 268 - 420);
  const shown = review ? maxWidth() : Math.min(width, maxWidth());
  const wide = shown >= 640;

  const startDrag = (event: React.PointerEvent) => {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = shown;
    setReview(false);
    const move = (moved: PointerEvent) => {
      const next = Math.min(maxWidth(), Math.max(MIN, startWidth + (startX - moved.clientX)));
      setWidth(next);
    };
    const up = (ended: PointerEvent) => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      save("glass.panel", String(Math.min(maxWidth(), Math.max(MIN, startWidth + (startX - ended.clientX)))));
      document.body.classList.remove("resizing");
    };
    document.body.classList.add("resizing");
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const nudge = (event: React.KeyboardEvent) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const next = Math.min(maxWidth(), Math.max(MIN, shown + (event.key === "ArrowLeft" ? 40 : -40)));
    setReview(false);
    setWidth(next);
    save("glass.panel", String(next));
  };

  return (
    <aside aria-label="Changes and session" className="panel" style={{ width: shown }}>
      <div
        className="splitter"
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize the changes panel"
        aria-valuenow={Math.round(shown)}
        tabIndex={0}
        onPointerDown={startDrag}
        onDoubleClick={() => {
          setReview(false);
          setWidth(DEFAULT);
          save("glass.panel", String(DEFAULT));
        }}
        onKeyDown={nudge}
      />
      <div className="panel-inner scroll">
        <div className="panel-tools">
          <div role="group" aria-label="Panel" className="segs wide">
            {(props.race.length ? (["changes", "session", "race"] as const) : (["changes", "session"] as const)).map((name) => (
              <button key={name} type="button" className="seg" aria-pressed={tab === name} onClick={() => setTab(name)}>
                <span className="segin mono">{name === "race" ? "compare" : name}</span>
              </button>
            ))}
          </div>
          {tab === "changes" && (
            <div className="panel-actions">
              <button type="button" className="btn ghost" style={{ fontWeight: 400 }} aria-pressed={review} onClick={() => setReview(!review)}>
                {review ? "close review" : "review"}
              </button>
            </div>
          )}
        </div>
        {tab === "changes" ? (
          <Changes
            agent={props.agent}
            selected={selected}
            onSelect={setSelected}
            wide={wide}
            comments={props.comments}
            onComments={props.onComments}
            onSendReview={props.onSendReview}
          />
        ) : tab === "race" && props.race.length ? (
          <Race runners={props.race} checks={props.checks} current={props.agent.meta.id} onSelect={props.onSelectAgent} />
        ) : (
          <Session agent={props.agent} servers={props.servers} />
        )}
      </div>
    </aside>
  );
}
