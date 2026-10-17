import type { Setup as SetupInfo } from "./bridge";
import { providerOf, type ModelChoice } from "./ModelPicker";

/**
 * The setup check from docs/product.md, shown above the new-agent page only when
 * something needs fixing: Mirror missing, no key for the chosen provider, or a
 * Mirror version Glass was not tested with. When all is well it shows nothing.
 */
export function SetupNotes(props: { setup: SetupInfo | null; choice: ModelChoice }) {
  const { setup } = props;
  if (!setup) return null;
  const provider = providerOf(props.choice);
  const missingKey = provider.key && !setup.keys.includes(provider.key);
  const notes = [];
  if (!setup.worker) {
    notes.push(
      <section key="mirror" className="check" data-state="failed">
        <span className="sdot still" />
        <div className="check-body">
          <b>Mirror is not installed</b>
          <span className="muted">Glass runs Mirror's own agent. Install it, then reopen Glass.</span>
          <code className="mono command">{setup.mirror_command}</code>
        </div>
      </section>,
    );
  }
  if (setup.worker && missingKey) {
    notes.push(
      <section key="key" className="check" data-state="attention">
        <span className="sdot still" />
        <div className="check-body">
          <b>{provider.key === "CODEX_LOGIN" ? "Not logged in to ChatGPT" : `No key for ${provider.name}`}</b>
          {provider.key === "CODEX_LOGIN" ? (
            <>
              <span className="muted">ChatGPT plan billing uses a Codex login, as in Mirror's CLI. Log in, or pick another model below.</span>
              <code className="mono command">codex login --device-auth</code>
            </>
          ) : (
            <span className="muted">
              Add your key in Settings (⌘,), where it is kept in the Keychain, or pick another model below.
            </span>
          )}
          {setup.keys.length > 0 && <span className="mono faint">keys found · {setup.keys.join(" · ")}</span>}
        </div>
      </section>,
    );
  }
  if (setup.worker && setup.version && setup.version !== setup.tested_version) {
    notes.push(
      <section key="version" className="check" data-state="attention">
        <span className="sdot still" />
        <div className="check-body">
          <b>Mirror {setup.version}</b>
          {setup.version.startsWith("pre-release") ? (
            <>
              <span className="muted">Mirror has been released. Replace the pre-release with it, then reopen Glass.</span>
              <code className="mono command">uv tool uninstall mirror && {setup.mirror_command}</code>
            </>
          ) : (
            <span className="muted">Glass was tested with mirror-agent {setup.tested_version}. Most things should work.</span>
          )}
        </div>
      </section>,
    );
  }
  return notes.length ? <div className="setup-notes">{notes}</div> : null;
}
