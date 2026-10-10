# Product

What Glass is for, who judges it, and how each part should behave. Read this before building UI.

## The one-line pitch

Mirror is great in the terminal. Glass is the desktop version: the same agent, with every workspace visible at once.

## Who it is for

Two audiences, in this order.

1. **Reflection's engineers.** They will watch a 45 second video and maybe run it once. They know Mirror deeply. They will notice in seconds whether Glass respects how Mirror works or fights it.
2. **People who run several coding agents at once** and are tired of hunting through terminal tabs for the one that is waiting on them.

## Why this approach wins

Developers discount third-party harnesses that wrap someone else's model with their own compaction and prompts. They ask why it would beat the native harness. Glass avoids that question entirely. It runs Mirror's own agent, unchanged. It adds a surface, not a brain.

So:

- Never claim Glass makes the model better.
- Never hide what Mirror is doing. If Mirror compacts the context, say so in the transcript.
- Always show which model is answering and where it runs.

## The demo this is built toward

Every feature in v1 exists because it appears here. If a feature is not in this script, it is lower priority than one that is.

| Seconds | What happens on screen |
| - | - |
| 0 to 5 | Glass opens. Two projects in the sidebar, several agents, one already running. |
| 5 to 15 | Cmd K. Type a task, `@` a project, Enter. A new agent drops into the sidebar, running, in its own checkout. |
| 15 to 25 | A system notification: an agent needs you. Click it. The approval card shows the diff. Press `A`. The tests pass. |
| 25 to 35 | The changes panel shows the diff. The session tab shows context used, model, endpoint and reasoning effort. |
| 35 to 45 | A second agent asks to run a command. Press `R`. It is refused, and the agent carries on another way. |

The video is recorded in the cream theme on a Mac.

## Principles

**Attention is the scarce resource.** The app's first job is to point the person at the agent that is blocked on them. Needs-you sorts first, everywhere. A notification opens the exact agent.

**A workspace is a place, not a chat.** Each agent has a project, a checkout, a branch and a set of changes. The conversation is one view of it.

**One motion to start work.** Cmd K, type, Enter. Defaults are shown, not asked for.

**Review, don't watch.** People should be able to start three agents, leave, and come back to diffs.

**Mirror's words and Mirror's concepts.** Workspace, manual and auto, reasoning effort, context. No renamed or invented concepts.

**Honest about limits.** Mirror's worker stops when its client closes. Say so when the person quits with agents running.

## What we took from other tools

| From | Idea we use |
| - | - |
| Codex app | Each thread is a workspace with its own checkout. Review diffs in sequence. |
| T3 Code | Every session's project, model and state visible at a glance. Warn on a version mismatch. |
| OpenCode desktop | Tauri for speed. Diff beside the conversation. |
| herdr, Agent Navigator | Four agent states. Notifications that link to the blocked agent. |
| Pi | Sessions are trees. Rewind is planned for after v1. |
| Oh My Pi | Stopping and steering mid-turn are first-class actions. |
| Amp | Show which model did the work. Be open about compaction. |
| Claude Code | Sensible defaults. It works before you configure anything. |

## Mistakes other tools made that we will not repeat

- **Three names for one thing.** One tool gave each workspace, task and branch a different name and renamed one without asking. In Glass an agent has one title, taken from its first message. The branch name is derived from it once and never changed silently.
- **A setup screen full of options.** First run is one screen with three checks.
- **Logs only an expert can read.** When something fails, show the worker's last lines in plain view with a restart button.
- **Pretending work continues after quitting.** It does not, so warn.
- **UI that goes stale.** The file list and diff refresh whenever a tool result reports a touched file.

## Screens and states

The mock covers the main screen and the launcher. The states below are not mocked. Build them in the same visual language and keep them plain.

### Main screen

Mocked in `design/main*.html`.

