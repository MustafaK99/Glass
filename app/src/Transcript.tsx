import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { relative, toolDiff, toolPath, type AgentState, type Item, type ToolItem } from "./agent";
import { openInEditor, inTauri } from "./bridge";
import { highlightBlock, languageFor } from "./highlight";
import { renderMarkdown } from "./markdown";
import { diffStat } from "./diff";
import { DiffView } from "./DiffView";

const str = (value: unknown) => (typeof value === "string" ? value : "");
const CLIP_LINES = 12;

export function Arrow() {
  return (
    <svg className="i" viewBox="0 0 16 16">
      <path className="dash" d="M2 8h10.5" />
      <path d="M9.5 4.5 13 8l-3.5 3.5" />
    </svg>
  );
}

export function Cross() {
  return (
    <svg className="i" viewBox="0 0 16 16">
      <path d="M4.5 4.5l7 7M11.5 4.5l-7 7" />
    </svg>
  );
}

export function Pill(props: {
  variant: "lime" | "line" | "dark";
  small?: boolean;
  label: string;
  icon?: "arrow" | "cross";
  onClick?: () => void;
  disabled?: boolean;
  title?: string;
}) {
  return (
    <button
      type="button"
      className={`pill pill-${props.variant}${props.small ? " sm" : ""}`}
      onClick={props.onClick}
      disabled={props.disabled}
      title={props.title}
    >
      <span className="lbl">{props.label}</span>
      <span className="ico" aria-hidden="true">
        <span className="dot" />
        {props.icon === "cross" ? <Cross /> : <Arrow />}
      </span>
    </button>
  );
}

/** Short mono summary of a tool call: "python3 -m unittest", "stats.py". */
/** An MCP tool's server and name, from Mirror's `mcp__<server>__<tool>`. */
export function mcpParts(name: string): { server: string; tool: string } | null {
  const match = /^mcp__(.+?)__(.+)$/.exec(name);
  return match ? { server: match[1], tool: match[2] } : null;
}

const NAMES: Record<string, string> = { save_memory: "memory", search_memory: "memory · search", web_search: "web · search", web_browse: "web · read" };

/** How a tool is named on screen: "bash", or "linear · create_issue" for MCP. */
export function toolLabel(name: string, args?: Record<string, unknown>): string {
  if (name === "save_memory") {
    const action = typeof args?.action === "string" ? args.action : "remember";
    return `memory · ${{ remember: "remembered", forget: "forgot", pin: "pinned", unpin: "unpinned" }[action] ?? action}`;
  }
  if (NAMES[name]) return NAMES[name];
  const mcp = mcpParts(name);
  return mcp ? `${mcp.server} · ${mcp.tool}` : name;
}

