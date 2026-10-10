import { useEffect, useMemo, useState } from "react";
import { changes as reportedChanges, relative, type AgentState } from "./agent";
import { commitChanges, inTauri, openInEditor, workspaceChanges, type GitChanges } from "./bridge";
import { DiffView } from "./DiffView";
import type { Row } from "./diff";
import type { ReviewComment } from "./review";

interface Entry {
  path: string;
  status: string;
  diffs: string[];
  add: number;
  del: number;
  proposed: boolean;
  binary: boolean;
}

const LETTER: Record<string, string> = { modified: "M", added: "A", deleted: "D", renamed: "R", untracked: "U", proposed: "P", edited: "M" };
const CONTEXTS: [string, number][] = [["3 lines", 3], ["10 lines", 10], ["whole file", 100000]];

function load<T extends string>(key: string, fallback: T, allowed: readonly T[]): T {
  try {
    const value = localStorage.getItem(key) as T | null;
    return value && allowed.includes(value) ? value : fallback;
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

/** Bumps whenever a tool result or a turn end could have changed files. */
function changeVersion(agent: AgentState): string {
  const results = agent.items.filter((item) => item.kind === "tool" && item.result).length;
  return `${results}:${agent.status}`;
}

/**
 * The changes panel. Live agents read their workspace from git, so it shows
 * edits made any way. A folder without git shows the edits
 * the agent reported. Proposed edits waiting on the person always come first.
 */
/** Commit the workspace, and optionally push and open a pull request with gh. */
function CommitForm(props: { agent: AgentState; git: GitChanges; files: { path: string; add: number; del: number }[]; onDone: () => void }) {
  const [open, setOpen] = useState(false);
  const [message, setMessage] = useState(props.agent.meta.title);
  const onBranch = props.git.branch !== "main" && props.git.branch !== "master" && props.git.branch !== "HEAD";
  const [pullRequest, setPullRequest] = useState(onBranch);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ text: string; url: string | null; failed: boolean } | null>(null);
  const body = [
    props.agent.meta.title,
    "",
    ...props.files.map((file) => `- ${file.path} (+${file.add} -${file.del})`),
    "",
    `Made by Mirror (${props.agent.meta.model}), reviewed in Glass.`,
  ].join("\n");

  const submit = async () => {
    setBusy(true);
    try {
      const done = await commitChanges(props.agent.meta.workspace, message, pullRequest ? message.split("\n")[0] : null, pullRequest ? body : null);
      setResult({ text: `Committed ${done.sha} on ${done.branch}${done.pull_request ? " and opened a pull request" : ""}.`, url: done.pull_request, failed: false });
      setOpen(false);
      props.onDone();
    } catch (reason) {
      setResult({ text: String(reason), url: null, failed: true });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="commit">
      {!open && (
        <button type="button" className="btn" onClick={() => (setOpen(true), setResult(null))}>
          Commit…
        </button>
      )}
      {open && (
        <form
          className="commit-form"
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          <textarea className="field" rows={2} value={message} onChange={(event) => setMessage(event.target.value)} aria-label="Commit message" />
          <label className="mono" title={onBranch ? undefined : "Pull requests need the agent's own branch"}>
            <input type="checkbox" checked={pullRequest} disabled={!onBranch} onChange={(event) => setPullRequest(event.target.checked)} />
            {onBranch ? `push ${props.git.branch} and open a pull request` : `on ${props.git.branch}: commit only`}
          </label>
          <span className="commit-actions">
            <button type="button" className="btn ghost" style={{ fontWeight: 400 }} onClick={() => setOpen(false)}>
              Cancel
            </button>
            <button type="submit" className="btn" disabled={busy || !message.trim()}>
              {busy ? "Working…" : pullRequest ? "Commit and open PR" : "Commit"}
            </button>
          </span>
        </form>
      )}
      {result && (
        <span className={`mono ${result.failed ? "key-error" : "faint"}`}>
          {result.text}{" "}
          {result.url && (
            <button type="button" className="link-btn mono" onClick={() => openInEditor(result.url!)}>
              open the pull request
            </button>
          )}
        </span>
      )}
    </div>
  );
}

/** The comment being written under a line. */
function CommentEditor(props: { onSave: (body: string) => void; onCancel: () => void }) {
  const [body, setBody] = useState("");
  return (
    <div className="comment-edit" onClick={(event) => event.stopPropagation()}>
      <textarea
        autoFocus
        rows={2}
        value={body}
        placeholder="What should change here?"
        onChange={(event) => setBody(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && body.trim()) props.onSave(body);
          if (event.key === "Escape") {
            event.stopPropagation();
            props.onCancel();
          }
        }}
      />
      <span className="comment-actions">
        <span className="mono faint">⌘↵ add</span>
        <button type="button" className="btn ghost" style={{ fontWeight: 400, height: 34 }} onClick={props.onCancel}>
          Cancel
        </button>
        <button type="button" className="btn" style={{ height: 34 }} disabled={!body.trim()} onClick={() => props.onSave(body)}>
          Add comment
        </button>
      </span>
    </div>
  );
}

export function Changes(props: {
  agent: AgentState;
  selected: string | null;
  onSelect: (path: string) => void;
  wide: boolean;
  comments: ReviewComment[];
  onComments: (comments: ReviewComment[]) => void;
  onSendReview: () => void;
}) {
  const [writing, setWriting] = useState<{ path: string; line: number; side: "new" | "old"; code: string } | null>(null);
  const { agent } = props;
  const workspace = agent.meta.workspace;
  const live = inTauri && agent.meta.live;
  const [git, setGit] = useState<GitChanges | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [layout, setLayout] = useState(() => load("glass.diff.layout", "unified", ["unified", "split"] as const));
  const [context, setContext] = useState(() => Number(load("glass.diff.context", "3", ["3", "10", "100000"] as const)));
  const [wrap, setWrap] = useState(() => load("glass.diff.wrap", "off", ["on", "off"] as const) === "on");
  // Bumped after a commit, so the list reloads at once.
  const [committed, setCommitted] = useState(0);
  const version = `${changeVersion(agent)}:${committed}`;

  useEffect(() => {
    if (!live) return;
    let cancelled = false;
    workspaceChanges(workspace, context)
      .then((found) => {
        if (cancelled) return;
        setGit(found);
        setError(null);
      })
      .catch((reason) => !cancelled && setError(String(reason)));
    return () => {
      cancelled = true;
    };
  }, [live, workspace, context, version]);

  const entries = useMemo<Entry[]>(() => {
    const reported = reportedChanges(agent);
    const proposed: Entry[] = reported
      .filter((file) => file.proposed)
      .map((file) => ({
        path: relative(file.path, workspace),
        status: "proposed",
        diffs: file.diffs.filter((entry) => entry.proposed).map((entry) => entry.diff),
        add: file.add,
        del: file.del,
        proposed: true,
        binary: false,
      }));
    if (live && git?.git) {
      return [
        ...proposed,
        ...git.files.map((file) => ({ path: file.path, status: file.status, diffs: file.diff ? [file.diff] : [], add: file.add, del: file.del, proposed: false, binary: file.binary })),
      ];
    }
    return [
      ...proposed,
      ...reported
        .filter((file) => !file.proposed)
        .map((file) => ({
          path: relative(file.path, workspace),
          status: "edited",
          diffs: file.diffs.map((entry) => entry.diff),
          add: file.add,
          del: file.del,
          proposed: false,
          binary: false,
        })),
    ];
  }, [agent, git, live, workspace]);

  const selectedPath = props.selected ? relative(props.selected, workspace) : null;
  const current = entries.find((entry) => entry.path === selectedPath) ?? entries[0];
  const proposedCount = entries.filter((entry) => entry.proposed).length;
  const changed = entries.length - proposedCount;
  const rejected = agent.items.filter((item) => item.kind === "tool" && item.approval === "rejected" && (item.name === "edit" || item.name === "write")).length;

  let title = "No changes";
  if (proposedCount) title = `${proposedCount} edit${proposedCount > 1 ? "s" : ""} proposed`;
  else if (changed) title = `${changed} file${changed > 1 ? "s" : ""} changed`;
  let note = "";
  if (proposedCount) note = "waiting on you";
  else if (live && git?.git) note = changed ? `vs ${git.base}` : `${git.branch} is clean`;
  else if (rejected) note = `${rejected} rejected · nothing changed`;
  else if (live && git && !git.git) note = "no git";

  const split = props.wide && layout === "split";
  const many = entries.length > 1;
  const sideList = props.wide && many;

  const list = many && (
    <div className={`file-list${sideList ? " side" : ""}`}>
      {entries.map((entry) => (
        <button
          key={`${entry.status}-${entry.path}`}
          type="button"
          className="file-row row mono"
          aria-current={entry === current}
          onClick={() => props.onSelect(entry.path)}
          title={entry.path}
        >
          <span className="file-name">
            <span className={`status-letter s-${entry.status}`}>{LETTER[entry.status] ?? "?"}</span>
            <span className="path">{entry.path}</span>
          </span>
          <span className="faint">
            +{entry.add} -{entry.del}
          </span>
        </button>
      ))}
    </div>
  );

  const anchorOf = (path: string, row: Row) =>
    row.new != null ? { path, line: row.new, side: "new" as const, code: row.text } : row.old != null ? { path, line: row.old, side: "old" as const, code: row.text } : null;
  const commenting = agent.meta.live && !split;
  const afterLine = (path: string) => (row: Row) => {
    const anchor = anchorOf(path, row);
    if (!anchor) return null;
    const here = props.comments.filter((comment) => comment.path === path && comment.line === anchor.line && comment.side === anchor.side);
    const open = writing && writing.path === path && writing.line === anchor.line && writing.side === anchor.side;
    if (!here.length && !open) return null;
    return (
      <div className="line-comments">
        {here.map((comment) => (
          <div key={comment.id} className="line-comment">
            <span>{comment.body}</span>
            <button type="button" className="link-btn mono faint" onClick={() => props.onComments(props.comments.filter((entry) => entry.id !== comment.id))}>
              remove
            </button>
          </div>
        ))}
        {open && (
          <CommentEditor
            onCancel={() => setWriting(null)}
            onSave={(body) => {
              props.onComments([...props.comments, { ...anchor, id: `${Date.now()}`, body: body.trim() }]);
              setWriting(null);
            }}
          />
        )}
      </div>
    );
  };

  const viewer = current && (
    <div className="block viewer">
      <div className="block-head mono">
        <span className="file-name">
          <span className={`status-letter s-${current.status}`}>{LETTER[current.status] ?? "?"}</span>
          <span className="path">{current.path}</span>
        </span>
        <span className="viewer-actions">
          <span className="faint">
            {current.proposed ? "proposed · " : ""}+{current.add} -{current.del}
          </span>
          {live && !current.proposed && current.status !== "deleted" && (
            <button type="button" className="link-btn mono faint" onClick={() => openInEditor(`${workspace}/${current.path}`)}>
              open
            </button>
          )}
        </span>
      </div>
      {current.binary && <div className="cmd mono faint">binary file, not shown</div>}
      {current.diffs.map((diff, index) => (
        <div key={index} className="diff-wrap">
          {/* One hunk needs no header; the line numbers say where it is. */}
          <DiffView
            diff={diff}
            path={current.path}
            split={split}
            wrap={wrap}
            hideHunks={(diff.match(/^@@/gm) ?? []).length < 2}
            onLine={commenting && !current.proposed ? (row) => setWriting(anchorOf(current.path, row)) : undefined}
            after={commenting ? afterLine(current.path) : undefined}
          />
        </div>
      ))}
    </div>
  );

  return (
    <>
      <div className="panel-head">
        <span>{title}</span>
        <span className="mono faint">{note}</span>
      </div>
      {git?.warning && <div className="bar mono faint">{git.warning}</div>}
      {error && <div className="bar mono faint">git: {error}</div>}
      {props.comments.length > 0 && (
        <div className="review-bar" data-state="attention">
          <span className="sdot still" />
          <span className="grow">
            {props.comments.length} comment{props.comments.length > 1 ? "s" : ""} ready
          </span>
          <button type="button" className="btn ghost" style={{ fontWeight: 400 }} onClick={() => props.onComments([])}>
            Discard
          </button>
          <button type="button" className="btn" onClick={props.onSendReview}>
            Send to Mirror
          </button>
        </div>
      )}
      {commenting && entries.some((entry) => !entry.proposed) && !props.comments.length && (
        <span className="mono faint">Click a line to comment on it. Comments go to Mirror together, as one message.</span>
      )}
      {entries.length > 0 && (
        <div className="diff-tools">
          {props.wide && (
            <div role="group" aria-label="Diff layout" className="segs">
              {(["unified", "split"] as const).map((name) => (
                <button key={name} type="button" className="seg" aria-pressed={layout === name} onClick={() => (setLayout(name), save("glass.diff.layout", name))}>
                  <span className="segin mono">{name}</span>
                </button>
              ))}
            </div>
          )}
          {live && git?.git && (
            <div role="group" aria-label="Context lines" className="segs">
              {CONTEXTS.map(([label, lines]) => (
                <button key={lines} type="button" className="seg" aria-pressed={context === lines} onClick={() => (setContext(lines), save("glass.diff.context", String(lines)))}>
                  <span className="segin mono">{label}</span>
                </button>
              ))}
            </div>
          )}
          <button type="button" className="seg" aria-pressed={wrap} onClick={() => (setWrap(!wrap), save("glass.diff.wrap", wrap ? "off" : "on"))}>
            <span className="segin mono">wrap</span>
          </button>
        </div>
      )}
      {sideList ? (
        <div className="review-grid">
          {list}
          {viewer}
        </div>
      ) : (
        <>
          {list}
          {viewer}
        </>
      )}
      {!entries.length && (
        <span className="muted">
          {rejected ? "Every proposed change was rejected." : live && git?.git ? "The workspace matches its base." : "Edits the agent makes show here."}
        </span>
      )}
      {live && git?.git && entries.some((entry) => !entry.proposed) && (
        <CommitForm agent={agent} git={git} files={entries.filter((entry) => !entry.proposed)} onDone={() => setCommitted((count) => count + 1)} />
      )}
      {live && (
        <div>
          <button type="button" className="btn ghost" style={{ fontWeight: 400 }} onClick={() => openInEditor(workspace)}>
            open in editor
          </button>
        </div>
      )}
    </>
  );
}
