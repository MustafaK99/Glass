import { useEffect, useState } from "react";
import { ctxPercent, relative, type AgentState } from "./agent";
import { Changes } from "./Changes";

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

function Session({ agent }: { agent: AgentState }) {
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
export function Panel(props: { agent: AgentState; focusFile: { path: string; at: number } | null }) {
  const [tab, setTab] = useState<"changes" | "session">(() =>
    new URLSearchParams(location.search).get("tab") === "session" ? "session" : "changes",
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
            {(["changes", "session"] as const).map((name) => (
              <button key={name} type="button" className="seg" aria-pressed={tab === name} onClick={() => setTab(name)}>
                <span className="segin mono">{name}</span>
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
          <Changes agent={props.agent} selected={selected} onSelect={setSelected} wide={wide} />
        ) : (
          <Session agent={props.agent} />
        )}
      </div>
    </aside>
  );
}
