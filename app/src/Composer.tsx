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
function mentionAt(text: string, caret: number): { start: number; query: string } | null {
  const match = /(^|\s)@([^\s@]*)$/.exec(text.slice(0, caret));
  return match ? { start: caret - match[2].length - 1, query: match[2] } : null;
}

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
}>(function Composer(props, ref) {
  const area = useRef<HTMLTextAreaElement>(null);
  const [mention, setMention] = useState<{ start: number; query: string } | null>(null);
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

  const matches = useMemo(() => (mention ? rankFiles(files, mention.query) : []), [files, mention]);

  const track = (text: string, caret: number) => {
    const found = props.workspace ? mentionAt(text, caret) : null;
    setMention(found);
    if (!found) setActive(0);
  };

  const insert = (path: string) => {
    if (!mention) return;
    const caret = area.current?.selectionStart ?? props.value.length;
    const next = `${props.value.slice(0, mention.start)}${path} ${props.value.slice(caret)}`;
    props.onChange(next);
    setMention(null);
    const at = mention.start + path.length + 1;
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
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      props.onSubmit();
    }
  };

  return (
    <div className={`composer-box${props.large ? " large" : ""}${props.disabled ? " disabled" : ""}`}>
      {mention && props.workspace && (
        <div className="mention-pop fresh" role="listbox" aria-label="Files">
          <span className="cap">Files{mention.query ? ` · ${mention.query}` : ""}</span>
          {matches.map((path, index) => {
            const slash = path.lastIndexOf("/");
            return (
              <button
                key={path}
                type="button"
                role="option"
                aria-selected={index === active}
                className="row menu-row"
                aria-current={index === active}
                onMouseEnter={() => setActive(index)}
                onMouseDown={(event) => {
                  event.preventDefault();
                  insert(path);
                }}
              >
                <span className="menu-label mono">
                  <span>{path.slice(slash + 1)}</span>
                  <span className="faint">{slash > 0 ? path.slice(0, slash) : ""}</span>
                </span>
              </button>
            );
          })}
          {!matches.length && <span className="mono faint mention-empty">{files.length ? "no matching file" : "listing files"}</span>}
        </div>
      )}
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
