# Glass

The unofficial desktop app for Mirror, Reflection AI's agent harness. Owner: Mustafa.

Glass does not reimplement the agent. It launches Mirror's own worker process, `mirror-agent`, and talks to it over the same gRPC protocol Mirror's terminal app uses. Same agent and tools, with a desktop UI: many agents side by side, approvals in one place, diffs next to the conversation.

## Why it exists

It is Mustafa's application piece for a role at Reflection. Their engineers will judge it in about a minute. Two things decide that:

1. **It works.** Few features, each one solid.
2. **It feels like theirs.** See `docs/design.md`.

Target: a recorded demo and a public repo around Mirror's public release on 15 October 2026.

## Read these before building UI

| File | What it tells you |
| - | - |
| `docs/product.md` | Who judges this, the 45 second demo every feature serves, how each screen and state behaves, including states that have no mock |
| `docs/design.md` | Colours, type, the pill button, status, layout |
| `docs/architecture.md` | The layers, the commands, the event log rule, testing |
| `design/screenshots/*.png` | What the screens should look like. Look at these first |
| `design/*.html` | The same screens as static HTML with the real CSS. Port from these |

## Hard rules

- **Never decompile, patch or bundle `mirror-agent`.** Find the user's installed copy. Reading the Apache-2.0 Python client that ships in the Mirror wheel is fine, and is where the protocol knowledge came from.
- **Never look official.** No Reflection logo, no CLI emblem, no "Mirror" as the product name, none of their font files or artwork. The app says "unofficial" in the window.
- **All protocol code stays in `crates/core`.** The UI only sees `glass_core::Event` and the `Session` methods. Mirror's protocol is undocumented and will change; this keeps the fix in one place.
- **Do not add a harness, compaction or prompt logic of our own.** The pitch is that this is Mirror's agent, unchanged.
- **No provider keys in config, logs, fixtures or commits.** Keys come from the shell's environment or from Settings, which saves them only in the macOS Keychain (`app/src-tauri/src/secrets.rs`); Glass's files hold variable names, never values. A value reaches the worker or an MCP server only through that process's environment at launch, is never sent back to the UI (only its source and last four characters), and is blanked out of worker output Glass shows. Changed with Mustafa on 10 October 2026, replacing "Glass never asks for a key".

## What exists and what has been tested

`crates/core` (about 930 lines of Rust):

| File | Job |
| - | - |
| `worker.rs` | Find the installed worker, launch it, read its address, collect stderr |
| `session.rs` | The session stream: send a message, set model and effort, approve or reject, stop, read history |
| `event.rs` | Protocol messages turned into plain, serialisable events |
| `bin/probe.rs` | Run one prompt and print every event as a JSON line |

Tested on Linux against the real Mirror 0.1.0 worker, with the scripted model in `dev/`:

- streaming reasoning and text, in order
- reasoning effort reaching the model request
- manual mode with every request rejected: nothing on disk changed
- manual mode with every request approved: file edited, tests went from exit 1 to exit 0
- files touched reported per tool call

**Also tested on macOS 26 (arm64)** with Mirror 0.1.0 and the scripted model: approve and reject both behave as on Linux.

**Resume tested** (app/src-tauri/examples/resume_smoke.rs): a relaunched worker with `create_session: false` sends the model the full earlier conversation. A real model (gpt-5-nano) also ran through the probe.

**Also tested against the released worker (mirror-agent 0.1.8):** the scripted session, remembered approvals end to end (`examples/remember_smoke.rs`), and compaction on request with gpt-5-nano (`examples/compact_smoke.rs`).

**Not tested yet:** interrupt, messages queued mid-turn, more than one worker at once.

## How Mirror's worker behaves

Mirror's source is public since October 2026: github.com/reflection-oss/mirror (`mirror-agent/` the worker, `mirror-cli/` the terminal client, `protocols/` the wire format). Read it before guessing, and run the worker with the probe to confirm. The released package is `reflection-mirror` on PyPI (`uv tool install reflection-mirror`); its worker is `mirror-agent` 0.1.8.

