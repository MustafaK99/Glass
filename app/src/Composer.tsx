import { forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { listFiles } from "./bridge";

const MAX_HEIGHT = 260;
const SHOWN = 8;

// Listed when @ is typed, and again if the list is more than ten seconds old,
// so files the agent just wrote show up.
const fileCache = new Map<string, { at: number; files: Promise<string[]> }>();
function filesFor(workspace: string): Promise<string[]> {
  const cached = fileCache.get(workspace);
  if (cached && Date.now() - cached.at < 10_000) return cached.files;
  const files = listFiles(workspace).catch(() => []);
  fileCache.set(workspace, { at: Date.now(), files });
  return files;
}

/** Paths that match `query`: file name starts, then name contains, then path contains. */
export function rankFiles(files: string[], query: string): string[] {
  const needle = query.toLowerCase();
  if (!needle) return files.slice(0, SHOWN);
  const scored: [number, string][] = [];
  for (const path of files) {
    const lower = path.toLowerCase();
    const name = lower.slice(lower.lastIndexOf("/") + 1);
    const score = name.startsWith(needle) ? 0 : name.includes(needle) ? 1 : lower.includes(needle) ? 2 : -1;
    if (score >= 0) scored.push([score * 1000 + path.length, path]);
    if (scored.length > 2000) break;
  }
  return scored.sort((a, b) => a[0] - b[0]).slice(0, SHOWN).map(([, path]) => path);
}

/** The `@word` the caret is in, if any. */
/** The `@word` or `$word` the caret is in, if any. `$` names a skill, as in Mirror. */
function mentionAt(text: string, caret: number): { start: number; query: string; sigil: "@" | "$" } | null {
  const match = /(^|\s)([@$])([^\s@$]*)$/.exec(text.slice(0, caret));
  return match ? { start: caret - match[3].length - 1, query: match[3], sigil: match[2] as "@" | "$" } : null;
}

/** Projects offered by @, for a new agent. Picking one sets its project. */
export interface MentionProjects {
  items: { path: string; name: string; hint: string }[];
  onPick: (path: string) => void;
  /** "Open a folder…": add a new project from the @ list. */
  onOpenFolder?: () => void;
}

type Mentionable =
  | { kind: "project"; value: string; name: string; hint: string }
  | { kind: "connection"; value: string; hint: string }
  | { kind: "skill"; value: string; hint: string }
  | { kind: "open"; value: string }
  | { kind: "file"; value: string };

export interface ComposerHandle {
  focus(): void;
}

/**
 * The message box. Grows with its text, Enter sends and Shift Enter adds a line.
 * Typing @ lists the workspace's files; picking one inserts its path, which the
 * agent reads with its own tools.
 */
export const Composer = forwardRef<ComposerHandle, {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  placeholder: string;
  workspace: string | null;
  disabled?: boolean;
  autoFocus?: boolean;
  /** Chips on the left of the toolbar inside the box. */
  tools?: ReactNode;
  /** Buttons on the right: stop, send. */
  actions?: ReactNode;
  large?: boolean;
  /** Shown inside the box, before the text: the project chip on a new agent. */
  chips?: ReactNode;
  projects?: MentionProjects;
  /** Connected MCP servers. Picking one names it in the text, so the agent reaches for its tools. */
  connections?: { name: string; tools: string[] }[];
  /** Mirror skills for this workspace. `$name` in a message makes the worker load one. */
  skills?: { name: string; description: string; scope: string }[];
  /** Backspace in an empty box, to remove the last chip. */
  onBackspaceEmpty?: () => void;
}>(function Composer(props, ref) {
  const area = useRef<HTMLTextAreaElement>(null);
  const [mention, setMention] = useState<{ start: number; query: string; sigil: "@" | "$" } | null>(null);
  const [files, setFiles] = useState<string[]>([]);
  const [active, setActive] = useState(0);
  useImperativeHandle(ref, () => ({ focus: () => area.current?.focus() }), []);

  useEffect(() => {
    if (props.autoFocus) area.current?.focus();
  }, [props.autoFocus]);

  // Grow with the text, up to a limit, then scroll.
  useLayoutEffect(() => {
    const element = area.current;
    if (!element) return;
    element.style.height = "auto";
    element.style.height = `${Math.min(element.scrollHeight, MAX_HEIGHT)}px`;
  }, [props.value]);

  useEffect(() => {
    if (!mention || !props.workspace) return;
    let live = true;
    filesFor(props.workspace).then((found) => live && setFiles(found));
    return () => {
      live = false;
    };
  }, [mention !== null, props.workspace]);

  const matches = useMemo<Mentionable[]>(() => {
    if (!mention) return [];
    const needle = mention.query.toLowerCase();
    if (mention.sigil === "$") {
      return (props.skills ?? [])
        .filter((skill) => skill.name.toLowerCase().includes(needle))
        .slice(0, 8)
        .map((skill): Mentionable => ({ kind: "skill", value: skill.name, hint: skill.description }));
    }
    const projects = (props.projects?.items ?? [])
      .filter((project) => project.name.toLowerCase().includes(needle))
      .slice(0, 4)
      .map((project): Mentionable => ({ kind: "project", value: project.path, name: project.name, hint: project.hint }));
    if (props.projects?.onOpenFolder) projects.push({ kind: "open", value: "open" });
    const connections = (props.connections ?? [])
      .filter((server) => server.name.toLowerCase().includes(needle))
      .map((server): Mentionable => ({ kind: "connection", value: server.name, hint: `${server.tools.length} tool${server.tools.length === 1 ? "" : "s"} · ${server.tools.slice(0, 3).join(", ")}` }));
    const found = props.workspace ? rankFiles(files, mention.query).map((path): Mentionable => ({ kind: "file", value: path })) : [];
    return [...projects, ...connections, ...found];
  }, [files, mention, props.projects, props.workspace, props.connections, props.skills]);

  const track = (text: string, caret: number) => {
    const found = mentionAt(text, caret);
    if (found?.sigil === "@" && !(props.workspace || props.projects || props.connections?.length)) return setMention(null);
    if (found?.sigil === "$" && !props.skills?.length) return setMention(null);
    setMention(found);
    if (!found) setActive(0);
  };

  const insert = (choice: Mentionable) => {
    if (!mention) return;
    const caret = area.current?.selectionStart ?? props.value.length;
    // A project becomes the chip; the @word goes. A file becomes its path in the text.
    const path =
      choice.kind === "file" ? `${choice.value} ` : choice.kind === "connection" ? `@${choice.value} ` : choice.kind === "skill" ? `$${choice.value} ` : "";
    if (choice.kind === "project") props.projects?.onPick(choice.value);
    if (choice.kind === "open") props.projects?.onOpenFolder?.();
    const next = `${props.value.slice(0, mention.start)}${path}${props.value.slice(caret)}`;
    props.onChange(next);
    setMention(null);
    const at = mention.start + path.length;
    requestAnimationFrame(() => {
      area.current?.focus();
      area.current?.setSelectionRange(at, at);
    });
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (mention && matches.length) {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        setActive((index) => (index + (event.key === "ArrowDown" ? 1 : matches.length - 1)) % matches.length);
        return;
      }
      if (event.key === "Enter" || event.key === "Tab") {
        event.preventDefault();
        insert(matches[active] ?? matches[0]);
        return;
      }
    }
    if (mention && event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      setMention(null);
      return;
    }
    if (event.key === "Backspace" && !props.value && props.onBackspaceEmpty) {
      props.onBackspaceEmpty();
      return;
    }
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      props.onSubmit();
    }
  };

  return (
    <div className={`composer-box${props.large ? " large" : ""}${props.disabled ? " disabled" : ""}`}>
      {mention && (mention.sigil === "$" || props.workspace || props.projects || props.connections?.length) && (
        <div className="mention-pop fresh" role="listbox" aria-label="Mention">
          {matches.map((choice, index) => {
            const group = (entry: Mentionable) => (entry.kind === "file" ? "file" : entry.kind === "connection" ? "connection" : entry.kind === "skill" ? "skill" : "project");
            const first = index === 0 || group(matches[index - 1]) !== group(choice);
            const heading = { project: "Projects", connection: "Connections", skill: "Skills", file: `Files${mention.query ? ` · ${mention.query}` : ""}` }[group(choice)];
            const slash = choice.kind === "file" ? choice.value.lastIndexOf("/") : -1;
            return (
              <div key={`${choice.kind}-${choice.value}`} className="mention-group">
                {first && <span className="cap">{heading}</span>}
                <button
                  type="button"
                  role="option"
                  aria-selected={index === active}
                  className="row menu-row"
                  aria-current={index === active}
                  onMouseEnter={() => setActive(index)}
                  onMouseDown={(event) => {
                    event.preventDefault();
                    insert(choice);
                  }}
                >
                  {choice.kind === "skill" ? (
                    <span className="menu-label">
                      <span className="mono">
                        <span className="faint">$</span>
                        {choice.value}
                      </span>
                      <span className="faint mention-hint">{choice.hint}</span>
                    </span>
                  ) : choice.kind === "connection" ? (
                    <span className="menu-label mention-project">
                      <span>
                        <span className="faint">@</span>
                        {choice.value}
                      </span>
                      <span className="mono faint">{choice.hint}</span>
                    </span>
                  ) : choice.kind === "open" ? (
                    <span className="menu-label mention-project">
                      <span>Open a folder…</span>
                      <span className="mono faint">a new project</span>
                    </span>
                  ) : choice.kind === "project" ? (
                    <span className="menu-label mention-project">
                      <span>
                        <span className="faint">@</span>
                        {choice.name}
                      </span>
                      <span className="mono faint">{choice.hint}</span>
                    </span>
                  ) : (
                    <span className="menu-label mono">
                      <span>{choice.value.slice(slash + 1)}</span>
                      <span className="faint">{slash > 0 ? choice.value.slice(0, slash) : ""}</span>
                    </span>
                  )}
                </button>
              </div>
            );
          })}
          {!matches.length && (
            <span className="mono faint mention-empty">{mention.sigil === "$" ? "no skill matches" : props.workspace && !files.length ? "listing files" : "nothing matches"}</span>
          )}
        </div>
      )}
      {props.chips && <div className="composer-chips">{props.chips}</div>}
      <label htmlFor="composer" className="vh">
        Message Mirror
      </label>
      <textarea
        id="composer"
        ref={area}
        rows={1}
        value={props.value}
        disabled={props.disabled}
        placeholder={props.placeholder}
        onChange={(event) => {
          props.onChange(event.target.value);
          track(event.target.value, event.target.selectionStart);
        }}
        onKeyDown={onKeyDown}
        onClick={(event) => track(props.value, event.currentTarget.selectionStart)}
        onBlur={() => setTimeout(() => setMention(null), 120)}
        spellCheck
      />
      <div className="composer-tools">
        <div className="composer-left">{props.tools}</div>
        <div className="composer-right">{props.actions}</div>
      </div>
    </div>
  );
});
