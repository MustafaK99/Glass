import { Dropdown } from "./Menu";
import type { WorkspaceTag } from "./bridge";

export const EFFORTS = ["low", "medium", "high", "xhigh", "max"];

/** One step lower or higher, stopping at the ends. Cmd [ and Cmd ]. */
export function stepEffort(current: string, direction: -1 | 1): string {
  const at = Math.max(0, EFFORTS.indexOf(current));
  return EFFORTS[Math.min(EFFORTS.length - 1, Math.max(0, at + direction))];
}

/**
 * Shortcuts for the composer's controls: Cmd / model, Cmd [ and ] reasoning,
 * Shift Tab approval mode. Returns true when it handled the key.
 */
export function controlKey(event: KeyboardEvent | React.KeyboardEvent, actions: { effort: (direction: -1 | 1) => void; mode: () => void; model: () => void }): boolean {
  const command = event.metaKey || event.ctrlKey;
  if (command && event.key === "/") actions.model();
  else if (command && (event.key === "[" || event.key === "]")) actions.effort(event.key === "[" ? -1 : 1);
  else if (event.shiftKey && event.key === "Tab" && !command) actions.mode();
  else return false;
  event.preventDefault();
  return true;
}

/** Reasoning effort, in Mirror's words. Applies to the next turn. */
export function EffortMenu(props: { value: string; onChange: (effort: string) => void; disabled?: boolean }) {
  return (
    <Dropdown
      label={
        <>
          <span className="faint">reasoning</span> {props.value}
        </>
      }
      title="Reasoning effort, for the next turn · ⌘[ ⌘]"
      value={props.value}
      disabled={props.disabled}
      options={EFFORTS.map((effort) => ({ value: effort, label: effort }))}
      onChange={props.onChange}
      width={180}
    />
  );
}

/** Manual asks before bash, write and edit; auto runs them. Applies to the next request. */
export function ModeMenu(props: { value: "manual" | "auto"; onChange: (mode: "manual" | "auto") => void; disabled?: boolean }) {
  return (
    <Dropdown
      label={
        <>
          <span className="sdot" />
          {props.value}
        </>
      }
      state={props.value === "manual" ? "attention" : "running"}
      title="Approval mode · ⇧Tab"
      value={props.value}
      disabled={props.disabled}
      options={[
        { value: "manual" as const, label: "manual", hint: "asks before bash, write and edit" },
        { value: "auto" as const, label: "auto", hint: "runs every tool without asking" },
      ]}
      footer="Applies from the next request. A pending one still waits for you."
      onChange={props.onChange}
      width={300}
    />
  );
}

/** How much of the transcript to show, in Mirror's words (its /view, Ctrl+T). */
export type TranscriptView = "detail" | "default" | "focus";
export const VIEWS: TranscriptView[] = ["detail", "default", "focus"];

export function ViewMenu(props: { value: TranscriptView; onChange: (view: TranscriptView) => void }) {
  return (
    <Dropdown
      label={
        <>
          <span className="faint">view</span> {props.value}
        </>
      }
      title="Transcript detail · ⌘T"
      value={props.value}
      options={[
        { value: "detail" as const, label: "detail", hint: "reasoning open, full tool output" },
        { value: "default" as const, label: "default", hint: "tools grouped, reasoning folded" },
        { value: "focus" as const, label: "focus", hint: "messages only; requests still show" },
      ]}
      onChange={props.onChange}
      width={300}
    />
  );
}

/** A workspace tag's icon in its colour, as Mirror draws it on a tab. */
export function TagIcon(props: { tag: WorkspaceTag }) {
  return (
    <span className="tag-icon" style={props.tag.color ? { color: props.tag.color } : undefined} aria-label={props.tag.name} title={props.tag.name}>
      {props.tag.icon}
    </span>
  );
}

/** Pick an agent's tag, or none. Ctrl S cycles them, as in Mirror. */
export function TagMenu(props: { tags: WorkspaceTag[]; value: string | null; onChange: (tag: string | null) => void }) {
  const current = props.tags.find((tag) => tag.id === props.value) ?? null;
  return (
    <Dropdown
      label={current ? <><TagIcon tag={current} /> {current.name}</> : <span className="faint">tag</span>}
      title="Workspace tag · ⌃S"
      value={props.value ?? ""}
      options={[
        ...props.tags.map((tag) => ({ value: tag.id, label: `${tag.icon} ${tag.name}`, hint: "" })),
        { value: "", label: "No tag", hint: "" },
      ]}
      onChange={(value) => props.onChange(value || null)}
      width={220}
    />
  );
}
