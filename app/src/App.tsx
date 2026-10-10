import { useCallback, useEffect, useRef, useState } from "react";
import {
  applyEnvelope,
  byAttention,
  ctxPercent,
  newAgent,
  STATUS_DOT,
  STATUS_WORD,
  type AgentMeta,
  type AgentState,
  type ToolItem,
} from "./agent";
import * as bridge from "./bridge";
import type { Envelope } from "./events";
import { Panel } from "./Panel";
import { Pill, toolSummary, Transcript } from "./Transcript";

// The recorded run in fixtures/: the scripted model in dev/, against the real worker.
const REPLAY_META: Omit<AgentMeta, "id"> = {
  title: "Fix the failing average test",
  project: "stats-demo",
  branch: "main",
  workspace: "/workspace/stats-demo",
  model: "fake",
  api: "openai-chat-completions",
  baseUrl: "http://127.0.0.1:18431/v1",
  effort: "high",
  mode: "manual",
  live: false,
  source: "replay · fix-failing-test",
};

const EFFORTS = ["low", "medium", "high", "xhigh", "max"];
const DRAFT = "draft";

function loadTheme(): "cream" | "dark" {
  const asked = new URLSearchParams(location.search).get("theme");
  if (asked === "dark" || asked === "cream") return asked;
  try {
    return localStorage.getItem("glass.theme") === "dark" ? "dark" : "cream";
  } catch {
    return "cream";
  }
}

function loadFlag(key: string): boolean {
  try {
    return localStorage.getItem(key) !== "0";
  } catch {
    return true;
  }
}

function saveFlag(key: string, value: boolean) {
  try {
    localStorage.setItem(key, value ? "1" : "0");
  } catch {
    // Storage can be unavailable; the layout just will not persist.
  }
}

const firstLine = (text: string) => text.trim().split("\n")[0].slice(0, 80);

