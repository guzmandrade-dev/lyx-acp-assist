# LyX ACP Assist

<img src="public/logo.svg" width="96" alt="LyX ACP Assist logo" align="right" />

A Copilot-for-Word-style LLM assistant for [LyX](https://www.lyx.org/) — a floating
companion panel that reads your document, chats, and writes **directly into the live
LyX document**. All reasoning is delegated to an external agent over the
[Agent Client Protocol](https://agentclientprotocol.com/) (ACP); there is no LLM
inside this app.

LyX stays the editor. This app is a quiet chat surface plus a context provider that
floats beside the document.

## How it works

**LyX is the single writer of truth.** The app never writes the `.lyx` file behind
LyX's back, so no parser bug can ever corrupt the document:

- **Read path:** the buffer is saved through LyX's own `buffer-write`, then the
  `.lyx` file is parsed from disk with a pure-TypeScript, read-only parser (a port
  of lq's grammar). Parsing exists only to build agent context and address content
  ("paragraph 3 of Section 2.4" → `[p5]`).
- **Write path:** responses are written to the clipboard as `application/x-lyx` and
  pasted through the LyXServer named pipe — LyX itself performs every insertion,
  so formatting, insets, and cross-references stay intact.
- **Selection context:** LyX's `copy` LFUN puts the selection on the clipboard as a
  complete `.lyx` fragment; the agent receives the lossless structured form.

**One input box, agent-decided intent.** You type a single message; the agent
decides whether to reply in chat or edit the document, and ends its reply with an
action tag the app executes mechanically:

| Action | Effect |
|---|---|
| `[ACTION: none]` | Prose reply; document untouched |
| `[ACTION: insert]` | Paste at the cursor |
| `[ACTION: insert-top]` | Paste at the document start (titles, abstracts) |
| `[ACTION: insert-after pN]` | Insert as new paragraph(s) after `[pN]` |
| `[ACTION: rewrite]` | Replace the active selection |
| `[ACTION: rewrite-at pN]` | Replace paragraph `[pN]` (verified before pasting) |
| `[ACTION: delete-at pN]` | Delete paragraph `[pN]` |
| `[ACTION: merge pN pM]` | Merge two adjacent paragraphs (M = N+1) |
| `[ACTION: move pN pM]` | Move paragraph `[pN]` to after `[pM]` |

Splitting a paragraph is done with `[ACTION: rewrite-at pN]` and a fenced
block containing the two (or more) new paragraphs.

Applied edits are confirmed quietly under the reply ("Inserted after [p5] · Undo
edit") and every paste is verified against the document before it happens — a
mis-targeted paste is refused, never applied.

## Demo

Watch the app rewrite a selection, insert a paragraph, and answer questions
alongside a live LyX document:

https://github.com/user-attachments/assets/ce301d65-6185-4de0-8086-4a246bd8fc85

## Requirements

- **LyX 2.5+** with the LyXServer pipe enabled in preferences:

  ```
  \serverpipe "//./pipe/lyxpipe"
  ```

  The GUI dialog *displays* the OS-level name (`\\.\pipe\lyxpipe`), but LyX
  stores and expects the portable forward-slash form in the `preferences`
  file — it normalizes between the two on save. Don't be confused by the
  difference; what matters is the forward-slash form.

  On Windows the forward-slash form is required — backslashes cannot round-trip
  LyX's config lexer (typing `\\\.\pipe\lyxpipe` by hand in the file silently
  breaks the pipe: LyX eats the backslashes as escapes). On Linux/macOS use the
  path form LyX expects for your install (e.g. `~/.lyxpipe`), or point the app
  at it with the `LYX_PIPE` environment variable.

  The app reads the pipe path from LyX's own preferences file
  (`%APPDATA%\LyX<version>\preferences` on Windows), so any pipe name you
  configure just works; `LYX_PIPE` remains an escape hatch. If the LyXServer
  `.out` pipe is broken server-side (a LyX named-pipe bug triggered by the
  Windows updates of 2026-10-17; see AGENTS.md), the app detects it at
  startup and falls back to a degraded write-only mode: commands still
  apply, while document/selection reads come from the window title, the
  session file, and the clipboard.
- **Node.js 22+**
- **An ACP agent CLI** — any of:
  - `vibe-acp` (no arguments)
  - `copilot --acp`
  - `goose acp`

  Configurable at runtime in the app's "Agent settings" panel.
- **Native clipboard access** for the `application/x-lyx` custom format, via:
  - **Windows:** .NET WinForms (PowerShell helper; works out of the box)
  - **Linux:** `wl-copy`/`wl-paste` on Wayland, or `xclip` on X11
    (install `wl-clipboard` or `xclip`)
  - **macOS:** `osascript` + NSPasteboard (works out of the box)

## Getting started

```bash
npm install
npm start        # builds TypeScript and launches the Electron companion app
```

Open a saved document in LyX, select some text, and type a message. The panel
shows the active document, selection word count, and connection status.

## Features

- Multi-document support (follows LyX's active view; tab selector)
- Streaming responses, stop/cancel, undo of the last agent edit inside LyX
- File attachments (PDF, Office, text…) converted to text for the agent
- Per-document chat history, persisted
- Save-consent gate: a document outside version control (no Git) is never
  saved to disk until you accept that in a dialog — asked once per document
  per session (re-asked after an app restart)
- Automatic correction of one round of malformed LyX markup from the agent
- Layout vocabulary of the active textclass is injected into every prompt
  (Beamer, journal classes, …), so the agent only uses real layout names

## Development

```bash
npm test         # vitest (parser, context, server, mocked LyXServer pipe)
npm run typecheck
npm run build
npm run package  # installers for Windows (nsis/portable/zip), macOS (dmg/zip),
                 # Linux (AppImage/deb/tar.gz) via electron-builder
```

Build output goes to `dist-release/`, gitignored. GitHub Actions builds and
uploads artifacts for all three OSes on every push, and publishes a draft
release when a `v*` tag is pushed.

The packaged app writes its data (chat history, attachments, logs) to the
Electron user-data directory — `%APPDATA%\LyX ACP Assist` on Windows,
`~/Library/Application Support/LyX ACP Assist` on macOS, and
`~/.config/LyX ACP Assist` on Linux.

```
src/lyx/         read-only .lyx parser, outline/context building, markup validation
src/lyxserver/   LyXServer named-pipe client (LFUN dispatch)
src/clipboard/   x-lyx clipboard abstraction + native adapters
src/server.ts    Express API: sessions, unified message stream, documents, undo
src/electron/    Electron shell + floating-window logic
public/          companion panel UI (plain HTML/CSS/JS)
test/            vitest suites incl. a fake LyXServer speaking the real pipe protocol
```

Shared code (ACP client, attachment conversion, chat-history persistence,
restart replay) lives in the workspace package
[`@acp-assist/core`](../../packages/core) at the monorepo root.

## Status

Validated end-to-end against live LyX 2.5.3 on **Windows** (pipe round-trip,
clipboard fidelity, multi-edit loop) with `opencode acp` and `copilot --acp`
as agents.

Linux and macOS are supported in code — the clipboard adapters (wl-copy/xclip,
NSPasteboard), the FIFO-based LyXServer client, layout-class discovery, and
cross-platform packaging with CI are all implemented — but the live LyX
round-trip has only been verified on Windows. The floating-on-top behavior is
Windows-only for now (the window simply stays a normal window elsewhere).
Linux/macOS testers very welcome — especially the clipboard write → `paste`
round-trip in LyX, since a failed custom-format write silently falls back to
literal text.

## Acknowledgements

- [lq](https://github.com/naivej/lq) (MIT) — the parser grammar reference and the
  source of the fixture files used by the test suite.
- Visual Research Pal — the predecessor companion app whose architecture
  (Electron + Express + ACP) this project mirrors.
