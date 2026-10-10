import { useCallback, useEffect, useRef, useState } from "react";
import { apply, newAgent, STATUS_WORD, type AgentMeta, type AgentState, type Item } from "./agent";
import { startReplay, type AgentHandle } from "./bridge";
import { Panel } from "./Panel";
import { Pill, toolSummary, Transcript } from "./Transcript";

type ToolItem = Extract<Item, { kind: "tool" }>;

// The recorded run in fixtures/: the scripted model in dev/, against the real worker.
const REPLAY_META: Omit<AgentMeta, "id"> = {
  title: "Fix the failing average test",
  project: "stats-demo",
  branch: "main",
  workspace: "/workspace/stats-demo",
  model: "fake",
  api: "openai-chat-completions",
  effort: "high",
  mode: "manual",
  source: "replay · fix-failing-test",
};

const EFFORTS = ["low", "medium", "high", "xhigh", "max"];

function loadTheme(): "cream" | "dark" {
  try {
    return localStorage.getItem("glass.theme") === "dark" ? "dark" : "cream";
  } catch {
    return "cream";
  }
}

export function App() {
  const [theme, setTheme] = useState<"cream" | "dark">(loadTheme);
  const [agent, setAgent] = useState<AgentState | null>(null);
  const handle = useRef<AgentHandle | null>(null);
  // A replay can only follow one recording. The first answer picks it.
  const [branch, setBranch] = useState<boolean | null>(null);
  // Bumped on every start, so events from an older replay are dropped.
  const generation = useRef(0);

  const start = useCallback(async () => {
    const mine = ++generation.current;
    const previous = handle.current;
    handle.current = null;
    await previous?.stop();
    setBranch(null);
    setAgent(newAgent({ id: `pending-${mine}`, ...REPLAY_META }));
    const session = await startReplay("fix-failing-test", (event) => {
      if (generation.current !== mine) return;
      setAgent((current) => (current ? apply(current, event) : current));
    });
    if (generation.current !== mine) {
      await session.stop();
      return;
    }
    handle.current = session;
    setAgent((current) => (current ? { ...current, meta: { ...current.meta, id: session.id } } : current));
  }, []);

  useEffect(() => {
    start();
    return () => {
      generation.current++;
      handle.current?.stop();
      handle.current = null;
    };
  }, [start]);

  useEffect(() => {
    try {
      localStorage.setItem("glass.theme", theme);
    } catch {
      // Storage can be unavailable; the theme just will not persist.
    }
  }, [theme]);

  const resolve = useCallback(
    (callId: string, approved: boolean) => {
      if (branch !== null && approved !== branch) return;
      if (branch === null) setBranch(approved);
      handle.current?.resolve(callId, approved);
    },
    [branch],
  );

  const stop = useCallback(async () => {
    setAgent((current) => (current ? { ...current, stopRequested: true } : current));
    await handle.current?.stop();
    // A replay has no worker to confirm the interrupt, so record it here.
    setAgent((current) => (current ? apply(current, { type: "turn_interrupted" }) : current));
  }, []);

  // A and R answer the oldest request, unless the user is typing.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === "TEXTAREA" || target.tagName === "INPUT")) return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const first = agent?.pending[0];
      if (!first) return;
      if (event.key === "a" || event.key === "A") resolve(first, true);
      if (event.key === "r" || event.key === "R") resolve(first, false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [agent, resolve]);

  const busy = agent?.status === "running" || agent?.status === "attention";
  const pendingItems = agent
    ? agent.pending
        .map((id) => agent.items.find((item): item is ToolItem => item.kind === "tool" && item.id === id))
        .filter((item): item is ToolItem => Boolean(item))
    : [];

  return (
    <div className="app" data-theme={theme}>
      <header className="topbar">
        <div className="brand">
          <b>Glass</b>
          <span className="muted">for Mirror</span>
        </div>
        <span className="tag">unofficial</span>
        <span className="grow" />
        <button type="button" className="btn ghost" onClick={start}>
          Replay recording
        </button>
        <span data-state="stopped" className="mono faint still" style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span className="sdot" />
          replay · no worker
        </span>
        <button
          type="button"
          className="icon-btn ghost"
          aria-label="Switch theme"
          onClick={() => setTheme(theme === "dark" ? "cream" : "dark")}
        >
          <svg className="i" viewBox="0 0 16 16" aria-hidden="true">
            <circle cx="8" cy="8" r="5.5" />
            <path d="M8 2.5v11" className="dash" />
            <path d="M8 2.5a5.5 5.5 0 0 1 0 11" />
          </svg>
        </button>
      </header>

      {agent && (
        <div className="cols">
          <nav aria-label="Agents" className="sidebar scroll">
            <section className="group" style={{ gap: 6 }}>
              <div className="inbox-head">
                <span className="cap">Needs you · {pendingItems.length}</span>
                <span style={{ display: "flex", gap: 4 }}>
                  <span className="kbd">A</span>
                  <span className="kbd">R</span>
                </span>
              </div>
              {pendingItems.map((item) => (
                <div key={item.id} className="agent-row row" data-state="attention">
                  <span className="sdot" style={{ marginTop: 6 }} />
                  <span className="lines">
                    <span className="mono" style={{ fontSize: 13 }}>
                      {item.name} {toolSummary(item, agent.meta.workspace)}
                    </span>
                    <span className="mono faint">
                      {agent.meta.project} · {agent.meta.branch}
                    </span>
                  </span>
                </div>
              ))}
              {!pendingItems.length && <span className="mono faint empty">nothing waiting</span>}
            </section>

            <section className="group">
              <div className="group-head">
                <b>{agent.meta.project}</b>
                <span className="mono faint">1 agent</span>
              </div>
              <button type="button" className="agent-row row" data-state={agent.status} aria-current="true">
                <span className="sdot" />
                <span className="lines">
                  <span className="title">{agent.meta.title}</span>
                  <span className="mono faint">
                    {agent.meta.branch} · {agent.meta.effort} · {STATUS_WORD[agent.status]}
                  </span>
                </span>
              </button>
            </section>
          </nav>

          <main className="main">
            <div className="main-head">
              <h1>{agent.meta.title}</h1>
              <span className="mono faint">
                {agent.meta.project} · git {agent.meta.branch} · {agent.meta.model}
              </span>
            </div>

            <Transcript agent={agent} onResolve={resolve} lockedTo={branch} />

            <div className="composer-wrap">
              <div className="composer">
                <label htmlFor="composer" className="vh">
                  Message Mirror
                </label>
                <textarea
                  id="composer"
                  rows={1}
                  disabled
                  placeholder="This is a recorded run. Sending needs a live worker."
                />
                {busy ? (
                  <Pill variant="line" small label="Stop" icon="cross" onClick={stop} />
                ) : (
                  <Pill variant="dark" small label="Send" disabled />
                )}
              </div>
              <div className="status-line">
                <div>
                  <span className="btn ghost mono" data-state={agent.meta.mode === "manual" ? "attention" : "running"}>
                    <span className="sdot" style={{ animation: "none" }} />
                    {agent.meta.mode}
                  </span>
                  <div role="group" aria-label="Reasoning effort" className="segs">
                    {EFFORTS.map((effort) => (
                      <button
                        key={effort}
                        type="button"
                        className="seg"
                        aria-pressed={agent.meta.effort === effort}
                        onClick={() => setAgent({ ...agent, meta: { ...agent.meta, effort } })}
                      >
                        <span className="segin mono">{effort}</span>
                      </button>
                    ))}
                  </div>
                </div>
                <span className="mono faint">
                  {agent.ctx
                    ? `${Math.max(1, Math.round((agent.ctx.tokens / agent.ctx.window) * 100))}% ctx · ${Math.round(agent.ctx.window / 1000)}K`
                    : ""}
                </span>
              </div>
            </div>
          </main>

          <Panel agent={agent} />
        </div>
      )}
    </div>
  );
}