- **Launch:** `mirror-agent '<json config>'`, run from the workspace directory. It prints `MIRROR_RPC_ADDRESS=host:port` when ready or `MIRROR_RPC_ERROR=reason` if not. It exits when its stdin closes, so keep the stdin handle open.
- **Config is typed.** `mirror-agent/src/main.rs` `WorkerConfig`. Unknown keys are ignored, but a wrong type fails: `model` must be a string, not null. The CLI also sends `checkpoints_enabled`, `mcp_connections` (the worker can run MCP servers itself now), `additional_skills` and `sandbox`; Glass does not use these yet.
- **One worker per agent.** Each agent in the sidebar is its own worker process with its own conversation id.
- **Conversations live in Mirror's database** (`~/.mirror/state.db`). Use a different file for Glass's own data. Resume by launching with `create_session: false` and calling `Session::history`.
- **Keys come from the environment:** `REFLECTION_API_KEY`, `OPENAI_API_KEY`, `OPENROUTER_API_KEY`, `ANTHROPIC_API_KEY`. OpenAI is `api: openai-responses`. `openai-chat-completions` means OpenRouter (`OPENROUTER_API_KEY`) unless a base URL is set. A custom OpenAI-compatible endpoint can run with no key.
- **Approvals:** in manual mode the worker asks before `bash`, `write`, `edit` and hosted tools. `read`, `grep`, `glob` and `ls` never ask. A rejected call comes back to the model as a failed tool result and the turn carries on. Each call also gets a `ToolApprovalRecord` (outcome and source: manual, automatic, not_required, remembered_exact, remembered_prefix).
- **Remembered approvals are the client's job,** in `~/.mirror/tool_approvals.json`, shared by every Mirror client. `app/src-tauri/src/approvals.rs` reads and writes it exactly as `mirror-cli/src/mirror/cli/tool_approvals.py` does, and answers a matching request with `HITLResponse.source = REMEMBERED_*`. Tested both ways against the CLI's own code.
- **Edit results carry a ready-made unified diff** in the record's `display` field. Bash results carry the command in `display` and the exit code in `exit_code`. Use these; do not compute diffs for the transcript.
- **A worker exits when its stdin closes, but only once idle.** One busy with a model request or a command carries on after Glass dies. `crates/core/src/guardian.rs` covers that: a small shell process stops every worker's process group when Glass's pipe to it closes, however Glass ended. Tested by killing Glass with `kill -9` mid-request.
- **A message sent mid-turn is queued by the worker**, not rejected.
- **A failed model request ends the turn with `turn_interrupted`, not `turn_error`.** No key, a bad key and an unreachable endpoint all look the same on the wire. The only clue is a line on the worker's stderr (`model metadata connection unavailable` or `... endpoint returned an error`). An interrupt the user did not ask for is a failure: show the stderr tail.
- **Worktrees are the client's job.** Mirror's client creates a fresh checkout from `origin/main` with git, then starts a worker in it. The worker knows nothing about worktrees.
- **MCP servers run in the worker.** The client passes each `~/.mirror/mcp/<name>.json` as `mcp_connections: [{name, config, credential_directory}]`; the worker connects, refreshes OAuth tokens from `~/.mirror/mcp/credentials/<name>.json`, and offers the tools through `mcp_search`, `mcp_describe` and `mcp_call`. An approval request names the real tool (`mcp__<server>__<tool>`) with its own call id; the result lands on the `mcp_call`. Sign-in, the catalog and removal run Mirror's own Python (`install_server`, `remove_server`) through `app/src-tauri/src/mirror_py.rs`. `app/src-tauri/src/mcp.rs` only probes servers for Settings and `@` mentions. Tested end to end with `dev/fake_mcp.py` (fixture `fixtures/mcp-search.jsonl`).
- **Sandboxes:** a private clone under `~/.mirror/sandboxes` and a `sandbox` config `{id, image, sandboxd, egress, cpus, memory_mib}`; the worker runs file and shell tools in a microVM. Setup, cloning and preparing the VM are Mirror's own code (`app/src-tauri/src/sandbox.py`). The VM controls the clone's Git settings, so **never run git or a shell on the host in a clone**: every git helper and the terminal call `sandbox::guard`. Built, not yet run end to end (needs about 437 MB of pinned downloads).
- **Mirror's own Python** (`<tool>/bin/python`, run with `-I` from the home folder) is how Glass uses client-side features exactly as Mirror implements them: MCP sign-in, sandboxes, the CLI's conversation list.
- **Built-in tools:** read, bash, write, edit, grep, glob, ls, task, subagent, plus mcp_search, mcp_describe and mcp_call when MCP servers are connected.

