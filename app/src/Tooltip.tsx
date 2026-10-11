import { useEffect, useState } from "react";

const DELAY = 280;
// A shortcut at the end of a title: "Settings · ⌘,", "Approve · A", "Stop · Esc".
const SHORTCUT = /^(?:[⌘⌃⌥⇧↵][^\s]*|[A-Z]|Esc|Tab|Enter|Shift Tab|[⌘⌃⌥⇧↵A-Za-z[\]/,`!@$ ]{1,12})$/;

/** Split "Label · ⌘K" into the label and its keys, each key its own cap. */
export function splitTitle(title: string): { label: string; keys: string[] } {
  const at = title.lastIndexOf(" · ");
  if (at === -1) return { label: title, keys: [] };
  const tail = title.slice(at + 3).trim();
  if (!SHORTCUT.test(tail) || tail.length > 14) return { label: title, keys: [] };
  return { label: title.slice(0, at), keys: tail.split(/\s+/).filter(Boolean) };
}

interface Shown {
  label: string;
  keys: string[];
  x: number;
  y: number;
  below: boolean;
}

/**
 * One tooltip for the whole app. It takes over every element's `title`, so hover
 * text appears quickly and in the design's style, with keyboard shortcuts as key
 * caps. Also shows on keyboard focus.
 */
export function Tooltip() {
  const [shown, setShown] = useState<Shown | null>(null);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let current: HTMLElement | null = null;

    const hide = () => {
      clearTimeout(timer);
      if (current?.dataset.tip !== undefined) current.setAttribute("title", current.dataset.tip);
      current = null;
      setShown(null);
    };

    const show = (target: HTMLElement) => {
      // Move the native title aside so the system tooltip does not also appear.
      const title = target.getAttribute("title") ?? target.dataset.tip ?? "";
      if (!title.trim()) return;
      target.dataset.tip = title;
      target.removeAttribute("title");
      current = target;
      clearTimeout(timer);
      timer = setTimeout(() => {
        if (current !== target || !target.isConnected) return;
        const box = target.getBoundingClientRect();
        const below = box.top < 64;
        setShown({ ...splitTitle(title), x: box.left + box.width / 2, y: below ? box.bottom + 8 : box.top - 8, below });
      }, DELAY);
    };

    const over = (event: Event) => {
      const target = (event.target as HTMLElement | null)?.closest<HTMLElement>("[title], [data-tip]");
      if (target === current) return;
      if (current) hide();
      if (target) show(target);
    };
    const out = (event: MouseEvent | FocusEvent) => {
      if (!current) return;
      const next = event.relatedTarget as Node | null;
      if (next && current.contains(next)) return;
      hide();
    };

    document.addEventListener("mouseover", over);
    document.addEventListener("focusin", over);
    document.addEventListener("mouseout", out);
    document.addEventListener("focusout", out);
    document.addEventListener("mousedown", hide, true);
    document.addEventListener("keydown", hide, true);
    window.addEventListener("scroll", hide, true);
    window.addEventListener("blur", hide);
    return () => {
      hide();
      document.removeEventListener("mouseover", over);
      document.removeEventListener("focusin", over);
      document.removeEventListener("mouseout", out);
      document.removeEventListener("focusout", out);
      document.removeEventListener("mousedown", hide, true);
      document.removeEventListener("keydown", hide, true);
      window.removeEventListener("scroll", hide, true);
      window.removeEventListener("blur", hide);
    };
  }, []);

  if (!shown) return null;
  // Keep it on screen near the window's edges.
  const left = Math.min(Math.max(shown.x, 120), window.innerWidth - 120);
  return (
    <div role="tooltip" className={`tooltip ${shown.below ? "below" : "above"}`} style={{ left, top: shown.y }}>
      <span>{shown.label}</span>
      {shown.keys.map((key) => (
        <kbd key={key}>{key}</kbd>
      ))}
    </div>
  );
}
