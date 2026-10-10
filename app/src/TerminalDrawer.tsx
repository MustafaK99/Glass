import { useEffect, useRef, useState } from "react";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { inTauri, terminalClose, terminalOpen, terminalResize, terminalWrite } from "./bridge";

/** Colours from the theme tokens, so the terminal matches cream and dark. */
function themeFrom(element: HTMLElement) {
  const css = getComputedStyle(element);
  const token = (name: string) => css.getPropertyValue(name).trim();
  return {
    background: token("--surface"),
    foreground: token("--ink"),
    cursor: token("--ink"),
    cursorAccent: token("--surface"),
    selectionBackground: token("--line-strong"),
    green: token("--run"),
    red: token("--fail"),
    yellow: token("--attn"),
  };
}

/**
 * One agent's shell, in its workspace. Stays alive while the person switches
 * agents, so its history is kept; closed with the agent or the drawer's ×.
 */
function Shell(props: { id: string; cwd: string; visible: boolean; theme: string; onExit: () => void }) {
  const host = useRef<HTMLDivElement>(null);
  const terminal = useRef<Terminal | null>(null);
  const fit = useRef<FitAddon | null>(null);

  useEffect(() => {
    if (!host.current) return;
    const term = new Terminal({
      fontFamily: "'Geist Mono', ui-monospace, Menlo, monospace",
      fontSize: 12.5,
      lineHeight: 1.25,
      cursorBlink: true,
      allowProposedApi: false,
      scrollback: 5000,
      theme: themeFrom(host.current),
    });
    const fitter = new FitAddon();
    term.loadAddon(fitter);
    term.open(host.current);
    fitter.fit();
    terminal.current = term;
    fit.current = fitter;
    term.onData((data) => terminalWrite(props.id, data).catch(() => {}));
    terminalOpen(props.id, props.cwd, term.cols, term.rows, (bytes) => term.write(bytes), () => {
      term.write("\r\n\x1b[2m[shell exited]\x1b[0m\r\n");
      props.onExit();
    }).catch((error) => term.write(`\x1b[31m${String(error)}\x1b[0m\r\n`));
    const observer = new ResizeObserver(() => {
      if (!host.current?.offsetParent) return;
      fitter.fit();
      terminalResize(props.id, term.cols, term.rows).catch(() => {});
    });
    observer.observe(host.current);
    return () => {
      observer.disconnect();
      term.dispose();
      terminalClose(props.id).catch(() => {});
    };
    // One shell per mount; the id and folder do not change for an agent.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (host.current && terminal.current) terminal.current.options.theme = themeFrom(host.current);
  }, [props.theme]);

  useEffect(() => {
    if (!props.visible) return;
    requestAnimationFrame(() => {
      fit.current?.fit();
      terminal.current?.focus();
    });
  }, [props.visible]);

  return <div ref={host} className="shell" hidden={!props.visible} />;
}

const MIN = 120;

/**
 * The terminal drawer under the conversation. Ctrl ` toggles it. One shell per
 * agent, opened the first time the drawer is shown for that agent.
 */
export function TerminalDrawer(props: {
  agentId: string;
  cwd: string;
  open: boolean;
  theme: string;
  onClose: () => void;
}) {
  // Agents whose shell has been started, kept mounted so history survives switching.
  const [shells, setShells] = useState<{ id: string; cwd: string }[]>([]);
  const [height, setHeight] = useState(() => {
    try {
      return Number(localStorage.getItem("glass.terminal.height")) || 260;
    } catch {
      return 260;
    }
  });

  useEffect(() => {
    if (props.open && inTauri && !shells.some((shell) => shell.id === props.agentId)) {
      setShells((current) => [...current, { id: props.agentId, cwd: props.cwd }]);
    }
  }, [props.open, props.agentId, props.cwd, shells]);

  const drag = (event: React.PointerEvent) => {
    event.preventDefault();
    const startY = event.clientY;
    const startHeight = height;
    const max = () => Math.max(MIN, window.innerHeight - 260);
    const move = (moved: PointerEvent) => setHeight(Math.min(max(), Math.max(MIN, startHeight + startY - moved.clientY)));
    const up = (ended: PointerEvent) => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      document.body.classList.remove("resizing-y");
      try {
        localStorage.setItem("glass.terminal.height", String(Math.min(max(), Math.max(MIN, startHeight + startY - ended.clientY))));
      } catch {
        // Storage can be unavailable; the size just will not persist.
      }
    };
    document.body.classList.add("resizing-y");
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const closeShell = (id: string) => setShells((current) => current.filter((shell) => shell.id !== id));

  return (
    <section className="drawer" hidden={!props.open} style={{ height }} aria-label="Terminal">
      <div className="drawer-grip" role="separator" aria-orientation="horizontal" aria-label="Resize the terminal" onPointerDown={drag} />
      <div className="drawer-head">
        <span className="cap">Terminal</span>
        <span className="mono faint drawer-cwd">{props.cwd.replace(/^\/Users\/[^/]+/, "~")}</span>
        <span className="grow" />
        {shells.some((shell) => shell.id === props.agentId) && (
          <button type="button" className="btn ghost drawer-btn" title="End this shell" onClick={() => closeShell(props.agentId)}>
            restart
          </button>
        )}
        <button type="button" className="icon-btn ghost small" aria-label="Hide the terminal" title="Hide · ⌃`" onClick={props.onClose}>
          <svg className="i" viewBox="0 0 16 16" aria-hidden="true">
            <path d="M4.5 6.5 8 10l3.5-3.5" />
          </svg>
        </button>
      </div>
      <div className="drawer-body">
        {!inTauri && <span className="mono faint drawer-empty">The terminal needs the desktop app.</span>}
        {shells.map((shell) => (
          <Shell key={shell.id} id={shell.id} cwd={shell.cwd} visible={props.open && shell.id === props.agentId} theme={props.theme} onExit={() => {}} />
        ))}
      </div>
    </section>
  );
}