## v1 ship list, in build order

1. **Verify the core on macOS.** Build, run the probe against `dev/fake_model.py`, then against a real model if a key is set. Fix `find_worker` if `uv` installs somewhere else on a Mac.
2. **Tauri 2 shell.** One window, React and TypeScript, plain CSS from the tokens in `docs/design.md`. Bridge `glass-core` with commands plus an event channel.
3. **Transcript from fixtures.** Replay `fixtures/*.jsonl` so the UI is built and tested with no worker. Text, reasoning (collapsed), tool calls, tool results, the approval card.
4. **Live session.** One agent, one workspace: send, stream, approve, reject, stop.
5. **Sidebar by project.** Several agents at once. States: running, needs you, done, failed. Needs-you sorts first.
6. **Approval inbox.** Every pending request across agents, `A` to approve and `R` to reject, and a system notification that opens the right agent.
7. **Launcher on Cmd K.** Type a task, `@` a project, Enter. A second agent in the same project gets its own checkout from `origin/main`.
8. **Changes panel.** Diff for the workspace, and open in editor.
9. **Session panel.** Context used, model, endpoint, reasoning effort, speed, files touched.
10. **Setup check.** One screen on first run: is Mirror installed, which provider, is a key present.
11. **Resume on relaunch.**
12. **MCP, simple case only:** servers from `~/.mirror/mcp/*.json` that run as a local command or take a bearer token. First to be cut if time runs short.

After v1, in this order: MCP services that need sign-in, the effort race (one task at three reasoning efforts, compared by test result, tokens and time), comments on diff lines, rewind from a message, commit and PR.

Done so far (October 2026): the effort race, comments on diff lines, rewind from a message (MirrorRPC.ForkSession plus Glass's git snapshots), commit and PR (via gh), Settings with keys in the Keychain, the terminal drawer, MCP sign-in through Mirror's catalog, and parity with Mirror's CLI: remembered approvals, transcript views, workspace tags, rename, sandboxes, resuming its conversations, prompt history, open a file. Still open: running a sandbox end to end; Mirror's Python extensions.

Anything not on this list is out of scope. Ask before adding it.

## The bar for "works"

- A worker that crashes or exits never freezes the window. Show its last stderr lines and offer a restart.
- Stop always stops, within a second.
- An approval request can never be lost, hidden or left hanging.
- A long transcript stays smooth. Virtualise the list.
- Every UI state has a fixture or a test that reaches it.
- Cream and dark themes both look right.

## Commands

```bash
cargo build -p glass-core
cargo test -p glass-core

# No key needed: scripted model, real worker
python3 dev/fake_model.py 18431 dev/fix-failing-test.script.json /tmp/glass-log "$PWD/tmp/stats-demo" &
GLASS_API=openai-chat-completions GLASS_MODEL=fake GLASS_BASE_URL=http://127.0.0.1:18431/v1 \
  ./target/debug/probe --approve tmp/stats-demo "Fix the failing test."
```

The sample project the script expects is two files, in a git repo:

```python
# stats.py
def average(nums):
    return sum(nums) / (len(nums) + 1)
```

```python
# test_stats.py
import unittest
from stats import average

class TestAverage(unittest.TestCase):
    def test_average(self):
        self.assertEqual(average([2, 4, 6]), 4)

if __name__ == "__main__":
    unittest.main()
```

## Working style

- Small commits on `main`, each one building and passing tests. Push after each numbered step.
- Say what you verified and what you did not. "Should work" is not a result.
- When Mirror's behaviour is unknown, find out by running the worker with the probe, not by guessing.
- Keep updates short and blunt. Short sentences. No em dashes.
