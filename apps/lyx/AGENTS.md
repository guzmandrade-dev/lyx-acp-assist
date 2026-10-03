# AGENTS.md — lyx-acp-assist

Important project context and decisions. Read this before doing any work here.

## What this project is

A Copilot-for-Word-style LLM assistant for **LyX**: an agent that reads, suggests,
and writes **directly into the live document** — not a diff/code-review tool on the
source. Companion architecture: LyX stays the editor; our app is a chat surface
plus context provider; all reasoning is delegated to an external **ACP agent over
stdio** (agent-agnostic — `opencode acp`, `goose acp`, etc.). No LLM inside this app.

The design deliberately mirrors **Visual Research Pal** (`C:\Users\guzma\Git\visual-research-pal`),
the predecessor project by the same author: Electron + Express + TypeScript,
`@agentclientprotocol/sdk`, chat UI, agent config via JSON. Reuse its patterns
(ACP client, config loading, report/schema validation with Zod) where possible.
See that repo's README/AGENTS.md for conventions.

## Decided architecture (2026-10-03) — do not relitigate casually

**Pure LyXServer companion app.**

1. **Read path:** trigger `file-save` via the pipe, then parse the `.lyx` file
   from disk with a **pure-TypeScript, read-only parser**. Parsing exists only to
   build agent context and address content ("paragraph 3 of Section 2.4").
2. **Write path:** LyXServer named pipe (`server-insert`, selection replace via
   cut+insert/clipboard). **LyX is the single writer of truth.** The app never
   writes the `.lyx` file behind LyX's back. Consequence: a parser bug can degrade
   suggestion quality but can never corrupt the document.
3. **Selection context:** `copy` LFUN + read system clipboard.

### Rejected / deferred alternatives

- Standalone `.lyx` editor in Electron (rebuilds LyX, loses the actual editor).
- lq (`naivej/lq` on GitHub — Rust CLI that parses `.lyx` into a syntax tree and
  mutates/serializes it losslessly) as a **runtime dependency**: rejected —
  one-person project, would drag a Rust toolchain into an Electron/TS build.
  **lq is used only as a reference and as a source of fixture files** for
  building/testing our TS parser.
- Key insight that drove these choices: lq's hard problem is lossless *writing*;
  ours is only *reading*. Reads are forgiving; writes are not, so writes go
  through LyX itself.

## Environment facts (verified)

- LyX **2.5.3** installed at `C:\Program Files\LyX 2.5\bin\LyX.exe`.
- LyX user dir: `%APPDATA%\LyX2.5`. The preferences file header now says
  "LyX 2.5.3, Format 40" (after a GUI save; the stale Format 38 file written
  by 2.4.4 was replaced).
- **LyXServer pipe is configured and working.** The preference MUST use
  forward slashes: `\serverpipe "//./pipe/lyxpipe"` — backslashes cannot
  round-trip (LyX's config lexer eats them as escapes when reading, so
  `"\\\\.\\pipe\\lyxpipe"` silently becomes `\.\pipe\lyxpipe` and no pipes
  are created; no error is shown). LyX normalizes the forward-slash form.
- Pipes: `\\.\pipe\lyxpipe.in` (client -> LyX) and `\\.\pipe\lyxpipe.out`
  (LyX -> client). They exist whenever LyX runs with a document open.
