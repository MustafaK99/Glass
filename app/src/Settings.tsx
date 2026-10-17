import { useEffect, useRef, useState } from "react";
import * as bridge from "./bridge";
import { ModelPicker, type ModelChoice } from "./ModelPicker";
import { Pill } from "./Transcript";

type Section = "keys" | "models" | "skills" | "memory" | "projects" | "connections" | "mirror" | "appearance" | "shortcuts";

const SECTIONS: [Section, string][] = [
  ["keys", "Keys"],
  ["models", "Models"],
  ["skills", "Skills"],
  ["memory", "Memory"],
  ["projects", "Projects"],
  ["connections", "Connections"],
  ["mirror", "Mirror"],
  ["appearance", "Appearance"],
  ["shortcuts", "Shortcuts"],
];

const SOURCE: Record<bridge.SecretStatus["source"], string> = {
  keychain: "saved in Keychain",
  environment: "from your shell",
  none: "not set",
};

/** One key: where it comes from, and a password field to add or replace it. */
function KeyRow(props: { status: bridge.SecretStatus; onChanged: () => void }) {
  const { status } = props;
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const field = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing) field.current?.focus();
  }, [editing]);

  const save = async () => {
    if (!value.trim()) return;
    setBusy(true);
    try {
      await bridge.secretSet(status.name, value);
      setValue("");
      setEditing(false);
      setError(null);
      props.onChanged();
    } catch (reason) {
      setError(String(reason));
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => {
    await bridge.secretRemove(status.name).catch((reason) => setError(String(reason)));
    props.onChanged();
  };

  return (
    <div className="key-row" data-state={status.source === "none" ? "stopped" : "done"}>
      <div className="key-head">
        <span className="sdot still" />
        <span className="key-name">
          <b>{status.provider ?? status.name}</b>
          {status.provider && <span className="mono faint">{status.name}</span>}
        </span>
        <span className="mono faint key-source">
          {SOURCE[status.source]}
          {status.hint ? ` · …${status.hint}` : ""}
        </span>
        {!editing && (
          <span className="key-actions">
            <button type="button" className="btn ghost" style={{ fontWeight: 400 }} onClick={() => setEditing(true)}>
              {status.source === "keychain" ? "Replace" : "Add key"}
            </button>
            {status.source === "keychain" && (
              <button type="button" className="btn ghost danger" style={{ fontWeight: 400 }} onClick={remove}>
                Remove
              </button>
            )}
          </span>
        )}
      </div>
      {editing && (
        <form
          className="key-edit"
          onSubmit={(event) => {
            event.preventDefault();
            save();
          }}
        >
          <input
            ref={field}
            className="field mono"
            type="password"
            value={value}
            onChange={(event) => setValue(event.target.value)}
            placeholder={`Paste your ${status.provider ?? status.name} key`}
            aria-label={`${status.name} value`}
            autoComplete="off"
            spellCheck={false}
            autoCorrect="off"
            autoCapitalize="off"
          />
          <button type="button" className="btn ghost" style={{ fontWeight: 400 }} onClick={() => (setEditing(false), setValue(""), setError(null))}>
            Cancel
          </button>
          <button type="submit" className="btn" disabled={!value.trim() || busy}>
            Save to Keychain
          </button>
        </form>
      )}
      {status.source === "environment" && !editing && <span className="mono faint key-note">A key saved here takes over from the shell's.</span>}
      {error && <span className="mono key-error">{error}</span>}
    </div>
  );
}

const TEMPLATES: { name: string; description: string; instructions: string }[] = [
  {
    name: "code-review",
    description: "Use when asked to review code or a diff before it is merged.",
    instructions: "1. Run the tests first and say whether they pass.\n2. Read the whole diff before commenting.\n3. List problems by severity: bugs, then risks, then style.\n4. Quote the line for each point and suggest the fix.",
  },
  {
    name: "commit-message",
    description: "Use when writing a git commit message.",
    instructions: "- First line: what changed, in the imperative, under 60 characters.\n- A blank line, then why, in plain sentences.\n- No emoji. Mention any follow-up work.",
  },
  {
    name: "tests-first",
    description: "Use when fixing a bug or adding a feature that can be tested.",
    instructions: "1. Write a test that fails for the bug or the missing behaviour.\n2. Run it and show that it fails.\n3. Make the smallest change that makes it pass.\n4. Run the whole suite.",
  },
];

/** One skill being written or edited: name, when to use it, what to do. */
function SkillForm(props: {
  projects: bridge.Project[];
  editing: bridge.Skill | null;
  start: { name: string; description: string; instructions: string; scope: "personal" | "project"; project: string | null };
  onDone: () => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(props.start.name);
  const [description, setDescription] = useState(props.start.description);
  const [instructions, setInstructions] = useState(props.start.instructions);
  const [scope, setScope] = useState(props.start.scope);
  const [project, setProject] = useState<string | null>(props.start.project ?? props.projects[0]?.path ?? null);
  const [error, setError] = useState<string | null>(null);
  const slug = (text: string) => text.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+/, "").slice(0, 48);
  const save = async () => {
    try {
      await bridge.skillSave(scope, scope === "project" ? project : null, name, description, instructions, props.editing?.path ?? null);
      props.onDone();
    } catch (reason) {
      setError(String(reason));
    }
  };
  return (
    <form
      className="skill-form"
      onSubmit={(event) => {
        event.preventDefault();
        save();
      }}
    >
      <label>
        <span className="cap">Name</span>
        <input className="field mono" value={name} onChange={(event) => setName(slug(event.target.value))} placeholder="code-review" autoFocus />
        <span className="mono faint">Used as ${name || "name"} in a message.</span>
      </label>
      <label>
        <span className="cap">When Mirror should use it</span>
        <input className="field" value={description} onChange={(event) => setDescription(event.target.value)} placeholder="Use when asked to review code before it is merged." />
        <span className="mono faint">Mirror shows the model this line, and the model picks skills from it.</span>
      </label>
      <label>
        <span className="cap">Instructions</span>
        <textarea className="field skill-body" value={instructions} onChange={(event) => setInstructions(event.target.value)} placeholder="Steps, rules, checklists. Markdown is fine." />
      </label>
      <div className="skill-scope">
        <div role="group" aria-label="Who can use it" className="segs">
          {(["personal", "project"] as const).map((option) => (
            <button key={option} type="button" className="seg" aria-pressed={scope === option} onClick={() => setScope(option)} disabled={option === "project" && !props.projects.length}>
              <span className="segin mono">{option === "personal" ? "every project" : "one project"}</span>
            </button>
          ))}
        </div>
        {scope === "project" && (
          <select className="field" value={project ?? ""} onChange={(event) => setProject(event.target.value)} aria-label="Project">
            {props.projects.map((entry) => (
              <option key={entry.path} value={entry.path}>
                {entry.name}
              </option>
            ))}
          </select>
        )}
      </div>
      {error && <span className="mono key-error">{error}</span>}
      <span className="commit-actions">
        <button type="button" className="btn ghost" style={{ fontWeight: 400 }} onClick={props.onCancel}>
          Cancel
        </button>
        <button type="submit" className="btn" disabled={!name || !description.trim()}>
          {props.editing ? "Save skill" : "Create skill"}
        </button>
      </span>
    </form>
  );
}

function Skills(props: { projects: bridge.Project[] }) {
  const [found, setFound] = useState<bridge.Skill[]>([]);
  const [form, setForm] = useState<{ editing: bridge.Skill | null; start: Parameters<typeof SkillForm>[0]["start"] } | null>(null);
  const refresh = async () => {
    // Personal skills, and each saved project's own.
    const lists = await Promise.all([bridge.listSkills(null), ...props.projects.map((project) => bridge.listSkills(project.path))]);
    const seen = new Map<string, bridge.Skill>();
    for (const skill of lists.flat()) seen.set(skill.path, skill);
    setFound([...seen.values()].sort((a, b) => a.name.localeCompare(b.name)));
  };
  useEffect(() => {
    refresh().catch(() => {});
  }, [props.projects.length]);
  const projectOf = (skill: bridge.Skill) => props.projects.find((project) => skill.path.startsWith(`${project.path}/`));
  const edit = async (skill: bridge.Skill) => {
    const instructions = await bridge.skillInstructions(skill.path).catch(() => "");
    const project = projectOf(skill);
    setForm({ editing: skill, start: { name: skill.name, description: skill.description, instructions, scope: skill.scope, project: project?.path ?? null } });
  };
  if (form) {
    return (
      <SkillForm
        projects={props.projects}
        editing={form.editing}
        start={form.start}
        onCancel={() => setForm(null)}
        onDone={() => {
          setForm(null);
          refresh();
        }}
      />
    );
  }
  return (
    <>
      <p className="muted settings-lead">
        A skill is a set of instructions Mirror can follow: a checklist, a house style, a procedure. Mirror tells the model which skills exist; it uses one when it fits, or when a message names it with $name.
      </p>
      <div className="skill-list">
        {found.map((skill) => (
          <div key={skill.path} className="skill-row">
            <span className="skill-main">
              <b className="mono">${skill.name}</b>
              <span className="muted">{skill.description}</span>
            </span>
            <span className="mono faint">{skill.scope === "personal" ? "every project" : (projectOf(skill)?.name ?? "project")}</span>
            <span className="key-actions">
              <button type="button" className="btn ghost" style={{ fontWeight: 400 }} onClick={() => edit(skill)}>
                Edit
              </button>
              <button
                type="button"
                className="btn ghost danger"
                style={{ fontWeight: 400 }}
                onClick={() => bridge.skillDelete(skill.path).then(refresh).catch(() => {})}
              >
                Delete
              </button>
            </span>
          </div>
        ))}
        {!found.length && <span className="faint">No skills yet. Start from one below.</span>}
      </div>
      <div className="skill-new">
        <button type="button" className="btn" onClick={() => setForm({ editing: null, start: { name: "", description: "", instructions: "", scope: "personal", project: null } })}>
          New skill
        </button>
        <span className="mono faint">or start from</span>
        {TEMPLATES.filter((template) => !found.some((skill) => skill.name === template.name)).map((template) => (
          <button key={template.name} type="button" className="menu-chip mono" onClick={() => setForm({ editing: null, start: { ...template, scope: "personal", project: null } })}>
            {template.name}
          </button>
        ))}
      </div>
    </>
  );
}

const KINDS = ["preference", "fact", "procedure", "pitfall", "reference"] as const;
const KIND_HINT: Record<(typeof KINDS)[number], string> = {
  preference: "how you like things done",
  fact: "something true about you or your work",
  procedure: "steps for a recurring task",
  pitfall: "a mistake to avoid",
  reference: "where to find something",
};

function MemoryForm(props: { record: bridge.MemoryInfo["records"][number] | null; onDone: () => void; onCancel: () => void }) {
  const [kind, setKind] = useState<(typeof KINDS)[number]>((props.record?.kind as (typeof KINDS)[number]) ?? "preference");
  const [content, setContent] = useState(props.record?.content ?? "");
  const [situation, setSituation] = useState(props.record?.situation ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const save = async () => {
    setBusy(true);
    try {
      await bridge.memorySave({ action: "remember", kind, content: content.trim(), ...(situation.trim() ? { situation: situation.trim() } : {}) });
      // An edit saves the new version first, then forgets the old one by its exact
      // id: nothing is lost if either step fails, and duplicate keys cannot confuse it.
      if (props.record) await bridge.memorySave({ action: "forget", id: props.record.id });
      props.onDone();
    } catch (reason) {
      setError(String(reason));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form
      className="skill-form"
      onSubmit={(event) => {
        event.preventDefault();
        save();
      }}
    >
      <label>
        <span className="cap">Remember</span>
        <textarea className="field" rows={3} value={content} onChange={(event) => setContent(event.target.value)} placeholder="I use pnpm, not npm." autoFocus />
      </label>
      <div className="skill-scope">
        <select className="field" value={kind} onChange={(event) => setKind(event.target.value as (typeof KINDS)[number])} aria-label="Kind">
          {KINDS.map((option) => (
            <option key={option} value={option}>
              {option} · {KIND_HINT[option]}
            </option>
          ))}
        </select>
        <input className="field" value={situation} onChange={(event) => setSituation(event.target.value)} placeholder="When it applies, if not always: writing Python" aria-label="When it applies" />
      </div>
      {error && <span className="mono key-error">{error}</span>}
      <span className="commit-actions">
        <button type="button" className="btn ghost" style={{ fontWeight: 400 }} onClick={props.onCancel}>
          Cancel
        </button>
        <button type="submit" className="btn" disabled={busy || !content.trim()}>
          {busy ? "Saving…" : props.record ? "Save changes" : "Remember"}
        </button>
      </span>
    </form>
  );
}

function Memory() {
  const [info, setInfo] = useState<bridge.MemoryInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState<{ record: bridge.MemoryInfo["records"][number] | null } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [imported, setImported] = useState<string | null>(null);
  const refresh = () => bridge.memoryInfo().then(setInfo).catch((reason) => setError(String(reason)));
  const importMemories = async () => {
    setBusy("import");
    setImported(null);
    try {
      setImported(await bridge.memoryImport());
      setError(null);
      refresh();
    } catch (reason) {
      setError(String(reason));
    } finally {
      setBusy(null);
    }
  };
  useEffect(() => {
    refresh();
  }, []);
  const toggle = async (enabled: boolean) => {
    try {
      await bridge.setMemory(enabled);
      setError(null);
      refresh();
    } catch (reason) {
      setError(String(reason));
    }
  };
  const forget = async (record: bridge.MemoryInfo["records"][number]) => {
    setBusy(record.id);
    try {
      await bridge.memorySave({ action: "forget", id: record.id });
      refresh();
    } catch (reason) {
      setError(String(reason));
    } finally {
      setBusy(null);
    }
  };
  if (form) {
    return (
      <MemoryForm
        record={form.record}
        onCancel={() => setForm(null)}
        onDone={() => {
          setForm(null);
          refresh();
        }}
      />
    );
  }
  const groups = KINDS.map((kind) => ({ kind, records: info?.records.filter((record) => record.kind === kind) ?? [] })).filter((group) => group.records.length);
  return (
    <>
      <p className="muted settings-lead">
        With memory on, agents remember what you tell them to and look it up when it matters: your preferences, facts about your work, mistakes to avoid. It is Mirror's own memory, the same as its /memory, kept on this
        Mac. Applies to agents started afterwards.
      </p>
      <div className="memory-top">
        <div role="group" aria-label="Memory" className="segs wide">
          {[false, true].map((on) => (
            <button key={String(on)} type="button" className="seg" aria-pressed={info?.enabled === on} onClick={() => toggle(on)} disabled={!info}>
              <span className="segin mono">{on ? "on" : "off"}</span>
            </button>
          ))}
        </div>
        <button type="button" className="btn" onClick={() => setForm({ record: null })} disabled={!bridge.inTauri}>
          Add a memory
        </button>
      </div>
      <div className="memory-extra">
        <button
          type="button"
          className="btn ghost"
          style={{ fontWeight: 400 }}
          disabled={!bridge.inTauri || busy === "import"}
          title="Bring in the memories Claude Code and Codex keep on this Mac, under your name, with Mirror's own import"
          onClick={importMemories}
        >
          {busy === "import" ? "Importing…" : "Import from Claude Code and Codex"}
        </button>
        <button
          type="button"
          className="btn ghost"
          style={{ fontWeight: 400 }}
          disabled={!bridge.inTauri}
          title="Bullets in this file are always in front of the model while memory is on. Edit it by hand, or let agents pin memories."
          onClick={() => bridge.pinnedMemoriesPath().then(bridge.openInEditor).catch((reason) => setError(String(reason)))}
        >
          Pinned memories
        </button>
      </div>
      {imported && <span className="mono faint memory-imported">{imported}</span>}
      {error && <span className="mono key-error">{error}</span>}
      {groups.map((group) => (
        <section key={group.kind} className="memory-group">
          <span className="cap">
            {group.kind}s · {KIND_HINT[group.kind]}
          </span>
          {group.records.map((record) => (
            <div key={record.id} className="skill-row">
              <span className="skill-main">
                <span>{record.content}</span>
                {(record.situation || record.repository) && (
                  <span className="mono faint">
                    {[record.situation && `when ${record.situation}`, record.repository && record.repository.split("/").pop()].filter(Boolean).join(" · ")}
                  </span>
                )}
              </span>
              <span className="key-actions">
                <button type="button" className="btn ghost" style={{ fontWeight: 400 }} onClick={() => setForm({ record })}>
                  Edit
                </button>
                <button type="button" className="btn ghost danger" style={{ fontWeight: 400 }} disabled={busy === record.id} onClick={() => forget(record)}>
                  {busy === record.id ? "Forgetting…" : "Forget"}
                </button>
              </span>
            </div>
          ))}
        </section>
      ))}
      {info && !info.records.length && <span className="faint">Nothing remembered yet. Add one here, or tell an agent "remember that…" with memory on.</span>}
    </>
  );
}

/** Each project's setup command, run in every new checkout before its agent starts. */
function Projects(props: { projects: bridge.Project[]; onChanged: () => void }) {
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [saved, setSaved] = useState<string | null>(null);
  return (
    <>
      <p className="muted settings-lead">
        A setup command runs in each new checkout of a project before its agent starts, for example installing packages. Its output shows at the top of that agent's conversation. The agent starts even if it fails.
      </p>
      <div className="key-list">
        {props.projects.map((project) => {
          const value = drafts[project.path] ?? project.setup ?? "";
          return (
            <form
              key={project.path}
              className="key-row"
              onSubmit={(event) => {
                event.preventDefault();
                bridge
                  .setProjectSetup(project.path, value.trim() || null)
                  .then(() => {
                    setSaved(project.path);
                    props.onChanged();
                  })
                  .catch(() => {});
              }}
            >
              <div className="key-head">
                <span className="key-name">
                  <b>{project.name}</b>
                  <span className="mono faint">{project.path.replace(/^\/Users\/[^/]+/, "~")}</span>
                </span>
              </div>
              <div className="key-edit">
                <input
                  className="field mono"
                  value={value}
                  onChange={(event) => setDrafts((current) => ({ ...current, [project.path]: event.target.value }))}
                  placeholder="npm install"
                  aria-label={`Setup command for ${project.name}`}
                  spellCheck={false}
                />
                <button type="submit" className="btn">
                  {saved === project.path && value === (project.setup ?? "") ? "Saved" : "Save"}
                </button>
              </div>
            </form>
          );
        })}
        {!props.projects.length && <span className="faint">No projects yet. Open one from New agent.</span>}
      </div>
    </>
  );
}

function Keys() {
  const [statuses, setStatuses] = useState<bridge.SecretStatus[]>([]);
  const [newName, setNewName] = useState("");
  const refresh = () => bridge.secretsStatus().then(setStatuses).catch(() => {});
  useEffect(() => {
    refresh();
  }, []);
  const providers = statuses.filter((status) => status.provider);
  const others = statuses.filter((status) => !status.provider);
  const validName = /^[A-Z][A-Z0-9_]{1,63}$/.test(newName);
  return (
    <>
      <p className="muted settings-lead">
        Keys are saved in the macOS Keychain, never in a file, and only Mirror's worker receives them, through its environment when it starts. Glass never shows a saved key again. Changes apply to agents started
        afterwards.
      </p>
      <div className="key-list">
        {providers.map((status) => (
          <KeyRow key={status.name} status={status} onChanged={refresh} />
        ))}
      </div>
      <h3>Other variables</h3>
      <p className="muted settings-lead">For MCP servers that name a token variable, such as tokenEnvVar or env in ~/.mirror/mcp.</p>
      <div className="key-list">
        {others.map((status) => (
          <KeyRow key={status.name} status={status} onChanged={refresh} />
        ))}
      </div>
      <form
        className="key-add"
        onSubmit={(event) => {
          event.preventDefault();
          if (!validName) return;
          setStatuses((current) => [...current.filter((status) => status.name !== newName), { name: newName, provider: null, source: "none", hint: null }]);
          setNewName("");
        }}
      >
        <input className="field mono" value={newName} onChange={(event) => setNewName(event.target.value.toUpperCase())} placeholder="VARIABLE_NAME" aria-label="Variable name" spellCheck={false} />
        <button type="submit" className="btn ghost" style={{ fontWeight: 400 }} disabled={!validName}>
          Add variable
        </button>
      </form>
    </>
  );
}

export function Settings(props: {
  setup: bridge.Setup | null;
  choice: ModelChoice;
  keys: string[];
  servers: bridge.McpServer[];
  projects: bridge.Project[];
  onProjectsChanged: () => void;
  theme: "cream" | "dark";
  onTheme: (theme: "cream" | "dark") => void;
  onChoice: (choice: ModelChoice) => void;
  onKeysChanged: () => void;
  onClose: () => void;
}) {
  const [section, setSection] = useState<Section>("keys");
  const close = () => {
    props.onKeysChanged();
    props.onClose();
  };
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => event.key === "Escape" && close();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });
  const { setup } = props;
  return (
    <div className="veil" onMouseDown={(event) => event.target === event.currentTarget && close()}>
      <div role="dialog" aria-label="Settings" aria-modal="true" className="settings fresh">
        <nav className="settings-nav" aria-label="Settings sections">
          <span className="cap">Settings</span>
          {SECTIONS.map(([id, label]) => (
            <button key={id} type="button" className="row settings-tab" aria-current={section === id} onClick={() => setSection(id)}>
              {label}
            </button>
          ))}
        </nav>
        <div className="settings-body scroll">
          <div className="settings-head">
            <h2>{SECTIONS.find(([id]) => id === section)![1]}</h2>
            <button type="button" className="ghost mono esc" onClick={close}>
              esc
            </button>
          </div>
          {section === "keys" && <Keys />}
          {section === "skills" && <Skills projects={props.projects} />}
          {section === "projects" && <Projects projects={props.projects} onChanged={props.onProjectsChanged} />}
          {section === "memory" && <Memory />}
          {section === "models" && (
            <>
              <p className="muted settings-lead">The model new agents start with. Each agent can switch from its composer, or with ⌘/.</p>
              <ModelPicker choice={props.choice} keys={props.keys} note="New agents start with this model." onChange={props.onChoice} />
            </>
          )}
          {section === "connections" && (
            <>
              <p className="muted settings-lead">
                MCP servers come from Mirror's own config, one JSON file per server in ~/.mirror/mcp. New agents get their tools; Mirror asks before each call in manual mode. Servers that need a browser
                sign-in are not supported yet.
              </p>
              <div className="kv mono">
                {props.servers.map((server) => (
                  <div key={server.name} title={server.detail ?? undefined}>
                    <span>{server.name}</span>
                    <span className="faint">{server.status === "connected" ? `${server.tools.length} tools` : server.status}</span>
                  </div>
                ))}
                {!props.servers.length && <span className="faint">No servers configured.</span>}
              </div>
            </>
          )}
          {section === "mirror" && (
            <div className="kv mono">
              <div>
                <span className="faint">worker</span>
                <span>{setup?.worker ?? "not found"}</span>
              </div>
              <div>
                <span className="faint">version</span>
                <span>{setup?.version ?? "–"}</span>
              </div>
              <div>
                <span className="faint">tested with</span>
                <span>{setup?.tested_version ?? "–"}</span>
              </div>
              {!setup?.worker && setup?.mirror_command && (
                <div>
                  <span className="faint">install</span>
                  <code className="command">{setup.mirror_command}</code>
                </div>
              )}
            </div>
          )}
          {section === "appearance" && (
            <div role="group" aria-label="Theme" className="segs wide" style={{ alignSelf: "flex-start" }}>
              {(["cream", "dark"] as const).map((theme) => (
                <button key={theme} type="button" className="seg" aria-pressed={props.theme === theme} onClick={() => props.onTheme(theme)}>
                  <span className="segin mono">{theme}</span>
                </button>
              ))}
            </div>
          )}
          {section === "shortcuts" && (
            <div className="kv mono">
              {[
                ["⌘N", "new agent"],
                ["⌘K", "new agent without leaving this one"],
                ["⌘/", "model"],
                ["⌘[ ⌘]", "reasoning effort"],
                ["⇧Tab", "manual or auto"],
                ["A R", "approve or reject"],
                ["Esc", "stop"],
                ["⌃`", "terminal"],
                ["!command", "run in the terminal"],
                ["@", "mention a file, project or connection"],
                ["$", "use a skill"],
                ["⌥↑ ⌥↓", "previous or next agent"],
                ["⌘B ⌘J", "hide agents or changes"],
                ["⌘T", "transcript view: detail, default, focus"],
                ["⌘,", "settings"],
              ].map(([key, what]) => (
                <div key={key}>
                  <span>{key}</span>
                  <span className="faint">{what}</span>
                </div>
              ))}
            </div>
          )}
          <div className="settings-foot">
            <Pill variant="dark" small label="Done" onClick={close} />
          </div>
        </div>
      </div>
    </div>
  );
}