export function toolSummary(item: { name: string; args: Record<string, unknown> }, workspace: string): string {
  switch (item.name) {
    case "bash":
      return str(item.args.command);
    case "read":
    case "write":
    case "edit":
    case "ls":
      return relative(str(item.args.file_path) || str(item.args.path), workspace) || ".";
    case "grep":
    case "glob":
      return str(item.args.pattern) + (str(item.args.path) ? ` in ${relative(str(item.args.path), workspace)}` : "");
    case "subagent":
      return str(item.args.prompt).split("\n")[0].slice(0, 90);
    case "save_memory":
      return str(item.args.content) || str(item.args.key) || str(item.args.id);
    case "search_memory":
      return str(item.args.query) || (Array.isArray(item.args.paths) ? (item.args.paths as string[]).join(", ") : "");
    case "web_search":
      return str(item.args.query);
    case "web_browse":
      return str(item.args.url).replace(/^https?:\/\//, "") + (str(item.args.pattern) ? ` · ${str(item.args.pattern)}` : "");
    case "task":
      return [str(item.args.action), str(item.args.task_id)].filter(Boolean).join(" ");
    default:
      return Object.values(item.args).filter((value) => typeof value === "string").join(" · ");
  }
}

function approvalWords(item: ToolItem, workspace: string): { title: string; action: string } {
  const path = relative(toolPath(item), workspace);
  switch (item.name) {
    case "bash":
      return { title: `Mirror wants to run ${str(item.args.command)}`, action: "Approve command" };
    case "edit":
      return { title: `Mirror wants to edit ${path}`, action: "Approve edit" };
    case "write":
      return { title: `Mirror wants to write ${path}`, action: "Approve write" };
    default:
      return { title: `Mirror wants to use ${toolLabel(item.name)}`, action: mcpParts(item.name) ? "Approve tool" : "Approve" };
  }
}

function ApprovalCard(props: {
  item: ToolItem;
  workspace: string;
  files: Record<string, string>;
  onResolve: (approved: boolean) => void;
}) {
  const { item, workspace } = props;
  const { title, action } = approvalWords(item, workspace);
  let body;
  let stat = item.name;
  if (item.name === "edit" || item.name === "write") {
    const diff = toolDiff(item, props.files, workspace);
    const { add, del } = diffStat(diff);
    stat = `${item.name} · +${add} -${del}`;
    body = <DiffView diff={diff} path={toolPath(item)} numbers={false} hideHunks />;
  } else if (item.name === "bash") {
    body = <div className="cmd mono">{str(item.args.command)}</div>;
  } else {
    body = <div className="cmd mono">{JSON.stringify(item.args, null, 2)}</div>;
  }
  return (
    <section aria-label="Approval needed" className="approval fresh">
      <div className="approval-head">
        <span data-state="attention">
          <span className="sdot" />
          {title}
        </span>
        <span className="mono faint">{stat}</span>
      </div>
      <div className="approval-body">{body}</div>
      <div className="approval-actions">
        <Pill variant="lime" label={action} onClick={() => props.onResolve(true)} title={`${action} · A`} />
        <Pill variant="line" label="Reject" icon="cross" onClick={() => props.onResolve(false)} title="Reject · R" />
        <span className="mono faint">
          <span className="kbd">A</span> approve · <span className="kbd">R</span> reject
        </span>
      </div>
    </section>
  );
}

/** Drop the worker's bookkeeping lines from bash output. */
function bashOutput(content: string): string {
  return content
    .replace(/^Exit code: -?\d+\n/, "")
    .replace(/^stderr:\n/m, "")
    .replace(/\n?\[Completed in [^\]]*\]\s*$/, "")
    .trim();
}

function Output({ text }: { text: string }) {
  const [all, setAll] = useState(false);
  const lines = text.split("\n");
  const clipped = !all && lines.length > CLIP_LINES;
  // The end of a command's output is where the verdict is, so clip from the top.
  return (
    <div className="block-body mono">
      {lines.length > CLIP_LINES && (
        <button type="button" className="show-all mono" onClick={() => setAll(!all)}>
          {all ? "show less" : `show all · ${lines.length} lines`}
        </button>
      )}
      {clipped ? lines.slice(-CLIP_LINES).join("\n") : text}
    </div>
  );
}

