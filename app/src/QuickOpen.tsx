import { useEffect, useMemo, useRef, useState } from "react";
import { listFiles, openInEditor } from "./bridge";

/**
 * Open a workspace file in your editor: type part of its path, Enter. Mirror's
 * /editor (Ctrl+P); here ⌘P.
 */
export function QuickOpen(props: { workspace: string; onClose: () => void; onError: (message: string) => void }) {
  const [files, setFiles] = useState<string[]>([]);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    listFiles(props.workspace).then(setFiles).catch(() => setFiles([]));
    input.current?.focus();
  }, [props.workspace]);
  const matches = useMemo(() => {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    const found = words.length ? files.filter((file) => words.every((word) => file.toLowerCase().includes(word))) : files;
    // Shorter paths first: the file named is usually the one meant.
    return [...found].sort((a, b) => a.length - b.length).slice(0, 12);
  }, [files, query]);
  useEffect(() => setActive(0), [query]);
  const open = (file: string | undefined) => {
    if (!file) return;
    openInEditor(`${props.workspace}/${file}`).catch((reason) => props.onError(String(reason)));
    props.onClose();
  };
  return (
    <div className="veil" onMouseDown={(event) => event.target === event.currentTarget && props.onClose()}>
      <div role="dialog" aria-label="Open a file" aria-modal="true" className="launcher quick-open fresh">
        <input
          ref={input}
          className="field mono"
          value={query}
          placeholder="Open a file in your editor"
          aria-label="File"
          spellCheck={false}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape") props.onClose();
            if (event.key === "Enter") open(matches[active]);
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              event.preventDefault();
              setActive((index) => (index + (event.key === "ArrowDown" ? 1 : matches.length - 1)) % Math.max(matches.length, 1));
            }
          }}
        />
        <div className="quick-open-list">
          {matches.map((file, index) => (
            <button key={file} type="button" className="row menu-row mono" aria-current={index === active} onMouseEnter={() => setActive(index)} onClick={() => open(file)}>
              {file}
            </button>
          ))}
          {!matches.length && <span className="mono faint">{files.length ? "No file matches." : "Reading files…"}</span>}
        </div>
      </div>
    </div>
  );
}