- **Sidebar.** "Needs you" inbox on top, then projects, each with its agents. Within a project, order is: needs you, running, failed, done. A new agent animates in once.
- **Selecting an agent** switches the whole middle and right columns to it. Its scroll position is remembered.
- **Agent title** is the first user message, trimmed to one line.
- **Agent meta line** in mono: branch, reasoning effort, state.

### Transcript

- **User messages** sit right, in a warm bubble.
- **Assistant text** sits left, plain, no bubble.
- **Reasoning** is one collapsed mono line that expands on click. It streams while collapsed.
- **Tool calls** are a mono header (`bash · python3 -m unittest`) with the result beneath on the warm surface. The exit code sits at the right. Long output is clipped to about 12 lines with a "show all" control.
- **Edits** render the diff from the record's `display` field.
- **Streaming** text appears as it arrives. Auto-scroll follows the bottom unless the person has scrolled up.
- **A rejected call** shows as one quiet line: `edit · stats.py` on the left, `rejected` on the right.
- **Compaction** shows as one quiet line in the transcript when Mirror reports it.

### Approvals

- An approval is a card at the end of the transcript and a row in the inbox. Both resolve together.
- `A` approves and `R` rejects the request for the selected agent, when focus is not in a text field.
- Lime is used on the Approve button and nowhere else on that screen.
- If several requests are pending for one agent, show them in order, one card each.
- Switching approval mode to auto takes effect for the next request. It does not answer the pending one.

### Composer

- Enter sends. Shift Enter adds a line.
- While the agent is working, Send still works and the message is queued. Show queued messages above the composer until the worker picks them up.
- While the agent is working, a Stop control is visible. Escape also stops, when the composer is empty.
- Approval mode and reasoning effort sit under the composer. Changing effort applies to the next turn.

### Launcher

Mocked in `design/launcher.html`.

- Opens on Cmd K from anywhere. Escape closes it.
- Typing `@` opens the list. Arrow keys move, Enter picks, and the pick becomes a chip.
- The project defaults to the project of the agent currently selected.
- If the chosen project already has an agent on its main checkout, the new one gets its own checkout from `origin/main`. Say so in the footer line before the person starts.
- A project with no `origin` remote cannot get a second checkout. Say that plainly and start in the main folder instead only if no other agent is there.
- Enter starts the agent and closes the launcher. The person stays on the agent they were viewing.
- Connections appear only once MCP support exists. Until then the section is absent, not disabled.

### Changes panel

- Lists files changed in the workspace compared with its base, with added and removed counts.
- Selecting a file shows its diff.
- A proposed edit that has not been approved is labelled as proposed.
- "Open in editor" opens the workspace folder in the person's default editor.

### Session panel

- Context used as a percentage, with the dot meter, and the raw counts.
- The breakdown Mirror reports: system prompt and tools.
- Model, where it runs, reasoning effort, speed while streaming.
- Files touched this session, each marked read or written.

### Not mocked: first run

One centred column on the cream background.

1. **Mirror:** found, with its version and path, or not found, with the one install command.
2. **Provider:** which keys are present in the environment. Glass never asks the person to type a key into it.
3. **Version:** a quiet warning if the Mirror version is not the one Glass was tested with.

One lime pill: "Open a project".

### Not mocked: no agents yet

The middle column shows one line, "Press Cmd K to start an agent", and the launcher hint. Nothing else.

### Not mocked: failures

- **The worker would not start.** Show the reason it printed and its last stderr lines. One button: try again.
- **The worker died mid-session.** The agent's state becomes failed. The transcript stays. A bar above the composer says the worker stopped and offers a restart that resumes the conversation.
- **The model request failed.** Mirror reports this as an interrupted turn. If the person did not press Stop, treat it as a failure and show the worker's last stderr lines. The usual causes are a missing key, a bad key or an unreachable endpoint. Say that.
- **Quitting with agents running.** Ask once: the agents will stop. Offer Quit and Cancel.