function ToolBlock(props: { item: ToolItem; workspace: string; files: Record<string, string>; onOpenFile: (path: string) => void }) {
  const { item, workspace } = props;
  const summary = toolSummary(item, workspace);
  const result = item.result;
  const rejected = item.approval === "rejected";

  if (item.name === "bash" && !rejected) {
    const output = result ? bashOutput(result.content) : "";
    return (
      <div className="block">
        <div className="block-head mono">
          <span>
            <span className="faint">bash</span> · {summary}
          </span>
          <span className="faint">
            {result ? (result.exitCode != null ? `exit ${result.exitCode}` : result.success ? "" : "failed") : "running"}
          </span>
        </div>
        {output && <Output text={output} />}
      </div>
    );
  }

  // Edits are one quiet line. The diff lives in the changes panel; click to open it.
  if ((item.name === "edit" || item.name === "write") && !rejected) {
    const done = result?.success;
    const { add, del } = diffStat(toolDiff(item, props.files, workspace));
    return (
      <button type="button" className="oneline row-link mono" onClick={() => props.onOpenFile(toolPath(item))} disabled={!done}>
        <span>
          <span className="faint">{toolLabel(item.name, item.args)}</span> · {summary}
        </span>
        <span className="faint">
          {!result ? "running" : done ? `${item.approval === "approved" ? "approved · " : ""}+${add} -${del}` : "failed"}
        </span>
      </button>
    );
  }

  // Read-only tools: one line that opens to show what they found.
  if (result && !rejected && (EXPANDABLE.has(item.name) || mcpParts(item.name)) && (result.success || mcpParts(item.name))) {
    return <Expandable item={item} summary={summary} />;
  }

  let tail: string | null = null;
  if (item.name === "subagent" && result?.success) tail = "running in the background";
  if (rejected) tail = item.name === "edit" || item.name === "write" ? "rejected · nothing changed" : "rejected";
  else if (result && !result.success) tail = "failed";
  return (
    <div className="oneline mono">
      <span>
        <span className="faint">{toolLabel(item.name, item.args)}</span> · {summary}
      </span>
      {tail && <span className="faint">{tail}</span>}
    </div>
  );
}

const EXPANDABLE = new Set(["read", "grep", "glob", "ls", "task", "web_search", "web_browse", "save_memory", "search_memory"]);

/** "9 lines", "2 files", "3 entries": what a read-only tool found, for its line. */
function found(item: ToolItem): string {
  const content = item.result?.content ?? "";
  const lines = content ? content.replace(/\n$/, "").split("\n") : [];
  switch (item.name) {
    case "read":
      return `${lines.length} line${lines.length === 1 ? "" : "s"}`;
    case "glob":
      return lines.length ? `${lines.length} file${lines.length === 1 ? "" : "s"}` : "no files";
    case "ls":
      return `${lines.length} entr${lines.length === 1 ? "y" : "ies"}`;
    case "grep": {
      const header = /^Found (\d+) (\w+)/.exec(content);
      return header ? `${header[1]} ${header[2]}` : lines.length ? `${lines.length} lines` : "no matches";
    }
    case "web_search":
      return "results";
    case "save_memory":
      return item.result?.success ? "saved" : "not saved";
    case "search_memory":
      return content.match(/^(\d+) matching/)?.[1] ? `${content.match(/^(\d+) matching/)![1]} found` : "searched";
    case "web_browse":
      return `${lines.length} lines`;
    default:
      if (mcpParts(item.name)) return item.result?.success ? `${lines.length} line${lines.length === 1 ? "" : "s"}` : "failed";
      return "";
  }
}

