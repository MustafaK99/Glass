import { useEffect, useMemo, useRef, useState } from "react";
import { Check, Chevron, placement, useDismiss } from "./Menu";

export interface ModelChoice {
  api: string;
  model: string;
  baseUrl: string | null;
}

/** Mirror's wire protocols, in its words, with the key each one reads. */
export const PROVIDERS: { id: string; api: string; name: string; key: string | null; custom?: boolean; suggestions: string[] }[] = [
  { id: "reflection", api: "reflection", name: "Reflection", key: "REFLECTION_API_KEY", suggestions: ["Beam-501B-A23B"] },
  { id: "openai", api: "openai-responses", name: "OpenAI", key: "OPENAI_API_KEY", suggestions: ["gpt-5-nano", "gpt-5-mini", "gpt-5"] },
  { id: "anthropic", api: "anthropic-messages", name: "Anthropic", key: "ANTHROPIC_API_KEY", suggestions: ["claude-sonnet-5-5", "claude-haiku-4-5-20251001", "claude-opus-5-5"] },
  { id: "openrouter", api: "openai-chat-completions", name: "OpenRouter", key: "OPENROUTER_API_KEY", suggestions: ["openai/gpt-5-nano", "anthropic/claude-sonnet-5-5"] },
  { id: "custom", api: "openai-chat-completions", name: "Custom endpoint", key: null, custom: true, suggestions: [] },
];

export function providerOf(choice: ModelChoice) {
  if (choice.api === "openai-chat-completions" && choice.baseUrl) return PROVIDERS[4];
  return PROVIDERS.find((provider) => provider.api === choice.api && !provider.custom) ?? PROVIDERS[0];
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** "gpt-5-nano · OpenAI", for a chip or the session panel. */
export function choiceLabel(choice: ModelChoice): string {
  const provider = providerOf(choice);
  return `${choice.model || "default"} · ${provider.custom && choice.baseUrl ? hostOf(choice.baseUrl) : provider.name}`;
}

const RECENT_KEY = "glass.models.recent";

function loadRecent(): ModelChoice[] {
  try {
    const value = JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]");
    return Array.isArray(value) ? value.slice(0, 4) : [];
  } catch {
    return [];
  }
}

function remember(choice: ModelChoice) {
  const same = (a: ModelChoice) => a.api === choice.api && a.model === choice.model && (a.baseUrl ?? null) === (choice.baseUrl ?? null);
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify([choice, ...loadRecent().filter((entry) => !same(entry))].slice(0, 4)));
  } catch {
    // Storage can be unavailable; recents just will not persist.
  }
}

interface Row {
  key: string;
  section: string;
  label: string;
  hint: string;
  choice: ModelChoice | null;
  /** Opens the inline field for a model id or an endpoint. */
  custom?: "model" | "endpoint";
  /** Key status, shown once beside the provider's heading. */
  status?: string;
  provider: (typeof PROVIDERS)[number];
}

/**
 * The model menu. Type to filter, arrows to move, Enter to pick; one click picks.
 * Glass never asks for a key: a provider whose key is not set says which
 * variable to add to the shell profile.
 */
/** Asks the model menu that has `hotkey` set to open. Bound to Cmd /. */
export const openModelMenu = () => window.dispatchEvent(new Event("glass:model-menu"));

