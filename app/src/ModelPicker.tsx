import { useEffect, useRef, useState } from "react";

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

/** "gpt-5-nano · OpenAI", for a chip. */
export function choiceLabel(choice: ModelChoice): string {
  const provider = providerOf(choice);
  return `${choice.model || "default"} · ${provider.custom && choice.baseUrl ? hostOf(choice.baseUrl) : provider.name}`;
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/**
 * Pick the provider and model. Glass never asks for a key: a provider whose key
 * is not in the environment says so, with the variable to set.
 */
export function ModelPicker(props: {
  choice: ModelChoice;
  keys: string[];
  note?: string;
  onChange: (choice: ModelChoice) => void;
}) {
  const [open, setOpen] = useState(false);
  // Opens toward whichever side of the chip has more room.
  const [upward, setUpward] = useState(false);
  const [draft, setDraft] = useState(props.choice);
  const root = useRef<HTMLDivElement>(null);
  const provider = providerOf(draft);

  useEffect(() => setDraft(props.choice), [props.choice]);
  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => {
      if (root.current && !root.current.contains(event.target as Node)) setOpen(false);
    };
    window.addEventListener("mousedown", close);
    return () => window.removeEventListener("mousedown", close);
  }, [open]);

  const choose = (id: string) => {
    const next = PROVIDERS.find((entry) => entry.id === id)!;
    setDraft({
      api: next.api,
      model: next.suggestions[0] ?? (next.custom ? draft.model : ""),
      baseUrl: next.custom ? (draft.baseUrl ?? "http://127.0.0.1:8000/v1") : null,
    });
  };
  const apply = () => {
    props.onChange({ ...draft, model: draft.model.trim(), baseUrl: draft.baseUrl?.trim() || null });
    setOpen(false);
  };
  const missingKey = provider.key && !props.keys.includes(provider.key);

  return (
    <div className="picker" ref={root}>
      <button
        type="button"
        className="picker-chip mono"
        aria-expanded={open}
        onClick={() => {
          const box = root.current?.getBoundingClientRect();
          if (box) setUpward(window.innerHeight - box.bottom < 460 && box.top > window.innerHeight - box.bottom);
          setOpen(!open);
        }}
        title="Model and provider"
      >
        {choiceLabel(props.choice)}
        <svg className="i" viewBox="0 0 16 16" aria-hidden="true">
          <path d="M4.5 6.5 8 10l3.5-3.5" />
        </svg>
      </button>
      {open && (
        <div className={`picker-pop fresh ${upward ? "up" : "down"}`} role="dialog" aria-label="Model and provider">
          <span className="cap">Provider</span>
          <div className="picker-list">
            {PROVIDERS.map((entry) => {
              const has = !entry.key || props.keys.includes(entry.key);
              return (
                <button key={entry.id} type="button" className="row picker-row" aria-current={entry.id === provider.id} onClick={() => choose(entry.id)}>
                  <span>{entry.name}</span>
                  <span className="mono faint">{entry.custom ? "any OpenAI-compatible URL" : has ? "key set" : "no key"}</span>
                </button>
              );
            })}
          </div>
          <label className="picker-field">
            <span className="cap">Model</span>
            <input
              className="mono"
              value={draft.model}
              list="model-suggestions"
              onChange={(event) => setDraft({ ...draft, model: event.target.value })}
              onKeyDown={(event) => event.key === "Enter" && apply()}
              placeholder="model id"
              spellCheck={false}
            />
            <datalist id="model-suggestions">
              {provider.suggestions.map((name) => (
                <option key={name} value={name} />
              ))}
            </datalist>
          </label>
          {provider.custom && (
            <label className="picker-field">
              <span className="cap">Endpoint</span>
              <input
                className="mono"
                value={draft.baseUrl ?? ""}
                onChange={(event) => setDraft({ ...draft, baseUrl: event.target.value })}
                onKeyDown={(event) => event.key === "Enter" && apply()}
                placeholder="http://127.0.0.1:8000/v1"
                spellCheck={false}
              />
            </label>
          )}
          {missingKey && (
            <span className="mono faint picker-warn">
              {provider.key} is not set. Add it to your shell profile, then restart Glass.
            </span>
          )}
          {props.note && <span className="mono faint">{props.note}</span>}
          <div className="picker-foot">
            <button type="button" className="btn ghost" style={{ fontWeight: 400 }} onClick={() => setOpen(false)}>
              cancel
            </button>
            <button type="button" className="btn" onClick={apply}>
              Use this model
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