function Expandable({ item, summary }: { item: ToolItem; summary: string }) {
  const [open, setOpen] = useState(false);
  const content = item.result?.content ?? "";
  let body = item.name === "grep" ? content.replace(/^Found \d+ \w+\n/, "") : content;
  let language = item.name === "read" ? languageFor(toolPath(item)) : null;
  // MCP tools often answer in JSON; show it indented and coloured.
  if (mcpParts(item.name) && /^\s*[[{]/.test(content)) {
    try {
      body = JSON.stringify(JSON.parse(content), null, 2);
      language = "json";
    } catch {
      // Not JSON after all; show it as text.
    }
  }
  return (
    <div className={open ? "block" : undefined}>
      <button type="button" className={`oneline row-link mono${open ? " open" : ""}`} aria-expanded={open} onClick={() => setOpen(!open)}>
        <span>
          <span className="faint">{toolLabel(item.name, item.args)}</span> · {summary || "."}
        </span>
        <span className="faint expand-tail">
          {found(item)}
          <svg className="i chev-expand" viewBox="0 0 16 16" aria-hidden="true">
            <path d="M4.5 6.5 8 10l3.5-3.5" />
          </svg>
        </span>
      </button>
      {open &&
        (language ? (
          <pre className="block-body mono hl code-view" dangerouslySetInnerHTML={{ __html: highlightBlock(body, language) }} />
        ) : (
          <Output text={body || "(empty)"} />
        ))}
    </div>
  );
}

function Draft({ item, workspace }: { item: Extract<Item, { kind: "draft" }>; workspace: string }) {
  let args: Record<string, unknown> = {};
  try {
    args = JSON.parse(item.arguments);
  } catch {
    // Still arriving.
  }
  const summary = toolSummary({ name: item.name, args }, workspace);
  return (
    <div className="oneline mono" data-state="running">
      <span>
        <span className="faint">{item.name ? toolLabel(item.name) : "tool"}</span>
        {summary ? ` · ${summary}` : ""}
      </span>
      <span className="faint still" style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span className="sdot" style={{ animation: undefined }} />
        writing
      </span>
    </div>
  );
}

/** Copy text, and say so on the button for a moment. */
function copyFrom(button: HTMLElement, text: string) {
  navigator.clipboard?.writeText(text).then(
    () => {
      const label = button.textContent;
      button.textContent = "copied";
      setTimeout(() => (button.textContent = label), 1200);
    },
    () => {},
  );
}

/** Markdown, with links opened in the person's browser rather than in the app. */
function Markdown({ text, className }: { text: string; className: string }) {
  const onClick = (event: React.MouseEvent) => {
    const copy = (event.target as HTMLElement).closest<HTMLElement>("[data-copy]");
    if (copy) {
      event.preventDefault();
      copyFrom(copy, copy.parentElement?.querySelector("code")?.textContent ?? "");
      return;
    }
    const link = (event.target as HTMLElement).closest("a");
    if (!link?.href) return;
    event.preventDefault();
    if (inTauri && /^https?:/.test(link.href)) openInEditor(link.href);
  };
  return <div className={`md-body ${className}`} onClick={onClick} dangerouslySetInnerHTML={{ __html: renderMarkdown(text) }} />;
}

/**
 * The model's reasoning, as Mirror streams it. One quiet line, collapsed: while it
 * streams, the line shows the latest thought; afterwards, how long it took.
 */
function Reasoning({ text, effort, streaming }: { text: string; effort: string; streaming: boolean }) {
  const [open, setOpen] = useState(false);
  const started = useRef(streaming ? Date.now() : null);
  const [seconds, setSeconds] = useState<number | null>(null);
  useEffect(() => {
    if (!streaming && started.current && seconds == null) setSeconds(Math.max(1, Math.round((Date.now() - started.current) / 1000)));
  }, [streaming, seconds]);
  const latest = text.trim().split("\n").filter(Boolean).pop() ?? "";
  return (
    <div className="reasoning" data-open={open} data-streaming={streaming}>
      <button type="button" className="mono" aria-expanded={open} onClick={() => setOpen(!open)}>
        <svg className="i" viewBox="0 0 16 16" aria-hidden="true">
          <path d="M6 4l4 4-4 4" />
        </svg>
        <span>
          reasoning · {effort}
          {streaming ? " · thinking" : seconds != null ? ` · ${seconds}s` : ""}
        </span>
        {streaming && !open && latest && <span className="reasoning-peek">{latest}</span>}
      </button>
      {open && <Markdown text={text} className="reasoning-text" />}
    </div>
  );
}

function duration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return minutes < 60 ? `${minutes}m ${seconds % 60}s` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

/** Your message, with a rewind control: the agent forgets it and everything after. */
function UserMessage(props: { id: string; text: string; canRewind: boolean; onRewind: (id: string, text: string, restoreFiles: boolean) => void }) {
  const [asking, setAsking] = useState(false);
  const [files, setFiles] = useState(true);
  return (
    <div className="user-wrap">
      <div className="bubble">{props.text}</div>
      {props.canRewind && !asking && (
        <button type="button" className="copy-btn rewind-btn" onClick={() => setAsking(true)} title="Rewind to before this message">
          rewind
        </button>
      )}
      {asking && (
        <div className="rewind-ask fresh">
          <span>Rewind to before this message? Mirror forgets it and everything after; the message comes back to the box to edit.</span>
          <label className="mono">
            <input type="checkbox" checked={files} onChange={(event) => setFiles(event.target.checked)} />
            also put the files back as they were
          </label>
          <span className="rewind-actions">
            <button type="button" className="btn ghost" style={{ fontWeight: 400 }} onClick={() => setAsking(false)}>
              Cancel
            </button>
            <button
              type="button"
              className="btn"
              onClick={() => {
                setAsking(false);
                props.onRewind(props.id, props.text, files);
              }}
            >
              Rewind
            </button>
          </span>
        </div>
      )}
    </div>
  );
}

interface EntryProps {
  item: Item;
  workspace: string;
  files: Record<string, string>;
  effort: string;
  onResolve: (callId: string, approved: boolean) => void;
  onOpenFile: (path: string) => void;
  /** Null while the agent is working: rewinding needs a quiet agent. */
  onRewind: ((id: string, text: string, restoreFiles: boolean) => void) | null;
}

/**
 * One transcript entry. Memoised: the reducer keeps unchanged items identical,
 * so while text streams only the streaming entry renders again.
 */
const Entry = memo(function Entry({ item, workspace, files, effort, onResolve, onOpenFile, onRewind }: EntryProps) {
  switch (item.kind) {
    case "user":
      return <UserMessage id={item.id} text={item.text} canRewind={Boolean(onRewind)} onRewind={(id, text, restore) => onRewind?.(id, text, restore)} />;
    case "reasoning":
      return <Reasoning text={item.text} effort={effort} streaming={item.streaming} />;
    case "text":
      return (
        <div className="say-wrap">
          <Markdown text={item.text} className={`say${item.streaming ? " streaming" : ""}`} />
          {!item.streaming && (
            <button type="button" className="copy-btn say-copy" onClick={(event) => copyFrom(event.currentTarget, item.text)}>
              copy
            </button>
          )}
        </div>
      );
    case "setup":
      return (
        <div className="block" data-state={item.status === "running" ? "running" : item.status === "done" ? "done" : "failed"}>
          <div className="block-head mono">
            <span>
              <span className="faint">setup</span> · {item.command}
            </span>
            <span className="faint">
              {item.status === "running" ? "running before the agent starts" : item.status === "done" ? `done${item.seconds ? ` · ${item.seconds}s` : ""}` : `failed${item.exitCode != null ? ` · exit ${item.exitCode}` : ""} · the agent starts anyway`}
            </span>
          </div>
          {item.tail && item.status !== "running" && <Output text={item.tail} />}
        </div>
      );
    case "summary":
      return (
        <div className="turn-summary mono faint">
          <span>
            {item.outcome === "stopped" ? "stopped" : "worked"}
            {item.seconds !== null ? ` ${item.outcome === "stopped" ? "after" : "for"} ${duration(item.seconds)}` : ""}
            {item.tokens ? ` · ${item.tokens >= 1000 ? `${(item.tokens / 1000).toFixed(1)}K` : item.tokens} tokens` : ""}
          </span>
          {item.files.map((file) => (
            <button key={file.path} type="button" className="turn-file" onClick={() => onOpenFile(file.path)} title="Open the diff">
              {relative(file.path, workspace)} <span className="add">+{file.add}</span> <span className="del">-{file.del}</span>
            </button>
          ))}
        </div>
      );
    case "draft":
      return <Draft item={item} workspace={workspace} />;
    case "tool":
      if (item.approval === "pending") {
        return <ApprovalCard item={item} workspace={workspace} files={files} onResolve={(approved) => onResolve(item.id, approved)} />;
      }
      return <ToolBlock item={item} workspace={workspace} files={files} onOpenFile={onOpenFile} />;
    case "notice":
      return item.tone === "quiet" ? (
        <div className="oneline mono faint">{item.text}</div>
      ) : (
        <div className="notice" data-state="failed">
          <span className="sdot" />
          <span className="notice-body">
            <span>{item.text}</span>
            {item.lines.length > 0 && <span className="mono faint stderr">{item.lines.join("\n")}</span>}
          </span>
        </div>
      );
  }
});

export function Transcript(props: {
  agent: AgentState;
  initialScroll: number | null;
  onScrollSave: (top: number) => void;
  onResolve: (callId: string, approved: boolean) => void;
  onOpenFile: (path: string) => void;
  onRewind?: (id: string, text: string, restoreFiles: boolean) => void;
}) {
  const { agent } = props;
  const scroller = useRef<HTMLDivElement>(null);
  const pinned = useRef(props.initialScroll == null);
  // New output arrived while the person was reading further up.
  const [behind, setBehind] = useState(false);
  // Stable callbacks, so memoised entries are not redrawn by a parent render.
  const latest = useRef(props);
  latest.current = props;
  const onResolve = useCallback((callId: string, approved: boolean) => latest.current.onResolve(callId, approved), []);
  const onOpenFile = useCallback((path: string) => latest.current.onOpenFile(path), []);
  const rewind = useCallback((id: string, text: string, restore: boolean) => latest.current.onRewind?.(id, text, restore), []);
  const quiet = agent.meta.live && Boolean(props.onRewind) && (agent.status === "done" || agent.status === "stopped" || agent.status === "idle" || agent.status === "failed");

  // Restore where the person was when they last looked at this agent.
  useLayoutEffect(() => {
    const element = scroller.current;
    if (!element) return;
    element.scrollTop = props.initialScroll ?? element.scrollHeight;
    // Only on mount: each agent gets its own Transcript.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Follow new output unless the person has scrolled up to read.
  useLayoutEffect(() => {
    const element = scroller.current;
    if (element && pinned.current) element.scrollTop = element.scrollHeight;
    else if (element) setBehind(true);
  }, [agent.items]);

  const jump = () => {
    const element = scroller.current;
    if (!element) return;
    pinned.current = true;
    setBehind(false);
    element.scrollTo({ top: element.scrollHeight, behavior: "smooth" });
  };

  const onScroll = () => {
    const element = scroller.current;
    if (!element) return;
    pinned.current = element.scrollHeight - element.scrollTop - element.clientHeight < 80;
    if (pinned.current) setBehind(false);
    props.onScrollSave(element.scrollTop);
  };

  const workspace = agent.meta.workspace;
  return (
    <div className="transcript-wrap">
    {behind && (
      <button type="button" className="jump-latest mono" onClick={jump}>
        <svg className="i" viewBox="0 0 16 16" aria-hidden="true">
          <path d="M8 3v9.5M4 9l4 4 4-4" />
        </svg>
        latest
      </button>
    )}
    <div className="transcript scroll" ref={scroller} onScroll={onScroll}>
      {agent.items.map((item) => (
        <div key={item.id} className="entry">
          <Entry
            item={item}
            workspace={workspace}
            files={item.kind === "tool" ? agent.files : NO_FILES}
            effort={agent.meta.effort}
            onResolve={onResolve}
            onOpenFile={onOpenFile}
            onRewind={quiet ? rewind : null}
          />
        </div>
      ))}
      {agent.status === "starting" && (
        <div className="oneline mono faint" data-state="running">
          starting mirror-agent
        </div>
      )}
    </div>
    </div>
  );
}

const NO_FILES: Record<string, string> = {};
