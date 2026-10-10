import { Dropdown } from "./Menu";

export const EFFORTS = ["low", "medium", "high", "xhigh", "max"];

/** Reasoning effort, in Mirror's words. Applies to the next turn. */
export function EffortMenu(props: { value: string; onChange: (effort: string) => void; disabled?: boolean }) {
  return (
    <Dropdown
      label={
        <>
          <span className="faint">reasoning</span> {props.value}
        </>
      }
      title="Reasoning effort, for the next turn"
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
      title={props.disabled ? "A recording plays back as it was made" : "Approval mode"}
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
