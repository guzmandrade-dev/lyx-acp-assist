# LyX ACP Assist

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
| `[ACTION: move pN pM]` | Move paragraph `[pN]` to after `[pM]` |

Applied edits are confirmed quietly under the reply ("Inserted after [p5] · Undo
edit") and every paste is verified against the document before it happens — a
mis-targeted paste is refused, never applied.

## Requirements

- **LyX 2.5+** with the LyXServer pipe enabled in preferences:

  ```
  \serverpipe "//./pipe/lyxpipe"
  ```

  The forward-slash form is required on Windows — backslashes cannot round-trip
  LyX's config lexer.
- **Node.js 22+**
- **An ACP agent CLI** — any of:
  - `opencode acp`
  - `copilot --acp`
  - `goose acp`

  Configurable at runtime in the app's "Agent settings" panel.
- **Windows** for the native clipboard path (custom `application/x-lyx` clipboard
  formats are written via .NET WinForms; Linux and macOS adapters are stubbed).

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
- Automatic correction of one round of malformed LyX markup from the agent
- Layout vocabulary of the active textclass is injected into every prompt
  (Beamer, journal classes, …), so the agent only uses real layout names

## Development

```bash
npm test         # vitest (parser, context, server, mocked LyXServer pipe)
npm run typecheck
npm run build
```

```
src/lyx/         read-only .lyx parser, outline/context building, markup validation
src/lyxserver/   LyXServer named-pipe client (LFUN dispatch)
src/clipboard/   x-lyx clipboard abstraction + native adapters
src/acp/         ACP client over stdio (agent-agnostic)
src/server.ts    Express API: sessions, unified message stream, documents, undo
src/electron/    Electron shell + floating-window logic
public/          companion panel UI (plain HTML/CSS/JS)
test/            vitest suites incl. a fake LyXServer speaking the real pipe protocol
```

## Status

Spike-tested against live LyX 2.5.3 on Windows (pipe round-trip, clipboard
fidelity, end-to-end edit loop) and validated end-to-end with `opencode acp` and
`copilot --acp` as agents. Next up: packaging, tool-call progress in the stream,
more paragraph operations.

## Acknowledgements

- [lq](https://github.com/naivej/lq) (MIT) — the parser grammar reference and the
  source of the fixture files used by the test suite.
- Visual Research Pal — the predecessor companion app whose architecture
  (Electron + Express + ACP) this project mirrors.