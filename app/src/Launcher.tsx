import { useEffect, useMemo, useRef, useState } from "react";
import type { Project } from "./bridge";
import { Pill } from "./Transcript";

export interface LaunchPlan {
  /** Null means no project: the agent gets its own scratch folder. */
  project: Project | null;
  text: string;
  checkout: boolean;
}

const tilde = (path: string) => path.replace(/^\/Users\/[^/]+/, "~");

/**
 * Cmd K: type a task, @ a project, Enter. See docs/product.md, Launcher.
 * The person stays on the agent they were viewing.
 */
export function Launcher(props: {
  projects: Project[];
  agentCount: (project: Project) => number;
  /** Whether an agent already works in the project's own folder. */
  mainBusy: (project: Project) => boolean;
  defaultProject: Project | null;
  effort: string;
  model: string;
  mode: string;
  onPickFolder: () => Promise<Project | null>;
  onStart: (plan: LaunchPlan) => void;
  onClose: () => void;
}) {
  const [text, setText] = useState("");
  const [project, setProject] = useState<Project | null>(props.defaultProject);
  // The project is optional, so the list stays closed until the person types @.
  const [listOpen, setListOpen] = useState(false);
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => input.current?.focus(), []);

  // No project, the projects, then "Open a folder".
  const choices = useMemo(
    () => [
      { kind: "none" as const },
      ...props.projects.map((entry) => ({ kind: "project" as const, project: entry })),
      { kind: "folder" as const },
    ],
    [props.projects],
  );

  const plan = (() => {
    if (!project) return { checkout: false, note: "works in a new scratch folder · type @ to pick a project", blocked: false, where: "no project" };
    const busy = props.mainBusy(project);
    if (!busy) {
      return { checkout: false, note: `works in ${tilde(project.path)}`, blocked: false, where: project.git ? "main folder" : "folder, no git" };
    }
    if (project.git && project.origin) {
      return {
        checkout: true,
        note: `${project.name} already has an agent, so this one gets its own checkout from ${project.origin}`,
        blocked: false,
        where: `own checkout from ${project.origin}`,
      };
    }
    return {
      checkout: false,
      note: project.git
        ? `${project.name} has no origin remote, so it cannot get a second checkout, and an agent already works in its folder`
        : `${project.name} is not a git repository, and an agent already works in it`,
      blocked: true,
      where: "",
    };
  })();

  const pick = async (index: number) => {
    const choice = choices[index];
    if (!choice) return;
    if (choice.kind === "folder") {
      const opened = await props.onPickFolder();
      if (opened) setProject(opened);
    } else if (choice.kind === "none") {
      setProject(null);
    } else {
      setProject(choice.project);
    }
    setListOpen(false);
    input.current?.focus();
  };

  const start = () => {
    if (plan.blocked || !text.trim()) return;
    props.onStart({ project, text: text.trim(), checkout: plan.checkout });
  };

  const onKey = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      if (listOpen) setListOpen(false);
      else props.onClose();
      return;
    }
    if (listOpen && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
      event.preventDefault();
      setActive((index) => (index + (event.key === "ArrowDown" ? 1 : choices.length - 1)) % choices.length);
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      if (listOpen) pick(active);
      else start();
      return;
    }
    if (event.key === "Backspace" && !text && project) setProject(null);
  };

  const onChange = (value: string) => {
    // Typing @ opens the project list; the @ itself is not part of the task.
    if (value.endsWith("@")) {
      setText(value.slice(0, -1));
      setListOpen(true);
      setActive(0);
      return;
    }
    setText(value);
  };

  return (
    <div className="veil" onMouseDown={(event) => event.target === event.currentTarget && props.onClose()}>
      <div role="dialog" aria-label="New agent" aria-modal="true" className="launcher fresh">
        <div className="launcher-head">
          <span className="cap">New agent</span>
          <button type="button" className="ghost mono esc" onClick={props.onClose}>
            esc
          </button>
        </div>
        <div className="launcher-line">
          {project && <span className="chip mono">@{project.name}</span>}
          <label htmlFor="task" className="vh">
            Task
          </label>
          <input
            id="task"
            ref={input}
            value={text}
            placeholder={project ? "Describe the task" : "Describe the task. @ picks a project"}
            onChange={(event) => onChange(event.target.value)}
            onKeyDown={onKey}
            autoComplete="off"
            spellCheck={false}
          />
          {!listOpen && (
            <button type="button" className="chip-btn mono" onClick={() => setListOpen(true)} aria-label="Pick a project">
              @
            </button>
          )}
        </div>
        <div className="launcher-meta mono">
          {plan.where && <span>{plan.where}</span>}
          <span>{props.effort}</span>
          {props.model && <span>{props.model}</span>}
          <span>{props.mode}</span>
        </div>
        {listOpen && (
          <div className="launcher-list" role="listbox" aria-label="Projects">
            <span className="cap">Projects</span>
            {choices.map((choice, index) => (
              <button
                key={choice.kind === "project" ? choice.project.path : choice.kind}
                type="button"
                role="option"
                aria-selected={index === active}
                className="row launcher-row"
                aria-current={index === active}
                onMouseEnter={() => setActive(index)}
                onClick={() => pick(index)}
              >
                {choice.kind === "none" ? (
                  <>
                    <span>No project</span>
                    <span className="mono faint">a new scratch folder</span>
                  </>
                ) : choice.kind === "project" ? (
                  <>
                    <span>{choice.project.name}</span>
                    <span className="mono faint">
                      {props.agentCount(choice.project)} agent{props.agentCount(choice.project) === 1 ? "" : "s"} · {tilde(choice.project.path)}
                    </span>
                  </>
                ) : (
                  <>
                    <span>Open a folder</span>
                    <span className="mono faint">any git repo</span>
                  </>
                )}
              </button>
            ))}
          </div>
        )}
        <div className="launcher-foot">
          <span className="mono faint">{plan.note}</span>
          <Pill variant="lime" small label="Start agent" onClick={start} disabled={plan.blocked || !text.trim()} />
        </div>
      </div>
    </div>
  );
}
