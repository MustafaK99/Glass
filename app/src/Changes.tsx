import { useEffect, useMemo, useState } from "react";
import { changes as reportedChanges, relative, type AgentState } from "./agent";
import { inTauri, openInEditor, workspaceChanges, type GitChanges } from "./bridge";
import { DiffView } from "./DiffView";

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
 * edits made any way. A recording, or a folder without git, shows the edits
 * the agent reported. Proposed edits waiting on the person always come first.
 */
export function Changes(props: { agent: AgentState; selected: string | null; onSelect: (path: string) => void; wide: boolean }) {
  const { agent } = props;
  const workspace = agent.meta.workspace;
  const live = inTauri && agent.meta.live;
  const [git, setGit] = useState<GitChanges | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [layout, setLayout] = useState(() => load("glass.diff.layout", "unified", ["unified", "split"] as const));
  const [context, setContext] = useState(() => Number(load("glass.diff.context", "3", ["3", "10", "100000"] as const)));
  const [wrap, setWrap] = useState(() => load("glass.diff.wrap", "off", ["on", "off"] as const) === "on");
  const version = changeVersion(agent);

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
          <DiffView diff={diff} path={current.path} split={split} wrap={wrap} hideHunks={(diff.match(/^@@/gm) ?? []).length < 2} />
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