export function ModelPicker(props: { choice: ModelChoice; keys: string[]; note?: string; hotkey?: boolean; onChange: (choice: ModelChoice) => void }) {
  const [open, setOpen] = useState(false);
  const [side, setSide] = useState<"up" | "down">("down");
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [editing, setEditing] = useState<{ provider: string; model: string; baseUrl: string } | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const close = () => {
    setOpen(false);
    setEditing(null);
    setQuery("");
  };
  useDismiss(open, root, close);
  const show = () => {
    setSide(placement(root.current, 440));
    setActive(0);
    setOpen(true);
    setTimeout(() => search.current?.focus(), 0);
  };
  useEffect(() => {
    if (!props.hotkey) return;
    const onOpen = () => show();
    window.addEventListener("glass:model-menu", onOpen);
    return () => window.removeEventListener("glass:model-menu", onOpen);
  }, [props.hotkey]);

  const hasKey = (provider: Row["provider"]) => !provider.key || props.keys.includes(provider.key);
  const isCurrent = (choice: ModelChoice | null) =>
    !!choice && choice.api === props.choice.api && choice.model === props.choice.model && (choice.baseUrl ?? null) === (props.choice.baseUrl ?? null);

  const rows = useMemo<Row[]>(() => {
    const out: Row[] = [];
    for (const recent of loadRecent()) {
      const provider = providerOf(recent);
      out.push({ key: `recent-${recent.api}-${recent.model}-${recent.baseUrl}`, section: "Recent", label: recent.model, hint: provider.custom && recent.baseUrl ? hostOf(recent.baseUrl) : provider.name, choice: recent, provider });
    }
    for (const provider of PROVIDERS) {
      const section = provider.name;
      const status = provider.custom ? "any OpenAI-compatible URL, no key needed" : hasKey(provider) ? "key set" : `no key · set ${provider.key}`;
      for (const model of provider.suggestions) {
        out.push({ key: `${provider.id}-${model}`, section, label: model, hint: "", choice: { api: provider.api, model, baseUrl: null }, provider });
      }
      out.push({ key: `${provider.id}-other`, section, label: provider.custom ? "Set endpoint…" : "Other model id…", hint: "", choice: null, custom: provider.custom ? "endpoint" : "model", provider, status });
    }
    const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    return words.length ? out.filter((row) => words.every((word) => `${row.label} ${row.section}`.toLowerCase().includes(word))) : out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, props.keys, open]);

  const choose = (choice: ModelChoice) => {
    remember(choice);
    props.onChange(choice);
    close();
  };
  const pick = (row: Row | undefined) => {
    if (!row) return;
    if (row.choice) return choose(row.choice);
    // A typed query becomes the model id, so "gpt-5.1" Enter on "Other model id…" just works.
    setEditing({ provider: row.provider.id, model: row.custom === "model" ? query.trim() : props.choice.model, baseUrl: props.choice.baseUrl ?? "http://127.0.0.1:8000/v1" });
  };
  const applyEditing = () => {
    if (!editing?.model.trim()) return;
    const provider = PROVIDERS.find((entry) => entry.id === editing.provider)!;
    choose({ api: provider.api, model: editing.model.trim(), baseUrl: provider.custom ? editing.baseUrl.trim() || null : null });
  };

  const onKey = (event: React.KeyboardEvent) => {
    if (editing) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (!rows.length) return;
      setActive((index) => (index + (event.key === "ArrowDown" ? 1 : rows.length - 1)) % rows.length);
    } else if (event.key === "Enter") {
      event.preventDefault();
      pick(rows[active]);
    }
  };

  const provider = providerOf(props.choice);
  return (
    <div className="menu" ref={root}>
      <button
        type="button"
        className="menu-chip mono"
        aria-haspopup="dialog"
        aria-expanded={open}
        data-state={hasKey(provider) ? undefined : "attention"}
        title={hasKey(provider) ? "Model · ⌘/" : `${provider.key} is not set`}
        onClick={() => (open ? close() : show())}
      >
        {!hasKey(provider) && <span className="sdot" />}
        {props.choice.model || "default"}
        <span className="faint">{provider.custom && props.choice.baseUrl ? hostOf(props.choice.baseUrl) : provider.name}</span>
        <Chevron />
      </button>
      {open && (
        <div className={`menu-pop model-pop fresh ${side}`} role="dialog" aria-label="Model" onKeyDown={onKey}>
          {editing ? (
            <div className="model-edit">
              <span className="cap">{PROVIDERS.find((entry) => entry.id === editing.provider)!.name}</span>
              {PROVIDERS.find((entry) => entry.id === editing.provider)!.custom && (
                <input
                  className="mono field"
                  value={editing.baseUrl}
                  placeholder="http://127.0.0.1:8000/v1"
                  aria-label="Endpoint"
                  spellCheck={false}
                  onChange={(event) => setEditing({ ...editing, baseUrl: event.target.value })}
                  onKeyDown={(event) => event.key === "Enter" && applyEditing()}
                />
              )}
              <input
                className="mono field"
                autoFocus
                value={editing.model}
                placeholder="model id"
                aria-label="Model id"
                spellCheck={false}
                onChange={(event) => setEditing({ ...editing, model: event.target.value })}
                onKeyDown={(event) => event.key === "Enter" && applyEditing()}
              />
              <div className="model-edit-foot">
                <button type="button" className="link-btn mono faint" onClick={() => setEditing(null)}>
                  back
                </button>
                <button type="button" className="btn" onClick={applyEditing} disabled={!editing.model.trim()}>
                  Use model
                </button>
              </div>
            </div>
          ) : (
            <>
              <input
                ref={search}
                className="mono field"
                value={query}
                placeholder="Search models"
                aria-label="Search models"
                spellCheck={false}
                onChange={(event) => {
                  setQuery(event.target.value);
                  setActive(0);
                }}
              />
              <div className="model-list">
                {rows.map((row, index) => (
                  <div key={row.key}>
                    {(index === 0 || rows[index - 1].section !== row.section) && (
                      <span className="model-section">
                        <span className="cap">{row.section}</span>
                        {row.section !== "Recent" && (
                          <span className={`mono faint${hasKey(row.provider) ? "" : " warn"}`}>
                            {row.provider.custom ? "no key needed" : hasKey(row.provider) ? "key set" : `set ${row.provider.key}`}
                          </span>
                        )}
                      </span>
                    )}
                    <button
                      type="button"
                      className="row menu-row"
                      aria-current={index === active}
                      onMouseEnter={() => setActive(index)}
                      onClick={() => pick(row)}
                    >
                      <span className="menu-label">
                        <span className={row.choice ? "mono" : "faint"}>{row.label}</span>
                        {row.hint && <span className={`mono faint${!hasKey(row.provider) ? " warn" : ""}`}>{row.hint}</span>}
                      </span>
                      {isCurrent(row.choice) && <Check />}
                    </button>
                  </div>
                ))}
                {!rows.length && (
                  <button type="button" className="row menu-row" onClick={() => setEditing({ provider: provider.id === "custom" ? "custom" : provider.id, model: query.trim(), baseUrl: props.choice.baseUrl ?? "" })}>
                    <span className="menu-label">
                      <span>
                        Use <span className="mono">{query.trim()}</span> with {provider.name}
                      </span>
                    </span>
                  </button>
                )}
              </div>
              {props.note && <div className="menu-foot mono faint">{props.note}</div>}
            </>
          )}
        </div>
      )}
    </div>
  );
}