export function App() {
  const [theme, setTheme] = useState<"cream" | "dark">(loadTheme);
  const [agents, setAgents] = useState<Record<string, AgentState>>({});
  const [order, setOrder] = useState<string[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [setup, setSetup] = useState<bridge.Setup | null>(null);
  // A replay can only follow one recording; its first answer picks it.
  const [branches, setBranches] = useState<Record<string, boolean>>({});
  const [draft, setDraft] = useState("");
  const [focusFile, setFocusFile] = useState<{ path: string; at: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showSidebar, setShowSidebar] = useState(() => loadFlag("glass.sidebar"));
  const [showPanel, setShowPanel] = useState(() => loadFlag("glass.panel.open"));
  useEffect(() => saveFlag("glass.sidebar", showSidebar), [showSidebar]);
  useEffect(() => saveFlag("glass.panel.open", showPanel), [showPanel]);
  const scrolls = useRef<Record<string, number>>({});
  const composer = useRef<HTMLTextAreaElement>(null);
  // Events for agents the UI has not registered yet wait here.
  const early = useRef<Record<string, Envelope[]>>({});

  const update = (id: string, change: (agent: AgentState) => AgentState) =>
    setAgents((current) => (current[id] ? { ...current, [id]: change(current[id]) } : current));

  const add = (agent: AgentState, select = true) => {
    const waiting = early.current[agent.meta.id] ?? [];
    delete early.current[agent.meta.id];
    const folded = waiting.reduce((state, envelope) => applyEnvelope(state, envelope.seq, envelope.event), agent);
    setAgents((current) => ({ ...current, [agent.meta.id]: folded }));
    setOrder((current) => [...current.filter((id) => id !== agent.meta.id), agent.meta.id]);
    if (select) setSelected(agent.meta.id);
  };

  const startReplay = useCallback(async () => {
    const id = await bridge.startReplay("fix-failing-test");
    add(newAgent({ id, ...REPLAY_META }));
  }, []);

  useEffect(() => {
    let cancelled = false;
    bridge
      .subscribe((envelope) => {
        setAgents((current) => {
          const agent = current[envelope.agent_id];
          if (!agent) {
            (early.current[envelope.agent_id] ??= []).push(envelope);
            return current;
          }
          return { ...current, [envelope.agent_id]: applyEnvelope(agent, envelope.seq, envelope.event) };
        });
      })
      .then(() => bridge.checkSetup())
      .then((found) => {
        if (cancelled) return;
        setSetup(found);
        // The desktop app opens ready for real work. The browser build has no worker,
        // so it shows the recording.
        if (!bridge.inTauri) return startReplay();
      })
      .catch((reason) => setError(String(reason)));
    return () => {
      cancelled = true;
    };
  }, [startReplay]);

  useEffect(() => {
    try {
      localStorage.setItem("glass.theme", theme);
    } catch {
      // Storage can be unavailable; the theme just will not persist.
    }
  }, [theme]);

  const agent = selected ? agents[selected] : undefined;

  const resolve = useCallback(
    (agentId: string, callId: string, approved: boolean) => {
      const target = agents[agentId];
      if (!target) return;
      if (!target.meta.live) {
        const locked = branches[agentId];
        if (locked !== undefined && locked !== approved) return;
        if (locked === undefined) setBranches((current) => ({ ...current, [agentId]: approved }));
      }
      bridge.resolveApproval(agentId, callId, approved).catch((reason) => setError(String(reason)));
    },
    [agents, branches],
  );

  const stop = useCallback(async () => {
    if (!agent) return;
    update(agent.meta.id, (current) => ({ ...current, stopRequested: true }));
    await bridge.interrupt(agent.meta.id).catch((reason) => setError(String(reason)));
  }, [agent]);

  const newDraft = useCallback(async () => {
    if (!bridge.inTauri) return;
    const folder = await bridge.pickFolder();
    if (!folder) return;
    const name = folder.split("/").filter(Boolean).pop() ?? folder;
    add(
      newAgent({
        id: DRAFT,
        title: "New agent",
        project: name,
        branch: "",
        workspace: folder,
        model: setup?.model ?? "",
        api: setup?.api ?? "",
        baseUrl: setup?.base_url ?? null,
        effort: "high",
        mode: "manual",
        live: true,
        source: "live",
      }),
    );
    setTimeout(() => composer.current?.focus(), 0);
  }, [setup]);

  const send = useCallback(async () => {
    const text = draft.trim();
    if (!agent || !text) return;
    setDraft("");
    try {
      if (agent.meta.id === DRAFT) {
        const info = await bridge.startAgent(agent.meta.workspace, text, agent.meta.effort, agent.meta.mode === "auto");
        setAgents((current) => {
          const { [DRAFT]: _, ...rest } = current;
          return rest;
        });
        setOrder((current) => current.filter((id) => id !== DRAFT));
        add(
          newAgent(
            {
              ...agent.meta,
              id: info.id,
              title: firstLine(text),
              project: info.project,
              branch: info.branch,
              workspace: info.workspace,
              model: info.model,
              api: info.api,
              baseUrl: info.base_url,
            },
            "starting",
          ),
        );
        return;
      }
      if (!agent.meta.live) return;
      const id = await bridge.sendMessage(agent.meta.id, text);
      const busy = agent.status === "running" || agent.status === "attention";
      if (busy) update(agent.meta.id, (current) => ({ ...current, queued: [...current.queued, { id, text }] }));
    } catch (reason) {
      setError(String(reason));
      setDraft(text);
    }
  }, [agent, draft]);

  const restart = useCallback(async () => {
    if (!agent) return;
    // The worker replays the conversation on resume, so start the transcript afresh.
    const fresh = newAgent(agent.meta, "starting");
    update(agent.meta.id, () => fresh);
    await bridge.restartAgent(agent.meta.id).catch((reason) => setError(String(reason)));
  }, [agent]);

  const changeEffort = (effort: string) => {
    if (!agent) return;
    update(agent.meta.id, (current) => ({ ...current, meta: { ...current.meta, effort } }));
    if (agent.meta.live && agent.meta.id !== DRAFT) bridge.setEffort(agent.meta.id, effort).catch((reason) => setError(String(reason)));
  };

  const toggleMode = () => {
    if (!agent || !agent.meta.live) return;
    const mode = agent.meta.mode === "manual" ? "auto" : "manual";
    update(agent.meta.id, (current) => ({ ...current, meta: { ...current.meta, mode } }));
    if (agent.meta.id !== DRAFT) bridge.setApprovalMode(agent.meta.id, mode === "auto").catch((reason) => setError(String(reason)));
  };

  // A and R answer the selected agent's oldest request; Escape stops; Cmd K starts an agent.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        newDraft();
        return;
      }
      // Cmd B hides the agents column, Cmd J the changes panel.
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "b") {
        event.preventDefault();
        setShowSidebar((open) => !open);
        return;
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "j") {
        event.preventDefault();
        setShowPanel((open) => !open);
        return;
      }
      const target = event.target as HTMLElement | null;
      const typing = target && (target.tagName === "TEXTAREA" || target.tagName === "INPUT");
      if (event.key === "Escape" && agent && (!typing || !draft) && (agent.status === "running" || agent.status === "attention")) {
        stop();
        return;
      }
      if (typing || event.metaKey || event.ctrlKey || event.altKey) return;
      const first = agent?.pending[0];
      if (!agent || !first) return;
      if (event.key === "a" || event.key === "A") resolve(agent.meta.id, first, true);
      if (event.key === "r" || event.key === "R") resolve(agent.meta.id, first, false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [agent, draft, resolve, stop, newDraft]);

  const list = order.map((id) => agents[id]).filter(Boolean);
  const inbox = list.flatMap((entry) =>
    entry.pending
      .map((callId) => entry.items.find((item): item is ToolItem => item.kind === "tool" && item.id === callId))
      .filter((item): item is ToolItem => Boolean(item))
      .map((item) => ({ agent: entry, item })),
  );
  const projects = [...new Set(list.map((entry) => entry.meta.project))].map((project) => ({
    project,
    agents: list.filter((entry) => entry.meta.project === project).sort(byAttention),
  }));

  // Stop shows while the agent works. Waiting on the person is not working.
  const busy = agent?.status === "running" || agent?.status === "starting";
  const versionOk = setup?.version && setup.version === setup.tested_version;
  const workerState = !bridge.inTauri ? "stopped" : setup?.worker ? "running" : "failed";
  const workerWord = !bridge.inTauri
    ? "replay · no worker"
    : setup?.worker
      ? `mirror-agent ${setup.version ?? ""}${versionOk ? "" : ` · tested with ${setup.tested_version}`}`
      : "mirror-agent not found";

  return (
    <div className="app" data-theme={theme}>
      <header className="topbar">
        <div className="brand">
          <b>Glass</b>
          <span className="muted">for Mirror</span>
        </div>
        <span className="tag">unofficial</span>
        <span className="grow" />
        <button
          type="button"
          className="btn ghost"
          onClick={newDraft}
          disabled={!bridge.inTauri}
          title={bridge.inTauri ? "Pick a project folder and start an agent" : "Needs the desktop app"}
        >
          New agent<span className="kbd">⌘K</span>
        </button>
        {!showSidebar && inbox.length > 0 && (
          <button type="button" className="btn ghost" data-state="attention" style={{ gap: 8, fontWeight: 400 }} onClick={() => setShowSidebar(true)}>
            <span className="sdot" />
            needs you · {inbox.length}
          </button>
        )}
        <span data-state={workerState} className="mono faint still worker-state" title={setup?.worker ?? undefined}>
          <span className="sdot" />
          {workerWord}
        </span>
        <button
          type="button"
          className="icon-btn ghost"
          aria-label={showSidebar ? "Hide agents" : "Show agents"}
          aria-pressed={showSidebar}
          title={`${showSidebar ? "Hide" : "Show"} agents · ⌘B`}
          onClick={() => setShowSidebar(!showSidebar)}
        >
          <svg className="i" viewBox="0 0 16 16" aria-hidden="true">
            <rect x="2" y="3" width="12" height="10" rx="2" />
            <path d="M6 3v10" />
          </svg>
        </button>
        <button
          type="button"
          className="icon-btn ghost"
          aria-label={showPanel ? "Hide changes" : "Show changes"}
          aria-pressed={showPanel}
          title={`${showPanel ? "Hide" : "Show"} changes and session · ⌘J`}
          onClick={() => setShowPanel(!showPanel)}
        >
          <svg className="i" viewBox="0 0 16 16" aria-hidden="true">
            <rect x="2" y="3" width="12" height="10" rx="2" />
            <path d="M10 3v10" />
          </svg>
        </button>
        <button type="button" className="icon-btn ghost" aria-label="Switch theme" onClick={() => setTheme(theme === "dark" ? "cream" : "dark")}>
          <svg className="i" viewBox="0 0 16 16" aria-hidden="true">
            <circle cx="8" cy="8" r="5.5" />
            <path d="M8 2.5v11" className="dash" />
            <path d="M8 2.5a5.5 5.5 0 0 1 0 11" />
          </svg>
        </button>
      </header>

      <div className="cols">
        {showSidebar && (
        <nav aria-label="Agents" className="sidebar scroll">
          <section className="group" style={{ gap: 6 }}>
            <div className="inbox-head">
              <span className="cap">Needs you · {inbox.length}</span>
            </div>
            {inbox.map(({ agent: owner, item }) => (
              <button
                key={`${owner.meta.id}-${item.id}`}
                type="button"
                className="agent-row row"
                data-state="attention"
                onClick={() => setSelected(owner.meta.id)}
              >
                <span className="sdot" style={{ marginTop: 6 }} />
                <span className="lines">
                  <span className="mono" style={{ fontSize: 13 }}>
                    {item.name} {toolSummary(item, owner.meta.workspace)}
                  </span>
                  <span className="mono faint">
                    {owner.meta.project}
                    {owner.meta.branch ? ` · ${owner.meta.branch}` : ""}
                  </span>
                </span>
              </button>
            ))}
            {!inbox.length && <span className="mono faint empty">nothing waiting</span>}
          </section>

          {projects.map(({ project, agents: members }) => (
            <section key={project} className="group">
              <div className="group-head">
                <b>{project}</b>
                <span className="mono faint">
                  {members.length} agent{members.length > 1 ? "s" : ""}
                </span>
              </div>
              {members.map((member) => (
                <button
                  key={member.meta.id}
                  type="button"
                  className="agent-row row fresh"
                  data-state={STATUS_DOT[member.status]}
                  aria-current={member.meta.id === selected}
                  onClick={() => setSelected(member.meta.id)}
                >
                  <span className="sdot" />
                  <span className="lines">
                    <span className="title">{member.meta.title}</span>
                    <span className="mono faint">
                      {[member.meta.branch, member.meta.effort, STATUS_WORD[member.status]].filter(Boolean).join(" · ")}
                    </span>
                  </span>
                </button>
              ))}
            </section>
          ))}
          <span className="grow" />
          <button
            type="button"
            className="link-btn mono faint"
            onClick={startReplay}
            title="Play back a recorded run, with no worker or model. For trying the UI."
          >
            play the recorded demo
          </button>
        </nav>
        )}

        {agent ? (
          <>
            <main className="main">
              <div className="main-head">
                <h1>{agent.meta.title}</h1>
                <span className="mono faint">
                  {[agent.meta.project, agent.meta.branch && `git ${agent.meta.branch}`, agent.meta.model].filter(Boolean).join(" · ")}
                </span>
              </div>

              <Transcript
                key={agent.meta.id}
                agent={agent}
                lockedTo={agent.meta.live ? null : (branches[agent.meta.id] ?? null)}
                initialScroll={scrolls.current[agent.meta.id] ?? null}
                onScrollSave={(top) => (scrolls.current[agent.meta.id] = top)}
                onResolve={(callId, approved) => resolve(agent.meta.id, callId, approved)}
                onOpenFile={(path) => setFocusFile({ path, at: Date.now() })}
              />

              <div className="composer-wrap">
                {error && (
                  <div className="bar" data-state="failed">
                    <span className="sdot" />
                    <span className="bar-body">{error}</span>
                    <button type="button" className="btn ghost" style={{ fontWeight: 400 }} onClick={() => setError(null)}>
                      dismiss
                    </button>
                  </div>
                )}
                {agent.closedError && (
                  <div className="bar" data-state="failed">
                    <span className="sdot" />
                    <span className="bar-body">
                      <span>{agent.started ? "The worker stopped. Restart resumes the conversation." : "The worker would not start."}</span>
                      <span className="mono faint stderr">{[agent.closedError, ...agent.logs.slice(-6)].join("\n")}</span>
                    </span>
                    <Pill variant="line" small label={agent.started ? "Restart" : "Try again"} onClick={restart} />
                  </div>
                )}
                {agent.queued.length > 0 && (
                  <div className="queued">
                    {agent.queued.map((entry) => (
                      <div key={entry.id} className="mono faint">
                        queued · {entry.text}
                      </div>
                    ))}
                  </div>
                )}
                <div className="composer">
                  <label htmlFor="composer" className="vh">
                    Message Mirror
                  </label>
                  <textarea
                    id="composer"
                    ref={composer}
                    rows={1}
                    value={draft}
                    disabled={!agent.meta.live || Boolean(agent.closedError)}
                    onChange={(event) => setDraft(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" && !event.shiftKey) {
                        event.preventDefault();
                        send();
                      }
                    }}
                    placeholder={
                      agent.meta.live
                        ? agent.meta.id === DRAFT
                          ? `Describe the task for ${agent.meta.project}. Enter starts the agent.`
                          : "Message Mirror. It queues if the agent is busy."
                        : "This is a recorded run. Sending needs a live agent."
                    }
                  />
                  {busy && <Pill variant="line" small label="Stop" icon="cross" onClick={stop} />}
                  <Pill variant="dark" small label="Send" onClick={send} />
                </div>
                <div className="status-line">
                  <div>
                    <button
                      type="button"
                      className="btn ghost"
                      style={{ gap: 8, fontWeight: 400 }}
                      data-state={agent.meta.mode === "manual" ? "attention" : "running"}
                      onClick={toggleMode}
                      disabled={!agent.meta.live}
                      title={
                        agent.meta.live
                          ? "Manual asks before tools run. Auto runs them without asking. Applies to the next request."
                          : "A recording plays back as it was made; its mode cannot change."
                      }
                    >
                      <span className="sdot" style={{ animation: "none" }} />
                      {agent.meta.mode}
                    </button>
                    <div role="group" aria-label="Reasoning effort" className="segs">
                      {EFFORTS.map((effort) => (
                        <button key={effort} type="button" className="seg" aria-pressed={agent.meta.effort === effort} onClick={() => changeEffort(effort)}>
                          <span className="segin mono">{effort}</span>
                        </button>
                      ))}
                    </div>
                  </div>
                  <span className="mono faint">
                    {agent.ctx ? `${ctxPercent(agent.ctx)} ctx · ${Math.round(agent.ctx.window / 1000)}K` : ""}
                  </span>
                </div>
              </div>
            </main>
            {showPanel && <Panel agent={agent} focusFile={focusFile} />}
          </>
        ) : (
          <main className="main empty-main">
            <span className="muted">Press ⌘K to start an agent</span>
            {bridge.inTauri && <Pill variant="lime" label="New agent" onClick={newDraft} />}
          </main>
        )}
      </div>
    </div>
  );
}
