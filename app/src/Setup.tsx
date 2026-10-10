import type { Setup as SetupInfo } from "./bridge";
import { ModelPicker, providerOf, type ModelChoice } from "./ModelPicker";
import { Pill } from "./Transcript";

function Check(props: { state: "done" | "attention" | "failed"; title: string; children: React.ReactNode }) {
  return (
    <section className="check" data-state={props.state}>
      <span className="sdot still" />
      <div className="check-body">
        <b>{props.title}</b>
        {props.children}
      </div>
    </section>
  );
}

/**
 * First run, and whenever no agent is open: is Mirror installed, which provider,
 * is it the version Glass was tested with. See docs/product.md, first run.
 */
export function Setup(props: {
  setup: SetupInfo | null;
  choice: ModelChoice;
  onChoice: (choice: ModelChoice) => void;
  onStart: () => void;
  onAddProject: () => void;
}) {
  const { setup } = props;
  if (!setup) return <span className="muted">Checking for Mirror</span>;
  const provider = providerOf(props.choice);
  const hasKey = !provider.key || setup.keys.includes(provider.key);
  const versionOk = setup.version === setup.tested_version;
  return (
    <div className="setup">
      <h1>Start an agent</h1>
      <Check state={setup.worker ? "done" : "failed"} title={setup.worker ? `Mirror ${setup.version ?? ""} found` : "Mirror not found"}>
        {setup.worker ? (
          <span className="mono faint path">{setup.worker.replace(/^\/Users\/[^/]+/, "~")}</span>
        ) : (
          <>
            <span className="muted">Install it, then reopen Glass.</span>
            <code className="mono command">{setup.mirror_command}</code>
          </>
        )}
      </Check>
      <Check state={hasKey ? "done" : "attention"} title="Provider">
        <ModelPicker choice={props.choice} keys={setup.keys} note="New agents start with this model." onChange={props.onChoice} />
        <span className="mono faint">
          {hasKey
            ? provider.key
              ? `${provider.key} is set`
              : "no key needed for a custom endpoint"
            : `${provider.key} is not set. Add it to your shell profile, then reopen Glass. Glass never asks you to type a key.`}
        </span>
        {setup.keys.length > 0 && <span className="mono faint">keys found · {setup.keys.join(" · ")}</span>}
      </Check>
      {!versionOk && setup.version && (
        <Check state="attention" title={`Mirror ${setup.version}`}>
          <span className="muted">Glass was tested with Mirror {setup.tested_version}. Most things should work; report anything that does not.</span>
        </Check>
      )}
      <div className="setup-actions">
        <Pill variant="lime" label="Open a project" onClick={props.onAddProject} disabled={!setup.worker} />
        <button type="button" className="btn ghost" style={{ fontWeight: 400 }} onClick={props.onStart} disabled={!setup.worker}>
          Start without a project<span className="kbd">⌘K</span>
        </button>
      </div>
    </div>
  );
}
