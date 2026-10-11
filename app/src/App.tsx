import { useCallback, useEffect, useRef, useState } from "react";
import {
  ago,
  applyEnvelope,
  byAttention,
  ctxPercent,
  newAgent,
  STATUS_DOT,
  STATUS_WORD,
  type AgentState,
  type ToolItem,
} from "./agent";
import * as bridge from "./bridge";
import type { Envelope } from "./events";
import { Composer, type ComposerHandle } from "./Composer";
import { controlKey, EffortMenu, ModeMenu, stepEffort } from "./Controls";
import { ModelPicker, openModelMenu, type ModelChoice } from "./ModelPicker";
import { NewAgent, type LaunchPlan } from "./NewAgent";
import { reviewMessage, type ReviewComment } from "./review";
import { Settings } from "./Settings";
import { SetupNotes } from "./Setup";
import { TerminalDrawer } from "./TerminalDrawer";
import { ThemeToggle } from "./ThemeToggle";
import { Panel } from "./Panel";
import { Pill, toolLabel, toolSummary, Transcript } from "./Transcript";


function loadTheme(): "cream" | "dark" {
  const asked = import.meta.env.DEV ? new URLSearchParams(location.search).get("theme") : null;
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
  const [draft, setDraft] = useState("");
  const [focusFile, setFocusFile] = useState<{ path: string; at: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [projects, setProjects] = useState<bridge.Project[]>([]);
  const [servers, setServers] = useState<bridge.McpServer[]>([]);
  // Cmd K: the new-agent form over whatever is open.
  const [launcher, setLauncher] = useState(false);
  // Diff comments waiting to be sent, by agent.
  const [reviews, setReviews] = useState<Record<string, ReviewComment[]>>({});
  const [settings, setSettings] = useState(false);
  // The new-agent page in the main column, for a project or none.
  const [page, setPage] = useState<{ project: bridge.Project | null } | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  // Ticks each half minute so "4m ago" stays true.
  const [clock, setClock] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setClock(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);
  // The model new agents start with. Saved by the Rust side, never with a key.
  const [choice, setChoice] = useState<ModelChoice>({ api: "reflection", model: "Beam-501B-A23B", baseUrl: null });
  // Which project the launcher opens on: the current agent's, or one picked from the sidebar.
  const [launcherProject, setLauncherProject] = useState<bridge.Project | null>(null);
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
  const sidebarOrder = useRef<string[]>([]);
  const [showSidebar, setShowSidebar] = useState(() => loadFlag("glass.sidebar"));
  const [showPanel, setShowPanel] = useState(() => loadFlag("glass.panel.open"));
  const [showTerminal, setShowTerminal] = useState(false);
  const [terminalDock, setTerminalDock] = useState<"bottom" | "right">(() => {
    try {
      return localStorage.getItem("glass.terminal.dock") === "right" ? "right" : "bottom";
    } catch {
      return "bottom";
    }
  });
  const [terminalInput, setTerminalInput] = useState<{ agentId: string; text: string; at: number } | null>(null);
  useEffect(() => saveFlag("glass.sidebar", showSidebar), [showSidebar]);
  useEffect(() => saveFlag("glass.panel.open", showPanel), [showPanel]);
  const scrolls = useRef<Record<string, number>>({});
  const composer = useRef<ComposerHandle>(null);
  // Events for agents the UI has not registered yet wait here.
  const early = useRef<Record<string, (Envelope & { at?: number })[]>>({});
  // Incoming events are applied in one batch per frame, so a fast stream costs
  // at most one render per frame however many pieces arrive.
  const queue = useRef<(Envelope & { at?: number })[]>([]);
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
          if (agent) next = { ...next, [envelope.agent_id]: applyEnvelope(agent, envelope.seq, envelope.event, envelope.at) };
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
    const folded = waiting.reduce((state, envelope) => applyEnvelope(state, envelope.seq, envelope.event, envelope.at), agent);
    setAgents((current) => ({ ...current, [agent.meta.id]: folded }));
    setOrder((current) => [...current.filter((id) => id !== agent.meta.id), agent.meta.id]);
    if (select) setSelected(agent.meta.id);
  };

  useEffect(() => {
    let cancelled = false;
    bridge
      .subscribe((envelope) => {
        // A request from an agent the person is not looking at raises a notification.
        const owner = agentsRef.current[envelope.agent_id];
        const away = !document.hasFocus() || selectedRef.current !== envelope.agent_id;
        if (owner?.meta.live && away) {
          const event = envelope.event;
          const tell = (title: string, body: string) => {
            notified.current = envelope.agent_id;
            bridge.notify(title, body).catch(() => {});
          };
          if (event.type === "approval_requested") tell(`${owner.meta.project} needs you`, `Mirror wants to ${toolLabel(event.tool)} · ${owner.meta.title}`);
          else if (event.type === "turn_completed") tell(`${owner.meta.title}`, `Done · ${owner.meta.project}`);
          else if (event.type === "turn_error" || (event.type === "turn_interrupted" && !owner.stopRequested))
            tell(`${owner.meta.title}`, `Failed · ${owner.meta.project}`);
        }
        queue.current.push({ ...envelope, at: Date.now() });
        scheduleFlush();
      })
      .then(() => bridge.checkSetup())
      .then(async (found) => {
        if (cancelled) return;
        setSetup(found);
        if (found) setChoice({ api: found.api, model: found.model, baseUrl: found.base_url });
        setProjects(await bridge.listProjects());
        // Connecting can take a few seconds; the rest of the app does not wait.
        if (bridge.inTauri) bridge.mcpServers().then(setServers).catch(() => {});
        // Agents from the last run come back with their transcripts, stopped.
        const restored = await bridge.restoreAgents();
        for (const { agent: saved, events } of restored) {
          let state = events.reduce(
            (current, event, seq) => applyEnvelope(current, seq, event),
            newAgent({
              id: saved.id,
              title: saved.title,
              project: saved.project,
              projectPath: saved.project_path,
              branch: saved.branch,
              workspace: saved.workspace,
              model: saved.model,
              api: saved.api,
              baseUrl: saved.base_url,
              effort: saved.effort,
              mode: saved.auto ? "auto" : "manual",
              live: true,
              source: "live",
            }),
          );
          const wasWorking = state.status === "running" || state.status === "attention" || state.status === "starting";
          state = {
            ...state,
            seq: -1,
            pending: [],
            closedError: null,
            status: wasWorking ? "stopped" : state.status === "idle" ? "stopped" : state.status,
            items: wasWorking
              ? [...state.items, { kind: "notice", id: `resumed-${saved.id}`, tone: "quiet", text: "Glass was closed mid-turn. Send a message to resume.", lines: [] }]
              : state.items,
          };
          add(state, false);
        }
        if (restored.length) setSelected(restored[restored.length - 1].agent.id);
        // Development only, outside the app: screens built from the recordings.
        if (import.meta.env.DEV && !bridge.inTauri) {
          const { preview } = await import("./dev/preview");
          const shown = preview();
          setSetup(shown.setup);
          setChoice({ api: shown.setup.api, model: shown.setup.model, baseUrl: shown.setup.base_url });
          setProjects(shown.projects);
          setServers(shown.servers);
          for (const other of shown.others) add(other, false);
          if (shown.agent) add(shown.agent);
          if (shown.page) setPage({ project: shown.projects[0] });
          if (shown.launcher) setLauncher(true);
        }
      })
      .catch((reason) => setError(String(reason)));
    return () => {
      cancelled = true;
    };
  }, []);

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
      bridge.resolveApproval(agentId, callId, approved).catch((reason) => setError(String(reason)));
    },
    [agents],
  );

  const stop = useCallback(async () => {
    if (!agent) return;
    update(agent.meta.id, (current) => ({ ...current, stopRequested: true }));
    await bridge.interrupt(agent.meta.id).catch((reason) => setError(String(reason)));
  }, [agent]);

  const currentProject = useCallback(
    () => projects.find((project) => project.path === agentsRef.current[selectedRef.current ?? ""]?.meta.projectPath) ?? null,
    [projects],
  );

  // Cmd K: start an agent without leaving the one on screen.
  const openLauncher = useCallback(
    async (project?: bridge.Project | null) => {
      if (!bridge.inTauri) return;
      setPage(null);
      setLauncherProject(project === undefined ? currentProject() : project);
      setLauncher(true);
      setProjects(await bridge.listProjects());
    },
    [currentProject],
  );

  // New agent: an empty chat in the main column.
  const openNew = useCallback(
    (project?: bridge.Project | null) => {
      setLauncher(false);
      setPage({ project: project === undefined ? currentProject() : project });
    },
    [currentProject],
  );

  const removeProject = async (path: string) => {
    await bridge.removeProject(path).catch((reason) => setError(String(reason)));
    setRemoving(null);
    setProjects(await bridge.listProjects());
  };

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
    async (plan: LaunchPlan, from: "page" | "dialog") => {
      const title = firstLine(plan.text);
      // An effort race is the same task once per effort, each in its own checkout.
      const runs = plan.race ? plan.race.efforts : [plan.effort];
      const raceId = plan.race ? `race-${Date.now()}` : null;
      let first: string | null = null;
      try {
        for (const effort of runs) {
          const runTitle = raceId ? `${title} · ${effort}` : title;
          const info = await bridge.startAgent(plan.project?.path ?? "", plan.text, effort, plan.mode === "auto", plan.checkout, runTitle, plan.choice, Boolean(raceId));
          first ??= info.id;
          add(
            newAgent(
              {
                id: info.id,
                title: runTitle,
                project: plan.project?.name ?? "no project",
                projectPath: plan.project?.path ?? info.workspace,
                branch: info.branch,
                workspace: info.workspace,
                model: info.model,
                api: info.api,
                baseUrl: info.base_url,
                effort,
                mode: plan.mode,
                live: true,
                source: "live",
                race: raceId ? { id: raceId, check: plan.race!.check } : undefined,
              },
              "starting",
            ),
            false,
          );
        }
        if (from === "dialog") setLauncher(false);
        else setPage(null);
        // From the page, open the new agent. From Cmd K, stay put, unless nothing was open.
        if (first && (from === "page" || !selectedRef.current)) setSelected(first);
        setProjects(await bridge.listProjects());
      } catch (reason) {
        setError(String(reason));
      }
    },
    [],
  );

  // Each race runner's check runs once, when it first finishes.
  const [checks, setChecks] = useState<Record<string, bridge.CheckResult | "running">>({});
  useEffect(() => {
    for (const entry of Object.values(agents)) {
      const race = entry.meta.race;
      if (!race?.check || entry.status !== "done" || checks[entry.meta.id]) continue;
      setChecks((current) => ({ ...current, [entry.meta.id]: "running" }));
      bridge
        .runCheck(entry.meta.workspace, race.check)
        .then((result) => setChecks((current) => ({ ...current, [entry.meta.id]: result })))
        .catch((reason) => setChecks((current) => ({ ...current, [entry.meta.id]: { exit_code: null, tail: String(reason), seconds: 0 } })));
    }
  }, [agents, checks]);

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
    // !command runs in the agent's terminal, not through the agent, as in Codex.
    if (text.startsWith("!") && agent.meta.live) {
      setShowTerminal(true);
      setTerminalInput({ agentId: agent.meta.id, text: `${text.slice(1).trimStart()}\r`, at: Date.now() });
      return;
    }
    try {
      if (!agent.meta.live) return;
      const id = await bridge.sendMessage(agent.meta.id, text);
      if (!id) {
        // No worker: Glass relaunched one, resuming the conversation, with this message.
        update(agent.meta.id, (current) => ({ ...current, status: "starting", closedError: null }));
        return;
      }
      const busy = agent.status === "running" || agent.status === "attention";
      if (busy) update(agent.meta.id, (current) => ({ ...current, queued: [...current.queued, { id, text }] }));
    } catch (reason) {
      setError(String(reason));
      setDraft(text);
    }
  }, [agent, draft]);

  // Rewind: fork the conversation before that message, maybe restore files, and put
  // the message back in the box to edit and send again.
  const rewind = useCallback(
    async (id: string, text: string, restoreFiles: boolean) => {
      if (!agent) return;
      try {
        const result = await bridge.rewindAgent(agent.meta.id, id, restoreFiles);
        update(agent.meta.id, (current) => ({ ...current, status: "starting" }));
        setDraft(text);
        composer.current?.focus();
        if (restoreFiles && result.files_restored && result.removed.length) setError(`Files put back. Removed since then: ${result.removed.join(", ")}`);
      } catch (reason) {
        setError(String(reason));
      }
    },
    [agent],
  );

  const restart = useCallback(async () => {
    if (!agent) return;
    // The transcript stays; the worker resumes the conversation behind it.
    update(agent.meta.id, (current) => ({ ...current, status: "starting", closedError: null, logs: [] }));
    await bridge.restartAgent(agent.meta.id).catch((reason) => setError(String(reason)));
  }, [agent]);

  // Close: stop the worker and forget the agent. Its files stay.
  const closeAgent = useCallback(
    async (id: string) => {
      await bridge.stopAgent(id).catch((reason) => setError(String(reason)));
      known.current.delete(id);
      setAgents((current) => {
        const { [id]: _, ...rest } = current;
        return rest;
      });
      setOrder((current) => current.filter((entry) => entry !== id));
      if (selected === id) setSelected(order.filter((entry) => entry !== id).pop() ?? null);
    },
    [order, selected],
  );

  // Quitting stops every worker. Ask once when agents are working; otherwise just quit.
  const [quitting, setQuitting] = useState(false);
  useEffect(() => {
    let off: (() => void) | undefined;
    bridge
      .onQuitRequested(() => {
        const working = Object.values(agentsRef.current).some(
          (entry) => entry.meta.live && (entry.status === "running" || entry.status === "attention" || entry.status === "starting"),
        );
        if (working) setQuitting(true);
        else bridge.quitApp();
      })
      .then((unlisten) => (off = unlisten));
    return () => off?.();
  }, []);

  const changeEffort = (effort: string) => {
    if (!agent) return;
    update(agent.meta.id, (current) => ({ ...current, meta: { ...current.meta, effort } }));
    if (agent.meta.live) bridge.setInference(agent.meta.id, agent.meta.api, agent.meta.model, agent.meta.baseUrl, effort).catch((reason) => setError(String(reason)));
  };

  const changeMode = (mode: "manual" | "auto") => {
    if (!agent || !agent.meta.live) return;
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
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "n") {
        event.preventDefault();
        openNew();
        return;
      }
      if ((event.metaKey || event.ctrlKey) && event.key === ",") {
        event.preventDefault();
        setSettings(true);
        return;
      }
      // Option Up and Down move between agents in sidebar order.
      if (event.altKey && !event.metaKey && (event.key === "ArrowUp" || event.key === "ArrowDown")) {
        const ids = sidebarOrder.current;
        if (ids.length) {
          event.preventDefault();
          const at = ids.indexOf(selectedRef.current ?? "");
          const next = at === -1 ? 0 : (at + (event.key === "ArrowDown" ? 1 : ids.length - 1)) % ids.length;
          setPage(null);
          setSelected(ids[next]);
        }
        return;
      }
      // Ctrl ` shows the terminal, as in most editors.
      if (event.ctrlKey && event.key === "`") {
        event.preventDefault();
        setShowTerminal((open) => !open);
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
      // The new-agent form handles these for itself.
      if (agent?.meta.live && !launcher && !page && controlKey(event, {
        effort: (direction) => changeEffort(stepEffort(agent.meta.effort, direction)),
        mode: () => changeMode(agent.meta.mode === "manual" ? "auto" : "manual"),
        model: openModelMenu,
      })) return;
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
  }, [agent, draft, resolve, stop, openLauncher, openNew, launcher, page]);

  const list = order.map((id) => agents[id]).filter(Boolean);
  const inbox = list.flatMap((entry) =>
    entry.pending
      .map((callId) => entry.items.find((item): item is ToolItem => item.kind === "tool" && item.id === callId))
      .filter((item): item is ToolItem => Boolean(item))
      .map((item) => ({ agent: entry, item })),
  );
  // Saved projects first, in the order they were last used, then any project an
  // agent belongs to that is not saved, then agents with no project.
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
    ...(scratch.length ? [{ key: "no project", name: "Chats", project: null, agents: scratch }] : []),
  ].map((group) => ({ ...group, agents: [...group.agents].sort(byAttention) }));

  // The terminal follows what is on screen: the open agent's workspace, else the
  // project picked on the new-agent page, else the home folder (an empty cwd).
  const terminalTarget =
    agent && !page && agent.meta.live
      ? { id: agent.meta.id, cwd: agent.meta.workspace }
      : page?.project
        ? { id: `project:${page.project.path}`, cwd: page.project.path }
        : { id: "home", cwd: "" };

  // The sidebar's order, for Option Up and Down.
  sidebarOrder.current = groups.filter((group) => !collapsed[group.key]).flatMap((group) => group.agents.map((member) => member.meta.id));

  // Stop shows while the agent works. Waiting on the person is not working.
  const busy = agent?.status === "running" || agent?.status === "starting";
  const connections = servers.filter((server) => server.status === "connected" && server.tools.length);
  const versionOk = setup?.version && setup.version === setup.tested_version;
  const versionNote = setup?.worker && !versionOk ? ` · tested with ${setup.tested_version}` : "";

  const sidebarToggle = (
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
  );

  return (
    <div className="app" data-theme={theme}>
      <header className="topbar">
        {sidebarToggle}
        <div className="brand">
          <b>Glass</b>
          <span className="muted">for Mirror</span>
        </div>
        <span className="grow" />
        {!showSidebar && inbox.length > 0 && (
          <button type="button" className="btn ghost" data-state="attention" style={{ gap: 8, fontWeight: 400 }} onClick={() => setShowSidebar(true)}>
            <span className="sdot" />
            needs you · {inbox.length}
          </button>
        )}
        {bridge.inTauri && setup && (
          <span data-state={setup.worker ? "running" : "failed"} className="mono faint still worker-state" title={setup.worker ?? undefined}>
            <span className="sdot" />
            {setup.worker ? `mirror-agent ${setup.version ?? ""}${versionNote}` : "mirror-agent not found"}
          </span>
        )}
        <ThemeToggle theme={theme} onToggle={() => setTheme(theme === "dark" ? "cream" : "dark")} />
        <button type="button" className="icon-btn ghost" aria-label="Settings" title="Settings · ⌘," onClick={() => setSettings(true)}>
          <svg className="i gear" viewBox="0 0 24 24" aria-hidden="true">
            <path d="M10.3 2.6h3.4l.5 2.6a7.5 7.5 0 0 1 1.9 1.1l2.5-.9 1.7 2.9-2 1.7a7.6 7.6 0 0 1 0 2.2l2 1.7-1.7 2.9-2.5-.9a7.5 7.5 0 0 1-1.9 1.1l-.5 2.6h-3.4l-.5-2.6a7.5 7.5 0 0 1-1.9-1.1l-2.5.9-1.7-2.9 2-1.7a7.6 7.6 0 0 1 0-2.2l-2-1.7 1.7-2.9 2.5.9a7.5 7.5 0 0 1 1.9-1.1z" />
            <circle cx="12" cy="12" r="3" />
          </svg>
        </button>
        {bridge.inTauri && (
          <button
            type="button"
            className="icon-btn ghost"
            aria-label={showTerminal ? "Hide the terminal" : "Show the terminal"}
            aria-pressed={showTerminal}
            title={`${showTerminal ? "Hide" : "Show"} the terminal · ⌃\``}
            onClick={() => setShowTerminal(!showTerminal)}
          >
            <svg className="i" viewBox="0 0 16 16" aria-hidden="true">
              <rect x="2" y="3" width="12" height="10" rx="2" />
              <path d="M4.5 6.5 6.5 8l-2 1.5M8 10h3" />
            </svg>
          </button>
        )}
        {agent && !page && (
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
        )}
      </header>

      <div className="cols">
        {showSidebar && (
        <nav aria-label="Agents" className="sidebar scroll">
          {bridge.inTauri && (
            <button type="button" className="btn ghost new-agent-btn" aria-current={Boolean(page)} onClick={() => openNew()} title="An empty chat · ⌘K starts one without leaving this screen">
              <svg className="i" viewBox="0 0 16 16" aria-hidden="true">
                <path d="M8 3.5v9M3.5 8h9" />
              </svg>
              New agent
              <span className="kbd">⌘N</span>
            </button>
          )}
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
                onClick={() => {
                  setPage(null);
                  setSelected(owner.meta.id);
                }}
              >
                <span className="sdot" style={{ marginTop: 6 }} />
                <span className="lines">
                  <span className="mono" style={{ fontSize: 13 }}>
                    {toolLabel(item.name)} {toolSummary(item, owner.meta.workspace)}
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
                  {bridge.inTauri && (group.project || group.key === "no project") && (
                    <span className="project-actions">
                      {group.project && removing === group.key ? (
                        <button type="button" className="btn ghost confirm" onClick={() => removeProject(group.key)} onBlur={() => setRemoving(null)} autoFocus>
                          remove?
                        </button>
                      ) : (
                        group.project &&
                        !group.agents.some((member) => member.meta.live) && (
                          <button
                            type="button"
                            className="icon-btn ghost small"
                            aria-label={`Remove ${group.name} from the sidebar`}
                            title="Remove from the sidebar. Its folder is not touched."
                            onClick={() => setRemoving(group.key)}
                          >
                            <svg className="i" viewBox="0 0 16 16" aria-hidden="true">
                              <path d="M4.5 4.5l7 7M11.5 4.5l-7 7" />
                            </svg>
                          </button>
                        )
                      )}
                      <button
                        type="button"
                        className="icon-btn ghost small"
                        aria-label={`New agent in ${group.name}`}
                        title={group.project ? `New agent in ${group.name}` : "New chat with no project"}
                        onClick={() => openNew(group.project)}
                      >
                        <svg className="i" viewBox="0 0 16 16" aria-hidden="true">
                          <path d="M8 3.5v9M3.5 8h9" />
                        </svg>
                      </button>
                    </span>
                  )}
                </div>
                {!shut &&
                  group.agents.map((member) => (
                    <div key={member.meta.id} className="agent-item">
                    <button
                      type="button"
                      className="agent-row row fresh"
                      data-state={STATUS_DOT[member.status]}
                      aria-current={!page && member.meta.id === selected}
                      onClick={() => {
                        setPage(null);
                        setSelected(member.meta.id);
                      }}
                    >
                      <span className="sdot" />
                      <span className="lines">
                        <span className="title">{member.meta.title}</span>
                        <span className="mono faint">
                          {[member.meta.branch, member.meta.effort, STATUS_WORD[member.status]].filter(Boolean).join(" · ")}
                        </span>
                      </span>
                      {member.lastActive && <span className="mono faint ago">{ago(member.lastActive, clock)}</span>}
                    </button>
                    {member.meta.live && (
                      <button
                        type="button"
                        className="icon-btn ghost small agent-close"
                        aria-label={`Close ${member.meta.title}`}
                        title="Close agent: stop it and remove it from the sidebar. Its files stay."
                        onClick={() => closeAgent(member.meta.id)}
                      >
                        <svg className="i" viewBox="0 0 16 16" aria-hidden="true">
                          <path d="M4.5 4.5l7 7M11.5 4.5l-7 7" />
                        </svg>
                      </button>
                    )}
                    </div>
                  ))}
                {!shut && !group.agents.length && (
                  <button type="button" className="link-btn mono faint empty" onClick={() => openNew(group.project)}>
                    start an agent here
                  </button>
                )}
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
        </nav>
        )}

        <div className={`center${showTerminal && terminalDock === "right" ? " dock-right" : ""}`}>
        {agent && !page ? (
            <main className="main">
              <div className="main-head">
                <div className="title-row">
                  <h1>{agent.meta.title}</h1>
                  {agent.meta.live && (
                    <button
                      type="button"
                      className="btn ghost"
                      style={{ fontWeight: 400 }}
                      onClick={() => closeAgent(agent.meta.id)}
                      title="Stop the worker and remove this agent. Its files stay where they are."
                    >
                      close agent
                    </button>
                  )}
                </div>
                <span className="mono faint">
                  {[agent.meta.project, agent.meta.branch && `git ${agent.meta.branch}`, agent.meta.model].filter(Boolean).join(" · ")}
                </span>
              </div>

              <Transcript
                key={agent.meta.id}
                agent={agent}
                initialScroll={scrolls.current[agent.meta.id] ?? null}
                onScrollSave={(top) => (scrolls.current[agent.meta.id] = top)}
                onResolve={(callId, approved) => resolve(agent.meta.id, callId, approved)}
                onOpenFile={(path) => setFocusFile({ path, at: Date.now() })}
                onRewind={rewind}
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
                {Object.values(agent.tasks).some((task) => task.status === "running") && (
                  <div className="tasks">
                    {Object.values(agent.tasks)
                      .filter((task) => task.status === "running")
                      .map((task) => (
                        <div key={task.id} className="task-row mono" data-state="running">
                          <span className="sdot" />
                          <span className="grow">
                            {task.tool} · {task.display ?? "running"}
                          </span>
                          {agent.meta.live && (
                            <button
                              type="button"
                              className="btn ghost"
                              style={{ fontWeight: 400, height: 36 }}
                              onClick={() => bridge.cancelTask(agent.meta.id, task.id).catch((reason) => setError(String(reason)))}
                            >
                              cancel
                            </button>
                          )}
                        </div>
                      ))}
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
                <Composer
                  ref={composer}
                  value={draft}
                  onChange={setDraft}
                  onSubmit={send}
                  workspace={agent.meta.live ? agent.meta.workspace : null}
                  connections={connections}
                  disabled={!agent.meta.live || Boolean(agent.closedError)}
                  placeholder={
                    !agent.meta.live
                      ? "This agent cannot take messages."
                      : busy
                        ? "Message Mirror. It queues until the agent is ready."
                        : "Message Mirror. @ mentions a file"
                  }
                  tools={
                    <>
                      {agent.meta.live && (
                        <ModelPicker
                          hotkey={!launcher}
                          choice={{ api: agent.meta.api, model: agent.meta.model, baseUrl: agent.meta.baseUrl }}
                          keys={setup?.keys ?? []}
                          note="Applies from the agent's next turn."
                          onChange={changeAgentModel}
                        />
                      )}
                      <EffortMenu value={agent.meta.effort} onChange={changeEffort} disabled={!agent.meta.live} />
                      <ModeMenu value={agent.meta.mode} onChange={changeMode} disabled={!agent.meta.live} />
                    </>
                  }
                  actions={
                    <>
                      <span className="mono faint ctx-note" title="Context used">
                        {agent.ctx ? `${ctxPercent(agent.ctx)} ctx` : ""}
                      </span>
                      {busy && <Pill variant="line" small label="Stop" icon="cross" onClick={stop} />}
                      <Pill variant="dark" small label="Send" onClick={send} disabled={!agent.meta.live || !draft.trim()} />
                    </>
                  }
                />
              </div>
            </main>
        ) : (
          <main className="main empty-main scroll">
            {bridge.inTauri || import.meta.env.DEV || page ? (
              <div className="empty-stack">
                <SetupNotes setup={setup} choice={choice} />
                <NewAgent
                  key={page?.project?.path ?? "none"}
                  variant="page"
                  projects={projects}
                  initialProject={page ? page.project : (projects[0] ?? null)}
                  mainBusy={(project) => list.some((entry) => entry.meta.live && entry.meta.workspace === project.path && entry.status !== "stopped")}
                  choice={choice}
                  keys={setup?.keys ?? []}
                  effort={agent?.meta.effort ?? "high"}
                  mode={agent?.meta.live ? agent.meta.mode : "manual"}
                  blocked={setup && !setup.worker ? "Install Mirror first." : !bridge.inTauri ? "The browser build cannot start agents." : null}
                  onChoice={changeDefaultModel}
                  connections={connections}
          onPickFolder={pickProject}
                  onStart={(plan) => launch(plan, "page")}
                />
                {error && (
                  <div className="bar" data-state="failed">
                    <span className="sdot" />
                    <span className="bar-body">{error}</span>
                    <button type="button" className="btn ghost" style={{ fontWeight: 400 }} onClick={() => setError(null)}>
                      dismiss
                    </button>
                  </div>
                )}
              </div>
            ) : (
              <span className="muted">Press ⌘K to start an agent</span>
            )}
          </main>
        )}
        {bridge.inTauri && (
          <TerminalDrawer
            agentId={terminalTarget.id}
            cwd={terminalTarget.cwd}
            open={showTerminal}
            theme={theme}
            input={terminalInput}
            dock={terminalDock}
            onDock={(dock) => {
              setTerminalDock(dock);
              try {
                localStorage.setItem("glass.terminal.dock", dock);
              } catch {
                // Storage can be unavailable; the dock just will not persist.
              }
            }}
            onClose={() => setShowTerminal(false)}
          />
        )}
        </div>
        {agent && !page && showPanel && (
          <Panel
            agent={agent}
            focusFile={focusFile}
            race={agent.meta.race ? list.filter((entry) => entry.meta.race?.id === agent.meta.race!.id) : []}
            checks={checks}
            onSelectAgent={(id) => setSelected(id)}
            servers={servers}
            comments={reviews[agent.meta.id] ?? []}
            onComments={(comments) => setReviews((current) => ({ ...current, [agent.meta.id]: comments }))}
            onSendReview={async () => {
              const comments = reviews[agent.meta.id] ?? [];
              if (!comments.length) return;
              try {
                const id = await bridge.sendMessage(agent.meta.id, reviewMessage(comments));
                if (!id) update(agent.meta.id, (current) => ({ ...current, status: "starting" }));
                setReviews((current) => ({ ...current, [agent.meta.id]: [] }));
              } catch (reason) {
                setError(String(reason));
              }
            }}
          />
        )}
      </div>
      {settings && (
        <Settings
          setup={setup}
          choice={choice}
          keys={setup?.keys ?? []}
          servers={servers}
          theme={theme}
          onTheme={setTheme}
          onChoice={changeDefaultModel}
          onKeysChanged={() => bridge.checkSetup().then((found) => found && setSetup(found)).catch(() => {})}
          onClose={() => setSettings(false)}
        />
      )}
      {quitting && (
        <div className="veil" onMouseDown={(event) => event.target === event.currentTarget && setQuitting(false)}>
          <div role="alertdialog" aria-label="Quit Glass" className="launcher fresh quit">
            <div className="launcher-line" style={{ paddingTop: 20 }}>
              <span style={{ fontSize: 20, fontWeight: 350, letterSpacing: "-0.03em" }}>Quit while agents are working?</span>
            </div>
            <div className="launcher-meta" style={{ fontFamily: "var(--sans)", fontSize: 14, color: "var(--muted)" }}>
              Mirror's worker stops when Glass quits, so these agents stop mid-turn. Their transcripts are kept, and sending a message resumes each one.
            </div>
            <div className="launcher-foot">
              <button type="button" className="btn ghost" style={{ fontWeight: 400 }} onClick={() => setQuitting(false)}>
                Cancel
              </button>
              <Pill variant="dark" small label="Quit" onClick={() => bridge.quitApp()} />
            </div>
          </div>
        </div>
      )}
      {launcher && (
        <NewAgent
          variant="dialog"
          projects={projects}
          initialProject={launcherProject}
          mainBusy={(project) => list.some((entry) => entry.meta.live && entry.meta.workspace === project.path && entry.status !== "stopped")}
          choice={choice}
          keys={setup?.keys ?? []}
          effort={agent?.meta.effort ?? "high"}
          mode={agent?.meta.live ? agent.meta.mode : "manual"}
          blocked={setup && !setup.worker ? "Install Mirror first." : null}
          onChoice={changeDefaultModel}
          connections={connections}
          onPickFolder={pickProject}
          onStart={(plan) => launch(plan, "dialog")}
          onClose={() => setLauncher(false)}
        />
      )}
    </div>
  );
}
