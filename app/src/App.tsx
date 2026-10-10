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
import { Launcher, type LaunchPlan } from "./Launcher";
import { ModelPicker, type ModelChoice } from "./ModelPicker";
import { Setup } from "./Setup";
import { Panel } from "./Panel";
import { Pill, toolSummary, Transcript } from "./Transcript";

// The recorded run in fixtures/: the scripted model in dev/, against the real worker.
const REPLAY_META: Omit<AgentMeta, "id"> = {
  title: "Fix the failing average test",
  project: "stats-demo",
  projectPath: "/workspace/stats-demo",
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

// Dev only, for screenshots: ?setup=1 shows the setup screen in a plain browser.
const devSetup = typeof location !== "undefined" && new URLSearchParams(location.search).get("setup") === "1";

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
  const [projects, setProjects] = useState<bridge.Project[]>([]);
  const [launcher, setLauncher] = useState(false);
  // The model new agents start with. Saved by the Rust side, never with a key.
  const [choice, setChoice] = useState<ModelChoice>({ api: "reflection", model: "Beam-501B-A23B", baseUrl: null });
  // Which project the launcher opens on: the current agent's, or one picked from the sidebar.
  const [launcherProject, setLauncherProject] = useState<bridge.Project | null | "current">("current");
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>(() => {
    try {
      return JSON.parse(localStorage.getItem("glass.collapsed") ?? "{}");
    } catch {
      return {};
    }
  });
  // For the event handler, which outlives renders.
  const selectedRef = useRef<string | null>(null);
  const agentsRef = useRef<Record<string, AgentState>>({});
  const notified = useRef<string | null>(null);
  const [showSidebar, setShowSidebar] = useState(() => loadFlag("glass.sidebar"));
  const [showPanel, setShowPanel] = useState(() => loadFlag("glass.panel.open"));
  useEffect(() => saveFlag("glass.sidebar", showSidebar), [showSidebar]);
  useEffect(() => saveFlag("glass.panel.open", showPanel), [showPanel]);
  const scrolls = useRef<Record<string, number>>({});
  const composer = useRef<HTMLTextAreaElement>(null);
  // Events for agents the UI has not registered yet wait here.
  const early = useRef<Record<string, Envelope[]>>({});
  // Incoming events are applied in one batch per frame, so a fast stream costs
  // at most one render per frame however many pieces arrive.
  const queue = useRef<Envelope[]>([]);
  const known = useRef(new Set<string>());
  const flushing = useRef(false);
  const scheduleFlush = useCallback(() => {
    if (flushing.current) return;
    flushing.current = true;
    let done = false;
    const flush = () => {
      if (done) return;
      done = true;
      flushing.current = false;
      const batch = queue.current.filter((envelope) => {
        if (known.current.has(envelope.agent_id)) return true;
        (early.current[envelope.agent_id] ??= []).push(envelope);
        return false;
      });
      queue.current = [];
      if (!batch.length) return;
      // Pure, so React may run it twice.
      setAgents((current) => {
        let next = current;
        for (const envelope of batch) {
          const agent = next[envelope.agent_id];
          if (agent) next = { ...next, [envelope.agent_id]: applyEnvelope(agent, envelope.seq, envelope.event) };
        }
        return next;
      });
    };
    requestAnimationFrame(flush);
    // A hidden window gets no frames; still keep state current for notifications and the inbox.
    setTimeout(flush, 100);
  }, []);

  const update = (id: string, change: (agent: AgentState) => AgentState) =>
    setAgents((current) => (current[id] ? { ...current, [id]: change(current[id]) } : current));

  const add = (agent: AgentState, select = true) => {
    known.current.add(agent.meta.id);
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
        // A request from an agent the person is not looking at raises a notification.
        const owner = agentsRef.current[envelope.agent_id];
        if (envelope.event.type === "approval_requested" && owner?.meta.live && (!document.hasFocus() || selectedRef.current !== envelope.agent_id)) {
          notified.current = envelope.agent_id;
          bridge.notify(`${owner.meta.project} needs you`, `Mirror wants to ${envelope.event.tool} · ${owner.meta.title}`).catch(() => {});
        }
        queue.current.push(envelope);
        scheduleFlush();
      })
      .then(() => bridge.checkSetup())
      .then(async (found) => {
        if (cancelled) return;
        setSetup(found);
        if (found) setChoice({ api: found.api, model: found.model, baseUrl: found.base_url });
        setProjects(await bridge.listProjects());
        // The desktop app opens ready for real work. The browser build has no worker,
        // so it shows the recording.
        if (devSetup) {
          setSetup({ worker: "/Users/you/.local/share/uv/tools/mirror/lib/python3.12/site-packages/mirror/bin/mirror-agent", version: "0.1.0", tested_version: "0.1.0", keys: ["OPENAI_API_KEY"], api: "openai-responses", model: "gpt-5-nano", base_url: null, mirror_command: "" });
          setChoice({ api: "openai-responses", model: "gpt-5-nano", baseUrl: null });
          return;
        }
        if (!bridge.inTauri) {
          // Dev only, for screenshots: ?launcher=1 opens the launcher over the recording.
          if (new URLSearchParams(location.search).get("launcher")) {
            setProjects([{ path: REPLAY_META.projectPath, name: REPLAY_META.project, git: true, origin: "origin/main" }]);
            setLauncher(true);
          }
          return startReplay();
        }
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
  selectedRef.current = selected;
  agentsRef.current = agents;

  // Coming back to the window after a notification opens the agent that asked.
  useEffect(() => {
    let off: (() => void) | undefined;
    bridge
      .onWindowFocus(() => {
        const id = notified.current;
        notified.current = null;
        if (id && agentsRef.current[id]?.pending.length) setSelected(id);
      })
      .then((unlisten) => (off = unlisten));
    return () => off?.();
  }, []);

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

  const openLauncher = useCallback(async (project?: bridge.Project | null) => {
    if (!bridge.inTauri) return;
    setLauncherProject(project === undefined ? "current" : project);
    setLauncher(true);
    setProjects(await bridge.listProjects());
  }, []);

  const toggleGroup = (key: string) =>
    setCollapsed((current) => {
      const next = { ...current, [key]: !current[key] };
      try {
        localStorage.setItem("glass.collapsed", JSON.stringify(next));
      } catch {
        // Storage can be unavailable; the layout just will not persist.
      }
      return next;
    });

  const pickProject = useCallback(async () => {
    const folder = await bridge.pickFolder();
    if (!folder) return null;
    const added = await bridge.addProject(folder);
    setProjects(await bridge.listProjects());
    return added;
  }, []);

  const launch = useCallback(
    async (plan: LaunchPlan) => {
      setLauncher(false);
      const effort = agent?.meta.effort ?? "high";
      const mode = agent?.meta.live ? agent.meta.mode : "manual";
      const title = firstLine(plan.text);
      try {
        const info = await bridge.startAgent(plan.project?.path ?? "", plan.text, effort, mode === "auto", plan.checkout, title, choice);
        add(
          newAgent(
            {
              id: info.id,
              title,
              project: plan.project?.name ?? "no project",
              projectPath: plan.project?.path ?? info.workspace,
              branch: info.branch,
              workspace: info.workspace,
              model: info.model,
              api: info.api,
              baseUrl: info.base_url,
              effort,
              mode,
              live: true,
              source: "live",
            },
            "starting",
          ),
          // The person stays where they were, unless there was nothing to look at.
          !agent,
        );
        setProjects(await bridge.listProjects());
      } catch (reason) {
        setError(String(reason));
      }
    },
    [agent, choice],
  );

  const changeDefaultModel = (next: ModelChoice) => {
    setChoice(next);
    bridge.setDefaultModel(next.api, next.model, next.baseUrl).catch((reason) => setError(String(reason)));
  };

  const changeAgentModel = (next: ModelChoice) => {
    if (!agent?.meta.live) return;
    update(agent.meta.id, (current) => ({ ...current, meta: { ...current.meta, api: next.api, model: next.model, baseUrl: next.baseUrl } }));
    bridge.setInference(agent.meta.id, next.api, next.model, next.baseUrl, agent.meta.effort).catch((reason) => setError(String(reason)));
  };

  const send = useCallback(async () => {
    const text = draft.trim();
    if (!agent || !text) return;
    setDraft("");
    try {
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
    if (agent.meta.live) bridge.setInference(agent.meta.id, agent.meta.api, agent.meta.model, agent.meta.baseUrl, effort).catch((reason) => setError(String(reason)));
  };

  const toggleMode = () => {
    if (!agent || !agent.meta.live) return;
    const mode = agent.meta.mode === "manual" ? "auto" : "manual";
    update(agent.meta.id, (current) => ({ ...current, meta: { ...current.meta, mode } }));
    bridge.setApprovalMode(agent.meta.id, mode === "auto").catch((reason) => setError(String(reason)));
  };

  // A and R answer the selected agent's oldest request; Escape stops; Cmd K starts an agent.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        openLauncher();
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
  }, [agent, draft, resolve, stop, openLauncher]);

  const list = order.map((id) => agents[id]).filter(Boolean);
  const inbox = list.flatMap((entry) =>
    entry.pending
      .map((callId) => entry.items.find((item): item is ToolItem => item.kind === "tool" && item.id === callId))
      .filter((item): item is ToolItem => Boolean(item))
      .map((item) => ({ agent: entry, item })),
  );
  // Saved projects first, in the order they were last used, then any project an
  // agent belongs to that is not saved (a recording), then agents with no project.
  const scratch = list.filter((entry) => entry.meta.project === "no project");
  const groups: { key: string; name: string; project: bridge.Project | null; agents: AgentState[] }[] = [
    ...projects.map((project) => ({
      key: project.path,
      name: project.name,
      project,
      agents: list.filter((entry) => entry.meta.projectPath === project.path),
    })),
    ...[...new Set(list.filter((entry) => entry.meta.project !== "no project" && !projects.some((project) => project.path === entry.meta.projectPath)).map((entry) => entry.meta.projectPath))].map((path) => {
      const members = list.filter((entry) => entry.meta.projectPath === path);
      return { key: path, name: members[0].meta.project, project: null, agents: members };
    }),
    ...(scratch.length ? [{ key: "no project", name: "No project", project: null, agents: scratch }] : []),
  ].map((group) => ({ ...group, agents: [...group.agents].sort(byAttention) }));

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
          onClick={() => openLauncher()}
          disabled={!bridge.inTauri}
          title={bridge.inTauri ? "Type a task, @ a project, Enter" : "Needs the desktop app"}
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

          {groups.map((group) => {
            const shut = collapsed[group.key];
            const waiting = group.agents.filter((member) => member.status === "attention").length;
            return (
              <section key={group.key} className="group">
                <div className="group-head project-head">
                  <button
                    type="button"
                    className="project-toggle"
                    aria-expanded={!shut}
                    onClick={() => toggleGroup(group.key)}
                    title={group.project ? group.project.path : undefined}
                  >
                    <svg className="i chev" viewBox="0 0 16 16" aria-hidden="true">
                      <path d="M6 4l4 4-4 4" />
                    </svg>
                    <b>{group.name}</b>
                  </button>
                  <span className="mono faint">
                    {shut && waiting ? `${waiting} needs you · ` : ""}
                    {group.agents.length || ""}
                  </span>
                  {bridge.inTauri && group.key !== "no project" && group.project && (
                    <button type="button" className="icon-btn ghost small" aria-label={`New agent in ${group.name}`} title={`New agent in ${group.name}`} onClick={() => openLauncher(group.project)}>
                      <svg className="i" viewBox="0 0 16 16" aria-hidden="true">
                        <path d="M8 3.5v9M3.5 8h9" />
                      </svg>
                    </button>
                  )}
                </div>
                {!shut &&
                  group.agents.map((member) => (
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
                {!shut && !group.agents.length && <span className="mono faint empty">no agents yet</span>}
              </section>
            );
          })}
          {bridge.inTauri && (
            <button type="button" className="btn ghost add-project" onClick={() => pickProject()}>
              <svg className="i" viewBox="0 0 16 16" aria-hidden="true" style={{ width: 14, height: 14 }}>
                <path d="M8 3.5v9M3.5 8h9" />
              </svg>
              Add project
            </button>
          )}
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
                    placeholder={agent.meta.live ? "Message Mirror. It queues if the agent is busy." : "This is a recorded run. Sending needs a live agent."}
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
                    {agent.meta.live && (
                      <ModelPicker
                        choice={{ api: agent.meta.api, model: agent.meta.model, baseUrl: agent.meta.baseUrl }}
                        keys={setup?.keys ?? []}
                        note="Applies from the agent's next turn."
                        onChange={changeAgentModel}
                      />
                    )}
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
          <main className="main empty-main scroll">
            {bridge.inTauri || devSetup ? (
              <Setup
                setup={setup}
                choice={choice}
                onChoice={changeDefaultModel}
                onStart={() => openLauncher(null)}
                onAddProject={async () => {
                  const added = await pickProject();
                  if (added) openLauncher(added);
                }}
              />
            ) : (
              <span className="muted">Press ⌘K to start an agent</span>
            )}
          </main>
        )}
      </div>
      {launcher && (
        <Launcher
          projects={projects}
          agentCount={(project) => list.filter((entry) => entry.meta.projectPath === project.path).length}
          mainBusy={(project) => list.some((entry) => entry.meta.live && entry.meta.workspace === project.path)}
          defaultProject={
            launcherProject === "current" ? (projects.find((project) => project.path === agent?.meta.projectPath) ?? null) : launcherProject
          }
          effort={agent?.meta.effort ?? "high"}
          choice={choice}
          keys={setup?.keys ?? []}
          onChoice={changeDefaultModel}
          mode={agent?.meta.live ? agent.meta.mode : "manual"}
          onPickFolder={pickProject}
          onStart={launch}
          onClose={() => setLauncher(false)}
        />
      )}
    </div>
  );
}
