# Design

Glass should read as a sibling of Reflection's site and of Mirror's terminal UI: warm paper, near-black ink, one acid-lime accent, quiet mono details. It must not read as their official product.

The values below were taken from reflection.ai's stylesheet and from the style table in Mirror 0.1.0's terminal client.

## Reference files

`design/*.html` are static exports of the approved mock. Open them in a browser. They contain the real CSS, so port from them directly. They have no JavaScript; each file is one state.

`design/screenshots/` has a PNG of each file, plus `main-approve-hovered.png` showing the pill button mid-hover on the real screen.

| File | State |
| - | - |
| `main.html` | Main screen, an edit waiting for approval |
| `main-launcher-open.html` | The Cmd K launcher over the main screen |
| `main-approved-dark.html` | Dark theme, edit approved, session panel open, a newly launched agent in the sidebar |
| `main-rejected.html` | Edit rejected, no changes |
| `launcher.html` | The launcher alone |
| `buttons.html` | The pill button at rest and hovered, in all three variants |

## Tokens

Cream theme (default):

| Token | Value | Use |
| - | - | - |
| `--bg` | `#f8f6f0` | Window background |
| `--surface` | `#f1ede1` | Hover, selected row, code and output blocks |
| `--ink` | `#1a1b1a` | Text |
| `--muted` | `#525252` | Secondary text |
| `--faint` | `#56645b` | Mono labels and hints |
| `--line` | `#1a1b1a14` | Hairlines (ink at 8%) |
| `--line-strong` | `#1a1b1a29` | Control borders |
| `--accent` | `#dcef54` | Lime. One primary action per screen |
| `--accent-dark` | `#1e3207` | Text on lime, and the dark pill |
| `--run` | `#3f8f68` | Running |
| `--attn` | `#d7af5f` | Needs you |
| `--fail` | `#d75f5f` | Failed |
| `--idle` | `#9aa79f` | Stopped or idle |
| `--add` | `#72b58e40` | Added diff line background |
| `--del` | `#f28b8240` | Removed diff line background |

Dark theme overrides: `--bg #0a0a0a`, `--surface #171717`, `--ink #f8f6f0`, `--muted #a3a3a3`, `--faint #9aa79f`, `--line #f8f6f01f`, `--line-strong #f8f6f038`, `--accent-dark #f8f6f0` with dark text on it, `--run #72b58e`, `--fail #f28b82`, `--idle #68756d`.

Radii: 12px for rows and blocks, 16px for cards, 24px for the composer and dialogs, full for pills. No heavy shadows. Structure comes from hairlines.

## Type

Reflection uses a licensed custom typeface. Do not use it. The stand-ins:

- **Hanken Grotesk** for the interface. Headlines are light (weight 350) with tight tracking (-0.04em). Body is 14 to 15px at -0.01em.
- **Geist Mono** at 12px for anything the machine said: tool names, commands, output, paths, counts, status words.

Bundle the fonts with the app. Do not load them from the network.

Section labels are 11px mono, uppercase, tracked 0.04em.

## The pill button

Their signature interaction, rebuilt from scratch.

- At rest it is a pill with a 6px dot near its right end.
- On hover the dot splits out of the pill and grows into its own circle, and an arrow fades in inside it. The arrow's shaft is dotted.
- 300ms ease-out. The arrow fades in over 200ms after a 100ms delay.
- **The total width never changes.** The pill's right padding shrinks by exactly the circle's diameter while the circle's negative margin goes to zero.
- Keyboard focus shows the same state as hover.
- Respect `prefers-reduced-motion`.

Three variants: lime (primary), outline (secondary), dark green (send). Two sizes: 52px and 44px tall. The CSS is in every file under `design/`, in the block that starts with `.pill`.

Use lime once per screen, for the action the screen is asking for.

## Everything else hovers quietly

Rows, tabs and ghost buttons change colour only, over 150ms. No movement, no scale, no shadow.

## Status

Colour is never the only signal. Every status has a word next to its dot.

| State | Dot | Word |
| - | - | - |
| Running | green, slow pulse | running |
| Needs you | amber with a soft ring | needs you |
| Done | hollow green ring | done |
| Failed | red | failed |
| Stopped | grey | stopped |

These are Mirror's own colours with Mirror's own meanings.

## Words

Use Mirror's vocabulary exactly: workspace, manual and auto, reasoning, ctx, and `·` as the separator in mono lines. Do not rename its concepts. Labels are short and literal. No exclamation marks, no emoji.

## Layout

- **Left, 268px:** "Needs you" inbox first, then agents grouped by project.
- **Middle:** title, transcript, composer. Approval mode and reasoning effort sit under the composer, where Mirror's status line is.
- **Right, 400px:** two tabs, changes and session.
- Every control is at least 44px tall.
