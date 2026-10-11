import { useEffect, useRef, useState } from "react";
import * as bridge from "./bridge";
import { ModelPicker, type ModelChoice } from "./ModelPicker";
import { Pill } from "./Transcript";

type Section = "keys" | "models" | "connections" | "skills" | "memory" | "mirror" | "appearance" | "shortcuts";

const SECTIONS: [Section, string][] = [
  ["keys", "Keys"],
  ["models", "Models"],
  ["connections", "Connections"],
  ["skills", "Skills"],
  ["memory", "Memory"],
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

function Skills() {
  const [found, setFound] = useState<bridge.Skill[]>([]);
  const [dir, setDir] = useState("~/.mirror/skills");
  useEffect(() => {
    bridge.listSkills(null).then(setFound).catch(() => {});
    bridge.memoryInfo().then((info) => info && setDir(info.skills_dir)).catch(() => {});
  }, []);
  return (
    <>
      <p className="muted settings-lead">
        Skills are Mirror's: a folder with a SKILL.md that says what it is for. Mirror tells the model which skills exist, and loads one in full when a message names it with $name. Type $ in the box to pick one.
      </p>
      <div className="kv mono">
        {found.map((skill) => (
          <div key={skill.path} title={skill.path}>
            <span>${skill.name}</span>
            <span className="faint skill-desc">{skill.description}</span>
          </div>
        ))}
        {!found.length && <span className="faint">No personal skills yet.</span>}
      </div>
      <p className="muted settings-lead">
        Personal skills live in <span className="mono">{dir.replace(/^\/Users\/[^/]+/, "~")}</span> and work in every project. A project's own go in <span className="mono">.agents/skills</span> or{" "}
        <span className="mono">.claude/skills</span>; they show in the box when an agent works there.
      </p>
      {bridge.inTauri && (
        <div>
          <button type="button" className="btn ghost" style={{ fontWeight: 400 }} onClick={() => bridge.openPath(dir).catch(() => {})}>
            Open the skills folder
          </button>
        </div>
      )}
    </>
  );
}

function Memory() {
  const [info, setInfo] = useState<bridge.MemoryInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const refresh = () => bridge.memoryInfo().then(setInfo).catch((reason) => setError(String(reason)));
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
  return (
    <>
      <p className="muted settings-lead">
        Mirror's personal memory. When it is on, agents can search and save your preferences, facts and pitfalls, and the ones that matter are shown to the model each turn. It is the same switch as Mirror's
        /memory, so the CLI and Glass agree. Applies to agents started afterwards.
      </p>
      <div role="group" aria-label="Memory" className="segs wide" style={{ alignSelf: "flex-start" }}>
        {[false, true].map((on) => (
          <button key={String(on)} type="button" className="seg" aria-pressed={info?.enabled === on} onClick={() => toggle(on)} disabled={!info}>
            <span className="segin mono">{on ? "on" : "off"}</span>
          </button>
        ))}
      </div>
      {error && <span className="mono key-error">{error}</span>}
      <h3>{info?.records.length ? `${info.records.length} memories` : "Memories"}</h3>
      <div className="kv memory-list">
        {info?.records.map((record) => (
          <div key={record.id}>
            <span>{record.content}</span>
            <span className="mono faint">
              {record.kind}
              {record.repository ? ` · ${record.repository.split("/").pop()}` : ""}
            </span>
          </div>
        ))}
        {info && !info.records.length && <span className="faint">Nothing saved yet. Ask an agent to remember something, with memory on.</span>}
      </div>
      <p className="muted settings-lead">To change or forget one, ask an agent: Mirror's save_memory can forget, pin and unpin. Stored in {info?.store.replace(/^\/Users\/[^/]+/, "~") ?? "~/.mirror/memory"}.</p>
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
          {section === "skills" && <Skills />}
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
