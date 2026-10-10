import { useEffect, useRef, useState } from "react";
import { diffStat, relative, type AgentState, type Item } from "./agent";

type ToolItem = Extract<Item, { kind: "tool" }>;

const str = (value: unknown) => (typeof value === "string" ? value : "");

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
}) {
  return (
    <button
      type="button"
      className={`pill pill-${props.variant}${props.small ? " sm" : ""}`}
      onClick={props.onClick}
      disabled={props.disabled}
    >
      <span className="lbl">{props.label}</span>
      <span className="ico" aria-hidden="true">
        <span className="dot" />
        {props.icon === "cross" ? <Cross /> : <Arrow />}
      </span>
    </button>
  );
}

/** Unified diff lines, as the worker sent them. Headers are dropped. */
export function Diff({ text }: { text: string }) {
  const lines = text.replace(/\n$/, "").split("\n").filter((line) => !line.startsWith("---") && !line.startsWith("+++"));
  return (
    <div className="diff mono">
      {lines.map((line, index) => {
        const tone = line.startsWith("@@") ? "hunk" : line.startsWith("+") ? "add" : line.startsWith("-") ? "del" : "ctx";
        return (
          <div key={index} className={tone}>
            {line}
          </div>
        );
      })}
    </div>
  );
}

/** What an edit proposes, before the worker has produced its own diff. */
export function proposedDiff(item: ToolItem): string {
  const before = str(item.args.old_string).split("\n").map((line) => `-${line}`);
  const after = str(item.args.new_string).split("\n").map((line) => `+${line}`);
  return [...before, ...after].join("\n");
}

function toolPath(item: ToolItem, workspace: string): string {
  return relative(str(item.args.file_path) || str(item.args.path), workspace);
}

/** Short mono summary of a tool call: "bash · python3 -m unittest". */
export function toolSummary(item: ToolItem, workspace: string): string {
  switch (item.name) {
    case "bash":
      return str(item.args.command);
    case "read":
    case "write":
    case "edit":
    case "ls":
      return toolPath(item, workspace) || ".";
    case "grep":
    case "glob":
      return str(item.args.pattern);
    default:
      return Object.values(item.args).filter((value) => typeof value === "string").join(" · ");
  }
}

function approvalTitle(item: ToolItem, workspace: string): { title: string; action: string } {
  switch (item.name) {
    case "bash":
      return { title: `Mirror wants to run ${str(item.args.command)}`, action: "Approve command" };
    case "edit":
      return { title: `Mirror wants to edit ${toolPath(item, workspace)}`, action: "Approve edit" };
    case "write":
      return { title: `Mirror wants to write ${toolPath(item, workspace)}`, action: "Approve write" };
    default:
      return { title: `Mirror wants to use ${item.name}`, action: "Approve" };
  }
}

function ApprovalCard(props: {
  item: ToolItem;
  workspace: string;
  lockedTo: boolean | null;
  onResolve: (approved: boolean) => void;
}) {
  const { item, workspace } = props;
  const { title, action } = approvalTitle(item, workspace);
  let body = null;
  let stat = item.name;
  if (item.name === "edit") {
    const diff = proposedDiff(item);
    const { add, del } = diffStat(diff);
    stat = `edit · +${add} -${del}`;
    body = <Diff text={diff} />;
  } else if (item.name === "bash") {
    body = <div className="cmd mono">{str(item.args.command)}</div>;
  } else if (item.name === "write") {
    body = <div className="cmd mono">{str(item.args.content)}</div>;
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
        <Pill
          variant="line"
          label="Reject"
          icon="cross"
          onClick={() => props.onResolve(false)}
          disabled={props.lockedTo === true}
        />
        <span style={{ display: "flex", gap: 4 }}>
          <span className="kbd">A</span>
          <span className="kbd">R</span>
        </span>
        {props.lockedTo !== null && (
          <span className="mono faint">replay · following the {props.lockedTo ? "approved" : "rejected"} recording</span>
        )}
      </div>
    </section>
  );
}

/** Strip the worker's bookkeeping lines from bash output for display. */
function bashOutput(content: string): string {
  return content
    .replace(/^Exit code: -?\d+\n/, "")
    .replace(/^stderr:\n/m, "")
    .replace(/\n?\[Completed in [^\]]*\]\s*$/, "")
    .trim();
}

function ToolBlock({ item, workspace }: { item: ToolItem; workspace: string }) {
  const summary = toolSummary(item, workspace);
  const rejected = item.approval === "rejected";
  const result = item.result;
  const tail = rejected ? "rejected" : result && !result.success ? "failed" : null;

  if (item.name === "bash") {
    const exit = result?.exitCode;
    return (
      <div className="block">
        <div className="block-head mono">
          <span>
            <span className="faint">bash</span> · {summary}
          </span>
          <span className="faint">{tail ?? (exit != null ? `exit ${exit}` : result ? "" : "running")}</span>
        </div>
        {result && !rejected && bashOutput(result.content) && (
          <div className="block-body mono">{bashOutput(result.content)}</div>
        )}
      </div>
    );
  }

  if (item.name === "edit" && result?.display && !rejected) {
    const { add, del } = diffStat(result.display);
    return (
      <div className="block">
        <div className="block-head mono">
          <span>
            <span className="faint">edit</span> · {summary}
          </span>
          <span className="faint">
            +{add} -{del}
          </span>
        </div>
        <div style={{ borderTop: "1px solid var(--line)" }}>
          <Diff text={result.display} />
        </div>
      </div>
    );
  }

  return (
    <div className="oneline mono" style={{ display: "flex", justifyContent: "space-between", gap: 12 }}>
      <span>
        <span className="faint">{item.name}</span> · {summary}
      </span>
      {tail && <span className="faint">{tail}</span>}
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
  onResolve: (callId: string, approved: boolean) => void;
}) {
  const { agent } = props;
  const scroller = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);

  // Follow new output unless the user has scrolled up to read.
  useEffect(() => {
    const element = scroller.current;
    if (element && pinned.current) element.scrollTop = element.scrollHeight;
  }, [agent.items]);

  const onScroll = () => {
    const element = scroller.current;
    if (element) pinned.current = element.scrollHeight - element.scrollTop - element.clientHeight < 80;
  };

  const workspace = agent.meta.workspace;
  return (
    <div className="transcript scroll" ref={scroller} onScroll={onScroll}>
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
          case "tool":
            if (item.approval === "pending") {
              return (
                <ApprovalCard
                  key={item.id}
                  item={item}
                  workspace={workspace}
                  lockedTo={props.lockedTo}
                  onResolve={(approved) => props.onResolve(item.id, approved)}
                />
              );
            }
            return <ToolBlock key={item.id} item={item} workspace={workspace} />;
          case "notice":
            return (
              <div key={item.id} className="notice" data-state={item.tone === "fail" ? "failed" : "stopped"}>
                <span className="sdot" />
                <span>{item.text}</span>
              </div>
            );
        }
      })}
    </div>
  );
}
