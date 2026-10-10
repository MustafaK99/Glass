import { useEffect, useRef, useState, type ReactNode } from "react";

/** Close on a click outside `root`, and on Escape. */
export function useDismiss(open: boolean, root: React.RefObject<HTMLElement | null>, close: () => void) {
  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      if (root.current && !root.current.contains(event.target as Node)) close();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        close();
      }
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [open, root, close]);
}

/** Opens toward whichever side of the trigger has more room. */
export function placement(element: HTMLElement | null, height = 360): "up" | "down" {
  if (!element) return "down";
  const box = element.getBoundingClientRect();
  const below = window.innerHeight - box.bottom;
  return below < height && box.top > below ? "up" : "down";
}

export function Chevron() {
  return (
    <svg className="i chev-down" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M4.5 6.5 8 10l3.5-3.5" />
    </svg>
  );
}

export function Check() {
  return (
    <svg className="i check" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M3.5 8.5 6.5 11.5 12.5 4.5" />
    </svg>
  );
}

export interface Option<T> {
  value: T;
  label: string;
  hint?: string;
  disabled?: boolean;
}

/**
 * A chip that opens a short list. Arrow keys move, Enter picks, Escape closes.
 * Used for project, where, reasoning effort and approval mode.
 */
export function Dropdown<T>(props: {
  label: ReactNode;
  title?: string;
  options: Option<T>[];
  value: T;
  onChange: (value: T) => void;
  footer?: ReactNode;
  state?: string;
  disabled?: boolean;
  width?: number;
}) {
  const [open, setOpen] = useState(false);
  const [side, setSide] = useState<"up" | "down">("down");
  const [active, setActive] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  useDismiss(open, root, () => setOpen(false));

  const toggle = () => {
    if (props.disabled) return;
    setSide(placement(root.current, 60 + props.options.length * 48));
    setActive(Math.max(0, props.options.findIndex((option) => option.value === props.value)));
    setOpen(!open);
  };
  const pick = (option: Option<T> | undefined) => {
    if (!option || option.disabled) return;
    props.onChange(option.value);
    setOpen(false);
  };
  const onKey = (event: React.KeyboardEvent) => {
    if (!open) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const step = event.key === "ArrowDown" ? 1 : props.options.length - 1;
      setActive((index) => (index + step) % props.options.length);
    } else if (event.key === "Enter") {
      event.preventDefault();
      pick(props.options[active]);
    }
  };

  return (
    <div className="menu" ref={root} onKeyDown={onKey}>
      <button
        type="button"
        className="menu-chip mono"
        aria-haspopup="listbox"
        aria-expanded={open}
        title={props.title}
        data-state={props.state}
        disabled={props.disabled}
        onClick={toggle}
      >
        {props.label}
        {!props.disabled && <Chevron />}
      </button>
      {open && (
        <div className={`menu-pop fresh ${side}`} role="listbox" style={props.width ? { width: props.width } : undefined}>
          {props.options.map((option, index) => (
            <button
              key={String(option.value)}
              type="button"
              role="option"
              aria-selected={option.value === props.value}
              aria-current={index === active}
              className="row menu-row"
              disabled={option.disabled}
              onMouseEnter={() => setActive(index)}
              onClick={() => pick(option)}
            >
              <span className="menu-label">
                <span>{option.label}</span>
                {option.hint && <span className="mono faint">{option.hint}</span>}
              </span>
              {option.value === props.value && <Check />}
            </button>
          ))}
          {props.footer && <div className="menu-foot mono faint">{props.footer}</div>}
        </div>
      )}
    </div>
  );
}
