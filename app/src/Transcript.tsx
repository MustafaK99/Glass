import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { relative, toolDiff, toolPath, type AgentState, type Item, type ToolItem } from "./agent";
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
      return str(item.args.pattern);
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
      return { title: `Mirror wants to use ${item.name}`, action: "Approve" };
  }
}

function ApprovalCard(props: {
  item: ToolItem;
  agent: AgentState;
  lockedTo: boolean | null;
  onResolve: (approved: boolean) => void;
}) {
  const { item, agent } = props;
  const workspace = agent.meta.workspace;
  const { title, action } = approvalWords(item, workspace);
  let body;
  let stat = item.name;
  if (item.name === "edit" || item.name === "write") {
    const diff = toolDiff(item, agent.files, workspace);
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
        <Pill variant="lime" label={action} onClick={() => props.onResolve(true)} disabled={props.lockedTo === false} />
        <Pill variant="line" label="Reject" icon="cross" onClick={() => props.onResolve(false)} disabled={props.lockedTo === true} />
        <span className="mono faint">
          <span className="kbd">A</span> approve · <span className="kbd">R</span> reject
        </span>
        {props.lockedTo !== null && (
          <span className="mono faint">replay · following the {props.lockedTo ? "approved" : "rejected"} recording</span>
        )}
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

function ToolBlock(props: { item: ToolItem; agent: AgentState; onOpenFile: (path: string) => void }) {
  const { item, agent } = props;
  const workspace = agent.meta.workspace;
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
    const { add, del } = diffStat(toolDiff(item, agent.files, workspace));
    return (
      <button type="button" className="oneline row-link mono" onClick={() => props.onOpenFile(toolPath(item))} disabled={!done}>
        <span>
          <span className="faint">{item.name}</span> · {summary}
        </span>
        <span className="faint">
          {!result ? "running" : done ? `${item.approval === "approved" ? "approved · " : ""}+${add} -${del}` : "failed"}
        </span>
      </button>
    );
  }

  let tail: string | null = null;
  if (rejected) tail = item.name === "edit" || item.name === "write" ? "rejected · nothing changed" : "rejected";
  else if (result && !result.success) tail = "failed";
  return (
    <div className="oneline mono">
      <span>
        <span className="faint">{item.name}</span> · {summary}
      </span>
      {tail && <span className="faint">{tail}</span>}
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
        <span className="faint">{item.name || "tool"}</span>
        {summary ? ` · ${summary}` : ""}
      </span>
      <span className="faint still" style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span className="sdot" style={{ animation: undefined }} />
        writing
      </span>
    </div>
  );
}

function Reasoning({ text, effort, streaming }: { text: string; effort: string; streaming: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="reasoning" data-open={open}>
      <button type="button" className="mono" aria-expanded={open} onClick={() => setOpen(!open)}>
        <svg className="i" viewBox="0 0 16 16" aria-hidden="true">
          <path d="M6 4l4 4-4 4" />
        </svg>
        reasoning · {effort}
        {streaming ? " · thinking" : ""}
      </button>
      {open && <p>{text}</p>}
    </div>
  );
}

export function Transcript(props: {
  agent: AgentState;
  lockedTo: boolean | null;
  initialScroll: number | null;
  onScrollSave: (top: number) => void;
  onResolve: (callId: string, approved: boolean) => void;
  onOpenFile: (path: string) => void;
}) {
  const { agent } = props;
  const scroller = useRef<HTMLDivElement>(null);
  const pinned = useRef(props.initialScroll == null);

  // Restore where the person was when they last looked at this agent.
  useLayoutEffect(() => {
    const element = scroller.current;
    if (!element) return;
    element.scrollTop = props.initialScroll ?? element.scrollHeight;
    // Only on mount: each agent gets its own Transcript.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Follow new output unless the person has scrolled up to read.
  useEffect(() => {
    const element = scroller.current;
    if (element && pinned.current) element.scrollTop = element.scrollHeight;
  }, [agent.items]);

  const onScroll = () => {
    const element = scroller.current;
    if (!element) return;
    pinned.current = element.scrollHeight - element.scrollTop - element.clientHeight < 80;
    props.onScrollSave(element.scrollTop);
  };

  const workspace = agent.meta.workspace;
  return (
    <div className="transcript scroll" ref={scroller} onScroll={onScroll}>
      {agent.items.length === 0 && agent.status !== "starting" && (
        <span className="muted">Describe the task. Enter starts the agent.</span>
      )}
      {agent.items.map((item) => {
        switch (item.kind) {
          case "user":
            return (
              <div key={item.id} className="bubble">
                {item.text}
              </div>
            );
          case "reasoning":
            return <Reasoning key={item.id} text={item.text} effort={agent.meta.effort} streaming={item.streaming} />;
          case "text":
            return (
              <p key={item.id} className="say">
                {item.text}
              </p>
            );
          case "draft":
            return <Draft key={item.id} item={item} workspace={workspace} />;
          case "tool":
            if (item.approval === "pending") {
              return (
                <ApprovalCard
                  key={item.id}
                  item={item}
                  agent={agent}
                  lockedTo={props.lockedTo}
                  onResolve={(approved) => props.onResolve(item.id, approved)}
                />
              );
            }
            return <ToolBlock key={item.id} item={item} agent={agent} onOpenFile={props.onOpenFile} />;
          case "notice":
            return item.tone === "quiet" ? (
              <div key={item.id} className="oneline mono faint">
                {item.text}
              </div>
            ) : (
              <div key={item.id} className="notice" data-state="failed">
                <span className="sdot" />
                <span className="notice-body">
                  <span>{item.text}</span>
                  {item.lines.length > 0 && <span className="mono faint stderr">{item.lines.join("\n")}</span>}
                </span>
              </div>
            );
        }
      })}
      {agent.status === "starting" && (
        <div className="oneline mono faint" data-state="running">
          starting mirror-agent
        </div>
      )}
    </div>
  );
}
