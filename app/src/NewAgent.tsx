import { useEffect, useMemo, useRef, useState } from "react";
import type { Project } from "./bridge";
import { Composer, type ComposerHandle } from "./Composer";
import { controlKey, EffortMenu, ModeMenu, stepEffort } from "./Controls";
import { Dropdown } from "./Menu";
import { ModelPicker, openModelMenu, type ModelChoice } from "./ModelPicker";
import { Pill } from "./Transcript";

export interface LaunchPlan {
  /** Null means no project: the agent gets its own scratch folder. */
  project: Project | null;
  text: string;
  checkout: boolean;
  effort: string;
  mode: "manual" | "auto";
  choice: ModelChoice;
}

const tilde = (path: string) => path.replace(/^\/Users\/[^/]+/, "~");
const NONE = "";
const OPEN = "\u0000open";

/**
 * A new agent: pick where it works, describe the task, Enter. Shown as an empty
 * chat in the main column, and as the Cmd K dialog over whatever is open.
 *
 * Where it works: an agent runs in the project folder, or in its own checkout
 * from origin's default branch. Only one agent at a time works in the project
 * folder, so a second one defaults to a checkout.
 */
export function NewAgent(props: {
  variant: "page" | "dialog";
  projects: Project[];
  initialProject: Project | null;
  /** Whether an agent already works in the project's own folder. */
  mainBusy: (project: Project) => boolean;
  choice: ModelChoice;
  keys: string[];
  effort: string;
  mode: "manual" | "auto";
  blocked?: string | null;
  onChoice: (choice: ModelChoice) => void;
  connections?: { name: string; tools: string[] }[];
  onPickFolder: () => Promise<Project | null>;
  onStart: (plan: LaunchPlan) => void;
  onClose?: () => void;
}) {
  const [text, setText] = useState("");
  const [project, setProject] = useState<Project | null>(props.initialProject);
  const [effort, setEffort] = useState(props.effort);
  const [mode, setMode] = useState(props.mode);
  const composer = useRef<ComposerHandle>(null);

  useEffect(() => setProject(props.initialProject), [props.initialProject]);

  const busy = project ? props.mainBusy(project) : false;
  const canCheckout = !!project?.git && !!project.origin;
  const [whereChoice, setWhereChoice] = useState<"local" | "checkout" | null>(null);
  // Until the person picks, the second agent in a project gets its own checkout.
  const where = whereChoice ?? (busy && canCheckout ? "checkout" : "local");
  useEffect(() => setWhereChoice(null), [project?.path]);

  const problem = useMemo(() => {
    if (props.blocked) return props.blocked;
    if (!project || where === "checkout") return null;
    if (busy) {
      return canCheckout
        ? `An agent already works in ${project.name}'s folder. Pick its own checkout, or wait.`
        : `An agent already works in ${project.name}'s folder, and ${project.git ? "it has no origin remote" : "it is not a git repository"}, so it cannot get its own checkout.`;
    }
    return null;
  }, [props.blocked, project, where, busy, canCheckout]);

  const note = !project
    ? "Works in a new scratch folder that Glass keeps."
    : where === "checkout"
      ? `Its own checkout from ${project.origin}, on a branch named from the task, with your .env files copied.`
      : `Works in ${tilde(project.path)}${project.git ? "" : " · no git, so changes are not tracked"}.`;

  const start = () => {
    if (problem || !text.trim()) return;
    props.onStart({ project, text: text.trim(), checkout: where === "checkout", effort, mode, choice: props.choice });
  };

  const projectOptions = [
    { value: NONE, label: "No project", hint: "a new scratch folder" },
    ...props.projects.map((entry) => ({ value: entry.path, label: entry.name, hint: tilde(entry.path) })),
    { value: OPEN, label: "Open a folder…", hint: "any folder, ideally a git repo" },
  ];

  const onKeys = (event: React.KeyboardEvent) =>
    controlKey(event, {
      effort: (direction) => setEffort((current) => stepEffort(current, direction)),
      mode: () => setMode((current) => (current === "manual" ? "auto" : "manual")),
      model: openModelMenu,
    });

  const form = (
    <div className="new-form" onKeyDown={onKeys}>
      <div className="new-where">
        {project && (
          <Dropdown
            label={where === "checkout" ? "own checkout" : "project folder"}
            title="Where the agent works"
            value={where}
            width={320}
            options={[
              { value: "local" as const, label: "Project folder", hint: busy ? "another agent works here" : tilde(project.path) },
              {
                value: "checkout" as const,
                label: "Own checkout",
                hint: canCheckout ? `git worktree from ${project.origin}` : project.git ? "needs an origin remote" : "needs a git repository",
                disabled: !canCheckout,
              },
            ]}
            onChange={(value) => {
              setWhereChoice(value);
              composer.current?.focus();
            }}
          />
        )}
        <span className="mono faint new-note">{problem ?? note}</span>
      </div>
      <Composer
        ref={composer}
        large={props.variant === "page"}
        value={text}
        onChange={setText}
        onSubmit={start}
        autoFocus
        workspace={project?.path ?? null}
        placeholder={project ? "What should Mirror do? @ a file, or another project" : "What should Mirror do? @ picks a project"}
        chips={
          project ? (
            <span className="project-chip mono">
              @{project.name}
              <button type="button" aria-label={`Remove ${project.name}`} title="No project" onClick={() => setProject(null)}>
                <svg className="i" viewBox="0 0 16 16" aria-hidden="true">
                  <path d="M5 5l6 6M11 5l-6 6" />
                </svg>
              </button>
            </span>
          ) : (
            <span className="project-add">
          <Dropdown
            label={
              <>
                <svg className="i" viewBox="0 0 16 16" aria-hidden="true">
                  <path d="M2.5 4.5h4l1.5 1.5h5.5v6.5h-11z" />
                </svg>
                project
              </>
            }
            title="Pick a project, or type @"
            value={NONE}
            options={projectOptions}
            width={340}
            onChange={async (value) => {
              if (value === OPEN) {
                const opened = await props.onPickFolder();
                if (opened) setProject(opened);
              } else {
                setProject(props.projects.find((entry) => entry.path === value) ?? null);
              }
              composer.current?.focus();
            }}
          />
            </span>
          )
        }
        projects={{
          items: props.projects.filter((entry) => entry.path !== project?.path).map((entry) => ({ path: entry.path, name: entry.name, hint: tilde(entry.path) })),
          onPick: (path) => setProject(props.projects.find((entry) => entry.path === path) ?? null),
          onOpenFolder: async () => {
            const opened = await props.onPickFolder();
            if (opened) setProject(opened);
            composer.current?.focus();
          },
        }}
        onBackspaceEmpty={() => setProject(null)}
        connections={props.connections}
        tools={
          <>
            <ModelPicker hotkey choice={props.choice} keys={props.keys} note="New agents start with this model." onChange={props.onChoice} />
            <EffortMenu value={effort} onChange={setEffort} />
            <ModeMenu value={mode} onChange={setMode} />
          </>
        }
        actions={<Pill variant="lime" small label="Start" onClick={start} disabled={Boolean(problem) || !text.trim()} />}
      />
      <span className="mono faint new-hint">
        ↵ start · @ project or file · ⌘/ model · ⌘[ ⌘] reasoning · ⇧Tab mode{props.variant === "dialog" ? " · esc close" : ""}
      </span>
    </div>
  );

  if (props.variant === "page") {
    return (
      <div className="new-page">
        <h1>New agent</h1>
        {form}
      </div>
    );
  }
  return (
    <div className="veil" onMouseDown={(event) => event.target === event.currentTarget && props.onClose?.()} onKeyDown={(event) => event.key === "Escape" && props.onClose?.()}>
      <div role="dialog" aria-label="New agent" aria-modal="true" className="launcher new-dialog fresh">
        <div className="launcher-head">
          <span className="cap">New agent</span>
          <button type="button" className="ghost mono esc" onClick={props.onClose}>
            esc
          </button>
        </div>
        {form}
        <span className="mono faint new-stay">Starts in the background. You stay where you are.</span>
      </div>
    </div>
  );
}
