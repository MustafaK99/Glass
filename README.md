# Glass

The unofficial desktop app for [Mirror](https://github.com/reflection-oss/mirror-beta), Reflection's agent harness.

Glass does not reimplement the agent. It launches Mirror's own worker, `mirror-agent`, and talks to it over the same gRPC protocol Mirror's terminal app uses. Same agent, same tools, a different window.

Not affiliated with or endorsed by Reflection AI.

## Status

Built and tested against Mirror 0.1.0.

- `crates/core`: the client. Finds the worker, launches it, opens the session stream, and turns protocol messages into plain events. Working.
- Desktop app (Tauri): not started.

## Try the core

You need Rust and an installed Mirror. No `protoc` is needed.

```bash
cargo build -p glass-core
export REFLECTION_API_KEY=...        # or use another provider, below
./target/debug/probe --approve path/to/project "Explain this project."
```

The probe prints every event as a JSON line.

| Flag | Meaning |
| - | - |
| `--auto` | The agent runs every tool without asking |
| `--approve` | Manual mode, and the probe says yes to each request |
| neither | Manual mode, and the probe says no, so nothing changes |
| `--record FILE` | Also save the events to a file |

| Variable | Meaning | Default |
| - | - | - |
| `MIRROR_RUST_WORKER` | Path to `mirror-agent` | the installed Mirror |
| `GLASS_API` | `reflection`, `openai-responses` (OpenAI), `openai-chat-completions` (OpenRouter, or any endpoint set with `GLASS_BASE_URL`), `anthropic-messages` | `reflection` |
| `GLASS_MODEL` | Model id | `Beam-501B-A23B` |
| `GLASS_BASE_URL` | Endpoint for a custom or self-hosted model | none |
| `GLASS_EFFORT` | `low`, `medium`, `high`, `xhigh`, `max` | `high` |

Provider keys are read by the worker from its usual variables: `REFLECTION_API_KEY`, `OPENAI_API_KEY` (for `openai-responses`), `OPENROUTER_API_KEY` (for `openai-chat-completions`), `ANTHROPIC_API_KEY`.

## Test without a model key

`dev/fake_model.py` is a scripted OpenAI-compatible endpoint. It replays a fixed fix-the-failing-test run, so the whole loop (streaming, approvals, tool calls) can be exercised for free.

```bash
python3 dev/fake_model.py 18431 dev/fix-failing-test.script.json /tmp/glass-log "$PWD/path/to/stats-demo" &
GLASS_API=openai-chat-completions GLASS_MODEL=fake GLASS_BASE_URL=http://127.0.0.1:18431/v1 \
  ./target/debug/probe --approve path/to/stats-demo "Fix the failing test."
```

`fixtures/` holds two recorded event streams from that run, one approved and one rejected. The UI can replay them with no worker at all.

## Layout

```
proto/            Mirror's protocol files (see NOTICE)
crates/core/      worker launch, session client, events, the probe
dev/              scripted model endpoint for tests
fixtures/         recorded event streams
design/           the approved mock as static HTML, plus screenshots
docs/product.md   who it is for, the demo, how each screen behaves
docs/design.md    colours, type, the button, layout
docs/architecture.md  layers, commands, the event log rule
CLAUDE.md         project brief and the v1 ship list
```

Everything that depends on Mirror's protocol is in `crates/core`. When Mirror changes it, that is the only place to fix.