- The **lyxsocket** (`ServerSocket`, used by `lyxclient` on Linux) is
  **unavailable on Windows** (AF_UNIX build disabled — "lyx: Disabling LyX
  socket"). The named pipe is the only transport on Windows.
- No elevation mismatch blocks pipe access (both sides Medium integrity).

## LyXServer protocol (verified by Spike 1 — see `spikes/spike1-pipe.mjs`)

- Handshake: `LYXSRV:<client>:hello\n`; requests: `LYXCMD:<client>:<func>:<arg>\n`;
  replies: `INFO:<client>:<func>:<data>\n` or `ERROR:...` (all on `.out`).
- **Windows quirks the client must tolerate:**
  - LyX **disconnects each `.out` client after every reply it writes**
    (`resetPipe` on successful write) -> auto-reconnect after EOF/EPIPE.
  - Replies are broadcast into **per-instance buffers**, so a reply can
    arrive on a later connection than the request that made it, and the
    same reply can be delivered more than once -> use a **unique client
    name per session**, collect all lines, and match pending requests by
    `client:func` prefix.
  - The `.in` connection persists across multiple requests.
- **Valid LFUN names in LyX 2.5** (verified): `server-get-filename`,
  `server-get-layout`, `server-get-xy`, `server-get-statistics`,
  `server-goto-file-row`, `buffer-write` (save), `self-insert <STRING>`
  (type at cursor, replaces selection), `undo`, `window-raise`.
  Old names like `server-get-name`, `file-save`, `server-insert` return
  "Unknown action". Full catalog: `C:\Program Files\LyX 2.5\Resources\doc\LFUNs.lyx`.
- "Command disabled" in an ERROR reply usually means the command is a no-op
  in the current state (e.g. `buffer-write` with no changes) — not a failure
  of the transport.
- Spike script doubles as a CLI: `node spikes/spike1-pipe.mjs undo
  "self-insert:hello" server-get-filename` (colon separates func:arg).

## Clipboard protocol (verified by Spike 2)

LyX's `copy` LFUN puts the selection on the Windows clipboard in these
formats:

- **`application/x-lyx`** — a complete, valid `.lyx` document (header +
  body) containing the selection. This is the lossless structured form:
  layouts, emphasis, math insets, everything.
- `UnicodeText` / `Text` — flattened plain text.
- `HTML Format` — HTML with layout-provided styles.

**Read path (selection -> agent):** send `copy` over the pipe, then read
the `application/x-lyx` bytes from the clipboard.

**Write path (agent -> document):** write a full `.lyx` document to the
clipboard as a **UTF-8 byte stream** under `application/x-lyx`, then send
`paste`. LyX parses it and inserts rich content (verified: `\emph on/off`
survived the round-trip; the HTML flavor showed `<em>`).

- CRITICAL: the payload must be set as a **byte stream (UTF-8)**, not a
  string. Setting it as a string makes LyX silently fall back to the
  plain-text format.
- `paste` **replaces the active selection** — so "rewrite selection" is
  exactly: set clipboard + `paste`.
- Selections **persist across pipe commands** (`copy` does not clear the
  selection; `self-insert` also replaces the selection). Beware of stale
  whole-document selections — a later `self-insert` will wipe the doc.

## Modal dialogs (hazard)

A modal dialog in LyX **blocks the LFUN dispatch queue** — pipe requests
time out until the user dismisses it. Known triggers:
- `buffer-write` on an **unsaved/untitled buffer** opens Save As.
The real app must avoid dialog-triggering commands (operate only on
saved files) and detect request hangs (queue timeout + retry).

## Selection statistics

`server-get-statistics` returns "words chars chars-with-spaces" of the
current selection when one exists (`3 19 21` seen), `0 0 0` when the
selection is empty. Useful as a cheap selection probe before `copy`.

## Spike plan (validate before building the real app)

- **Spike 1 — DONE (2026-10-03):** named-pipe round-trip from Node works.
  `server-get-filename`, `server-get-layout`, `buffer-write`, and
  `self-insert` all verified live against LyX 2.5.3. See the protocol
  section above and `spikes/spike1-pipe.mjs`.
- **Spike 2 — DONE (2026-10-03):** clipboard selection round-trip works,
  in both directions, losslessly. See the clipboard section below and
  `spikes/clipboard-inspect.ps1` / `spikes/clipboard-set-lyx.ps1`.
- **Spike 3 (next):** minimal `.lyx` read-only TS parser, tested against
  lq's fixtures (repo `naivej/lq`, use only as grammar reference/fixtures).

## House rules (user instructions)

- Do not commit or open PRs without explicit approval; leave changes ready.
- Do not create worktrees; work on the current branch/folder.
- Record important decisions and findings here and in `notes.md`
  (`notes.md` holds the original brainstorm + the same architecture summary).

## Current state

- No `package.json` yet — project not scaffolded. Next milestone after
  Spike 2: init an Electron + Express + TS project modeled on Visual
  Research Pal.
- `spikes/spike1-pipe.mjs` — working Node LyXServer client + LFUN CLI.