# Architecture

How the app is put together. This is the intended shape. If you find a reason to change it, say why in the commit.

## Layers

```
app/src            React and TypeScript. Renders view state. Knows nothing about Mirror's protocol.
app/src-tauri      Tauri 2 shell. Owns processes and files. Depends on glass-core.
crates/core        glass-core. Everything that speaks Mirror's protocol.
mirror-agent       Mirror's worker. One process per agent. Not ours, never bundled.
```

One rule holds the design together: **the UI is a pure function of an event log.** Each agent has an ordered list of `glass_core::Event`. The frontend folds that list into view state. Live sessions, resumed sessions and recorded fixtures all go through the same fold, so anything that works from a fixture works live.

## Rust side (`app/src-tauri`)

An `AgentManager` holds every running agent:

```
AgentId -> { workspace, conversation_id, Worker, Session, state }
```

Commands the frontend can call:

| Command | Does |
| - | - |
| `check_setup` | Finds Mirror, its version, and which provider keys are present |
| `list_projects` / `add_project` | Projects are folders the person has opened. Stored in Glass's own file |
| `start_agent` | Makes a checkout if needed, launches a worker, opens the session, sends the first message |
| `send_message` | Sends or queues a user message |
| `resolve_approval` | Approves or rejects one request |
| `interrupt` | Stops the current turn |
| `set_inference` | Model, endpoint and reasoning effort for the next turn |
| `set_approval_mode` | Manual or auto |
| `stop_agent` / `restart_agent` | Ends the worker, or relaunches it and resumes the conversation |
| `workspace_changes` | Changed files and their diffs, from git |
| `open_in_editor` | Opens the workspace folder |

Events go to the frontend on one Tauri channel as `{ agent_id, seq, event }`. `seq` increases by one per agent so the frontend can detect a gap.

Responsibilities that live here and nowhere else:

- **Process lifetime.** Every worker is stopped when its agent is closed and when the app quits. No orphans.
- **Crash detection.** When a worker exits on its own, emit a closed event with its stderr tail.
- **Checkouts.** `git worktree add` from `origin/main` into a folder Glass owns, one per extra agent in a project.
- **Glass's own data.** Projects, agents and their conversation ids, in a small file or SQLite database in the app data folder. Never in Mirror's database.
- **Notifications.** Raised when an agent enters needs-you while the window is not focused or another agent is selected.

## Frontend (`app/src`)

- **Store.** One reducer per agent: `(state, event) -> state`. No protocol knowledge, only the event shapes in `crates/core/src/event.rs`.
- **Derived agent state.** Running after a turn starts. Needs you while any approval is pending. Done after a turn completes. Failed after a turn error, an unrequested interrupt, or a closed stream with an error.
- **Tool calls are assembled from deltas.** `tool_call_delta` events arrive in pieces, keyed by index. The finished call arrives again inside the assistant `message` event. Show the streaming version until the finished one replaces it.
- **Replay mode.** A dev-only source that feeds a fixture file through the same channel, with a short delay between events. Used for building UI and for tests.
- **Styling.** Plain CSS with the custom properties from `docs/design.md`. No component library, no utility framework. Port the CSS from `design/*.html`.
- **Fonts.** Hanken Grotesk and Geist Mono, bundled as files. No network requests for fonts.

## Testing

- **Core:** the probe against `dev/fake_model.py` and the real worker.
- **Reducer:** unit tests that fold each fixture and assert the final view state. Add a fixture whenever a new state is found.
- **UI:** render from fixtures. Compare against `design/screenshots/` by eye in both themes before calling a screen done.

## Protocol changes

Mirror's protocol is undocumented and expected to change at its public release. When it does:

1. Regenerate the files under `proto/` from the new wheel.
2. Fix `crates/core` until the probe passes again.
3. Re-record the fixtures.

If the `Event` shapes did not change, the app needs no changes.
