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
- **Spike 3 — DONE (2026-10-03):** read-only `.lyx` parser implemented in
  TypeScript (`src/lyx/parser.ts`), a faithful port of lq's grammar
  (strict + recovering modes, opaque preamble/Formula/ERT handling).
  37 vitest tests pass, including strict parses of 11 real fixture files
  copied from lq (MIT) into `test/fixtures/`. Node 22 + TS 5.9 + vitest
  scaffolded (`npm test`, `npm run typecheck`).

## House rules (user instructions)

- Do not commit or open PRs without explicit approval; leave changes ready.
- Do not create worktrees; work on the current branch/folder.
- Record important decisions and findings here (AGENTS.md is the
  single source of truth for architecture, protocol notes, and pitfalls;
  the old brainstorm in notes.md was folded into README.md and removed).

## Clipboard findings (critical; live-verified 2026-10-04)

- Electron 43+ replaced the synchronous clipboard API with an async
  W3C-style one (`clipboard.read()`, `clipboard.write([ClipboardItem])`).
- **Chromium wraps custom MIME types in the Web Custom Format spec**
  (magic header + name), which LyX cannot parse.
- **The `electron application/osclipboard;format="..."` escape hatch is
  UNRELIABLE and has been removed.** Live-verified failure: identical
  payloads pasted rich via a .NET/WinForms write but literal (plain-text
  fallback) via the escape hatch; read-back through Electron's own API
  succeeds (self-consistent wrapper), so in-app verification cannot
  detect the failure — only LyX sees it.
- **The app now bypasses Electron entirely**:
  `src/clipboard/native-clipboard.ts` (a RawClipboard implementation)
  uses .NET WinForms via PowerShell on Windows (verified against live
  LyX: Formula + Foot insets paste structured), `wl-copy`/`xclip` on
  Linux (custom MIME types are native there), NSPasteboard via
  `osascript` on macOS. No npm package supports arbitrary custom
  clipboard formats (checked `@mariozechner/clipboard`/`clipboard-rs`
  bindings: text/image/RTF/HTML/files only).
- `clipboard.has('application/x-lyx')` returns false for custom formats;
  attempt a read instead.
- Diagnosis recipe: if a paste comes out as literal markup, the x-lyx
  format was not readable by LyX — test the payload by writing it via
  `spikes/clipboard-set-lyx.ps1` (.NET) and pasting through the pipe;
  that isolates payload content from the write path.

## Pitfalls found while wiring the app (2026-10-03)

- **"Command disabled" is usually a no-op, not a failure** (per LyX). `undo`
  (nothing to undo) and `copy` (no usable selection, even when
  `server-get-statistics` claimed one) hit this in real use and aborted whole
  requests. `LyxServerClient` now tolerates it for `save`, `undo`, and
  `copySelection` (the latter returns false so the caller treats a possibly
  stale clipboard as "no selection").

- **JS escape bug:** in template literals `\begin_body` is a backspace
  escape — assembled payloads were silently malformed. Regression test:
  `assemblePasteDocument` output must strict-parse (`test/context.test.ts`).
- LyX buffers flag "modified externally" if the file changes on disk under
  them; pastes then fail with that error. Clear with
  `buffer-external-modification-clear`, or avoid rewriting open files
  (close the buffer first).
- Agents sometimes emit LaTeX-style inline commands (`\emph{...}`) instead
  of LyX token format (`\emph on/\emph default`); the app validates and
  retries once with a corrective prompt (`findMarkupProblems`).
- On Windows, `opencode` is a PowerShell shim: bare agent commands must
  spawn with `shell: true` (`src/acp/agent-process.ts`).

## Agent specialization (2026-10-03)

LLMs know LaTeX but not `.lyx` markup. Specialization is done with:
- **Knowledge base** (`src/lyx/knowledge.ts`): a verified cheat-sheet
  (insets with required inner `Plain Layout`, token-format emphasis,
  Formula/URL/citation examples) attached to every Insert/Rewrite/Chat
  prompt. This fixed real failures: empty yellow Note insets, malformed
  URL insets.
- **Validation + retry** (`findMarkupProblems`): LaTeX-style inline
  commands, empty insets, insets missing their inner layout trigger one
  corrective retry.
- ACP has no `systemPrompt` field in this SDK version, so prompt-level
  injection is the portable mechanism across agents.

## Attachments (2026-10-04)

`POST /api/session/:id/attachments` (JSON base64 `{name, mime, data}`) stores
a file under `<userData>/attachments`, converts it to text, and queues it for
the next message (consumed then cleared, chat-app semantics). The prompt gets
each attachment's name, stored path, and extracted text (40k char cap) — if
extraction fails, the agent is told the path and asked to read the file with
its own tools.

- Conversion chain (`extractAttachmentText`, exported): textual extensions
  read directly; binary formats via the markitdown CLI, trying in order:
  `LYX_MARKITDOWN` env override, `markitdown` on PATH, `uvx markitdown`,
  then the markitdown-mcp venv (`~\.local\venvs\markitdown-mcp\Scripts\
  markitdown.exe` — the same install the markitdown MCP uses). All spawns
  use `shell: true` (Windows shim quirk).
- Live conversion is regression-tested against a real PDF shipped with LyX
  (skips if LyX/markitdown are absent). Hand-crafted "minimal PDFs" are NOT
  valid fixtures — pdfplumber rejects them ("No /Root object").
- Attachment excerpts are capped at 40k chars; the prompt tells the agent
  the excerpt MAY BE TRUNCATED and that it must read/search the full
  stored file before concluding content is absent — and to search with
  short distinctive substrings (users misspell/translate terms). Live
  failure that prompted this: the agent searched only the inlined excerpt
  of a 300KB .lyx attachment, found nothing, and gave up, although the
  stored file had the section.
- UI: `+` button + chips row in the composer; `DELETE .../attachments/:id`
  removes a pending file.

## Lazy document context (outline-only for large docs, 2026-10-04)

Like Claude Code / Copilot CLI treat a repo: attach a map, let the agent
search/read on demand.

- Bodies up to 16k chars (`OUTLINE_ONLY_BODY_LIMIT`) attach in full (max
  fidelity). Larger documents attach ONLY the outline + the saved file
  path + instructions to read/search the file with the agent's own file
  tools. The buffer is saved before parsing (see staleness rule), so the
  file the agent reads is the live document.
- The prompt explains the [pN] ↔ file mapping: [pN] ids correspond to
  `\begin_layout` blocks in body document order (inset inner layouts
  count too), so the agent can locate [pN] by counting occurrences.
- ACP client handlers registered in `AcpClient` (`onRequest`):
  - `fs/read_text_file`: served from disk (supports line/limit) — lazy
    fetch for agents that use ACP FS instead of their own tools.
  - `fs/write_text_file`: REFUSED — LyX is the single writer of the .lyx
    file; agents must reply with an [ACTION: ...] tag instead.
  - `session/request_permission`: auto-approves tool calls (this SDK
    version has NO custom client-tool channel, so the agent's own
    grep/read tools + the file path are the search mechanism; permission
    auto-approval keeps mid-turn tool calls from stalling).

## Custom textclass support (2026-10-04)

`findClassLayouts` (exported, `src/server.ts`) resolves the active
document's `\textclass` to its style vocabulary: the class `.layout` file
is searched in `%APPDATA%\LyX2.5\layouts` (custom/journal classes first),
then the install's `Resources\layouts`, then Linux paths
(`LYX_LAYOUTS_DIR` overrides). `Input`/`Include` chains are followed
recursively (article -> stdclass.inc -> stdsections.inc etc.), so
`article` yields 33 styles and `beamer` 51 (incl. Frame/PlainFrame).
`buildContextBlock` injects the list into every prompt, and the auto
prompt tells the agent to use only those names or ones in the outline
(never invent layouts) — that covers Beamer posters and ported journal
templates without any per-class work.

## Fake-LyX test harness (2026-10-04)

`test/mock-lyx-server.ts` (`MockLyxServer`) + `test/mock-lyx-transport.ps1`
regression-test the full LFUN choreography in vitest WITHOUT a live LyX:
an in-memory document model (paragraphs, cursor, selection, clipboard)
behind REAL Win32 named pipes speaking the wire protocol.
`test/lyxserver-mock.test.ts` covers handshake, selection stats, disabled
no-ops, and the insert-after / rewrite / insert-top sequences. Use this
harness when adding new action verbs — never debug choreography only
against live LyX.

Windows named-pipe findings (all live-verified while building this;
each cost a debugging round):

- Node's `net.Server` named pipes are DUPLEX instances; the client's
  `fs.ReadStream` opens read-only, which registers as an INSTANT
  half-close against a duplex server. LyX's pipes are OUTBOUND (.out) /
  INBOUND (.in); replicate with `NamedPipeServerStream` and matching
  `PipeDirection` — that interops perfectly with fs streams.
- `NamedPipeServerStream` expects the BARE pipe NAME. Passing the full
  `\\.\pipe\...` path "succeeds" but creates a pipe nothing else can
  open (client gets ENOENT forever).
- `[Console]::In.ReadLineAsync()` in PS 5.1 BLOCKS the success stream
  when spawned from Node — stdout vanishes after the first flush. Never
  read stdin in spawned PS helpers; the transport takes commands on a
  third control pipe (`<base>.ctl`) instead.
- The client's `isAvailable()` (`fs.accessSync`) opens GHOST connections
  that steal single-instance pipes (next open gets EBUSY/ENOENT). Like
  LyX, the transport keeps a POOL of listening instances (top-up on
  consume) and tolerates ghosts: failed writes drop+replace the instance.
- `StreamWriter.Dispose()` closes the underlying pipe; after
  `Disconnect()` a writer dispose throws "Pipe is in a disconnected
  state", which misclassified live clients as ghosts and caused an
  infinite reply-redelivery loop. Use leaveOpen ctor overloads and do
  NOT dispose writers after disconnecting.
- The duplicate/delayed reply delivery the mock exhibits matches the
  documented real-LyX per-instance-buffer quirk — the client's
  waiter-based matching is what makes it harmless in both.

## Auto mode / intent inference (2026-10-04)

The manual Chat/Rewrite/Insert radio modes are GONE. One input box,
one endpoint: `POST /api/session/:id/message/stream` (SSE). The app reads
the selection (if any) + document context and lets the AGENT decide the
intent; the agent must end its reply with a trailing action tag:

- `[ACTION: none]` — prose reply, document untouched
- `[ACTION: insert]` — paste the ```lyx block at the cursor
- `[ACTION: insert-top]` — `buffer-begin` (cursor to document start) then
  paste; for titles/abstracts/front matter
- `[ACTION: insert-after pN]` — insert as its own paragraph(s) right after
  [pN]: walk + verify, collapse the selection to the paragraph end
  (`char-forward`), `paragraph-break` below it, paste into the fresh empty
  paragraph (no merge into [pN]); for "add a section/paragraph" requests
  where the position follows from the outline
- `[ACTION: insert-before pN]` — insert as its own paragraph(s) right
  before [pN]: implemented by REUSING the verified choreographies —
  p(N-1) insert-after walk for N > 1 (so verification and the fresh-empty-
  paragraph trick come for free), the insert-top choreography for p1
  (buffer-begin + paragraph-break). The reported target stays pN.
- `[ACTION: delete-at pN]` — delete paragraph [pN]: walk + verify + select,
  `char-delete-forward` (removes the text), then `mergeAwayParagraph()`
  (backspace merges the leftover empty paragraph into the previous one,
  delete-forward merges with the next when it was the first paragraph).
  tryRequest resolves successful empty-data replies to '' (falsy!) —
  always compare `!== null`.
- `[ACTION: move pN pM]` — move paragraph [pN] to right AFTER [pM]
  (pM = 0 -> very top; `moveParagraph` in server.ts). Choreography:
  gotoParagraph(pN) selects+verifies it and its verification `copy`
  leaves the x-lyx payload on the clipboard, which is captured via
  `readLyxDocument()`; then the delete-at choreography removes it;
  then `save()` — CRITICAL: the destination gotoParagraph verifies
  against the FILE on disk, which is stale after the deletion, so the
  buffer MUST be re-saved before walking to the destination (adjusted
  index: M > N -> M-1 after removal; M < N -> M; p0 -> insert-top
  choreography). Then writeLyxDocumentVerified + paste (the fresh
  empty paragraph keeps the pasted layout). Moving pN after p(N-1) or
  itself is a reported no-op. Cancel/clipboard-write failure after the
  deletion tells the user to undo in LyX (the paragraph is gone from
  the document but captured nowhere else).
- `[ACTION: rewrite]` — replace the active selection with the block
- `[ACTION: rewrite-at pN]` — replace entire paragraph [pN] (outline
  address): `buffer-begin` + N-1 × `paragraph-down` + `paragraph-select`,
  then **verify** by copying and comparing the plain text with the outline
  preview — on mismatch nothing is pasted (mis-targeted pastes cannot
  happen) and the selection is cleared (selections persist in LyX and
  would pollute later commands). Note: `server-goto-file-row` is NOT
  usable for addressing (it maps rows of the generated TeX file, needs an
  export first).
- Plain `[ACTION: insert]` merges the first pasted paragraph into the
  cursor's paragraph (it takes that paragraph's layout — live-verified
  when a pasted Subsubsection swallowed the document Title). The prompt
  warns the agent about this, and the server collapses any active
  selection first so a paste can never silently replace selected text.

**Literal-markup paste (root cause found 2026-10-04):** the paste once
came out as LITERAL markup in the document — the agent's block
strict-parsed fine and a .NET write of the same constructs pasted rich,
so the culprit was Electron's clipboard API (see "Clipboard findings").
Fixed by the native clipboard adapter. `writeLyxDocumentVerified` still
reads the payload back and retries once, and the server refuses to paste
(clean error) if it cannot verify. Never paste after an unverified write.

**LyX view disturbance (live-reported, root-caused 2026-10-09):** any LFUN
dispatched into LyX makes LyX snap its view back to the cursor — this
visibly disturbed the caret while typing in LyX AND broke
wheel-scrolling an unfocused LyX window (Windows scrolls inactive
windows; the 2s `server-get-filename` document poll kept yanking the
view back). Fix: NO polling at all. The document tab + selection
indicator refresh only on composer interaction (typing, debounced 400ms,
and clicking into the input) plus connect/send/document-switch. The
authoritative document + selection context is re-read server-side at
message-send time (`refreshActiveDocument` + `save` + `buildContextBlock`
+ `readSelection`), so dropping the poll cannot send stale context. The
focus watcher only polls Win32 `GetForegroundWindow` — it never touches
LyX's pipe — and change-detects its `setAlwaysOnTop` calls (no
redundant z-order churn).

**Verification pitfall (live-verified):** comparing the outline preview
with the clipboard text verbatim FAILS on the same paragraph — the .lyx
file stores straight quotes/ASCII dashes, but LyX's clipboard UnicodeText
export uses typographic ones (“ ” — …). Worse, the export ALSO prepends
layout environment labels ("Abstract When a probability…") and renders
math insets inline ($P$ -> "P"), while the parser preview has no inset
content. `normalizeForCompare` strips to case-insensitive letters/digits
and `isLikelyMatch` (both exported, unit-tested on the live failures)
slides overlapping 16-char windows over the expected text, requiring
>= 60% of them to appear in the actual text — label prefixes and math
insertions are tolerated, disjoint paragraphs still rejected.

**Staleness rule:** `/message/stream` saves the buffer (`buffer-write`,
saved paths only — untitled buffers would open Save As) BEFORE parsing
the context from disk. Live verification in use: after inserting the
title without saving, the outline still said [p1] = old first paragraph,
so rewrite-at p1 landed on the Title and the verification aborted the
paste.

`parseAction` (exported, unit-tested in `test/server.test.ts`) extracts
the tag + block; markup problems trigger one corrective retry
(`buildMarkupRetryPrompt`). The app keeps the mechanical/unsafe part
(clipboard write + `paste`), the agent owns intent. SSE frames:
`{"text"}`, `{"tool": {title, status}}` (agent tool activity), `{"applied":
"insert"|"insert-top"|"rewrite"}`, `{"action":"none"}`,
`{"cancelled":true}`, `{"error"}`, `{"done":true}`.

**Insert-top pitfall (live-verified failure):** `buffer-begin` puts the
cursor INSIDE the first paragraph; pasting there is an intra-paragraph
insert — LyX merges the pasted content into the existing paragraph and
DISCARDS its layout (a pasted `Title` paragraph came out as plain text
glued to the first paragraph). Fix: `buffer-begin` followed by
`paragraph-break`, which leaves an empty paragraph above the text; the
paste merges into it and keeps the layout. Undoing an insert-top takes
two undos (paste + paragraph break).

## Stop / cancel + session teardown (2026-10-04)

- `AcpClient.cancel()` sends the `session/cancel` notification via the
  SDK's generic `connection.agent.notify('session/cancel', {sessionId})`
  (`ClientContext` has no typed `cancel` method in this SDK version).
- `POST /api/session/:id/cancel` stops the running generation; the
  server checks `session.cancelRequested` before the markup-retry and
  before pasting, so a cancelled rewrite is never pasted.
- `DELETE /api/session/:id` tears a session down (stops the agent
  process and LyX pipe client) — used by the UI's Reconnect button.
- UI: agent settings (command/args) persist in `localStorage`, Stop
  button aborts the fetch + sends cancel, animated typing indicator
  (the old `setBusy` left a permanent "thinking…" bubble — fixed).

## Agents (verified end-to-end)

- `opencode acp` (v1.18.4) and **Copilot CLI `copilot --acp`** (1.0.90,
  ACP public preview) both work as the app's agent.
- `goose acp` is also installed on this machine.
- Configurable at runtime via the app's "Agent settings" panel
  (command + args, sent to POST /api/session).

## Performance note

Response latency is dominated by the agent model. Documents up to 16k body
chars attach in full every prompt; larger ones attach outline-only and the
agent lazily reads/searches the saved file (see "Lazy document context").

## Multi-document, streaming, history (2026-10-03)

The LyXServer pipe follows LyX's ACTIVE view, so documents are handled
dynamically:
- Every request re-reads `server-get-filename`; conversations are keyed
  per document path (unsaved buffers share the `(unsaved)` key).
- The app polls `/documents` every 2s, showing a tab selector; switching
  sends `file-open <path>` which activates an already-open buffer.
- Chat history persists to `<userData>/history/<hash>.json` per document
  (Electron userData is `%APPDATA%/Electron` until we set an app id /
  package the app).
- Chat streams via SSE (`POST /chat/stream`, `data: {"text": ...}` frames,
  ending `{"done": true}`); agent updates have a 240s timeout so a stuck
  agent surfaces an error instead of hanging silently.

**Pipe client rule (important):** never consume stale/unmatched replies
from the buffer — Windows broadcast duplicates of earlier requests would
be mistaken for fresh replies. Waiters are registered before sending, so
genuine replies always reach their waiter directly.

## Floating window UI (2026-10-03)

Frameless (`frame: false`) has cross-platform issues on Linux/macOS, so
we now use a normal framed window. It floats on top only while a LyX
window is the Windows foreground window (polled via PowerShell). The user
can still disable the floating behavior with the pin toggle in the toolbar.
UI calls Electron window controls through a preload bridge
(`window.electron`).

## Validated end-to-end (2026-10-03, opencode ACP agent)

Full flagship loop with the Electron app running against live LyX:
select in LyX -> `copy` -> structured read via osclipboard -> agent
rewrites -> markup validation -> raw clipboard write -> `paste` replaces
the selection -> `buffer-write`. Insert-at-cursor and undo also wired.

## Current state

- Project scaffolded: Node 22 + TS 5.9 + vitest + Express + Electron 43
  (`npm start` launches the companion app; `npm test`, `npm run typecheck`).
- `src/lyx/parser.ts` — read-only `.lyx` parser (lq grammar port).
- `src/lyx/context.ts` — outline/addressing, paste assembly, markup validation.
- `src/lyxserver/client.ts` — LyXServer pipe client (LFUN dispatch).
- `src/clipboard/lyx-clipboard.ts` + `src/clipboard/native-clipboard.ts` —
  x-lyx clipboard abstraction + cross-platform native adapter.
- `src/acp/` — ACP client (VRP pattern).
- `src/server.ts` — Express API: session (+ teardown), unified
  `/message/stream` (agent-decided intent: chat/insert/rewrite),
  documents, selection, undo, cancel. `src/electron/main.ts` + `public/` — UI.
- `test/mock-lyx-server.ts` — fake LyXServer harness (see its section).
- 66 vitest tests green.
- Tool-call progress in the stream is DONE (2026-10-04): `AcpClient.prompt`
  forwards `tool_call` session updates via `onToolCall`; the server emits
  `{"tool": {title, status}}` SSE frames; the UI shows one quiet muted line
  under the assistant bubble ("Using grep…" → "Used grep, read_file") instead
  of the typing indicator while tools run.
- Merge/split paragraph verbs DONE (2026-10-04): `[ACTION: merge pN pM]`
  (M must be N+1) = gotoParagraph(pN,'rewrite') + collapseSelectionForward
  + `mergeWithNextParagraph()` (char-delete-forward at the paragraph END
  deletes the break; the cursor MUST be at the end — at the start it just
  deletes a character). One undo reverts. Split needs NO new verb: rewrite-at
  pN with 2+ \\begin_layout paragraphs in the block splits it (verified
  mechanism all along). Tests: parseAction merge tag + mock merge choreography.
- Next: packaging.
- Packaging DONE (2026-10-04): `npm run package` -> electron-builder (NSIS
  one-click installer + portable exe) to `..\lyx-acp-assist-release`
  (OUTSIDE the repo — an editor file watcher (VS Code) locks app.asar with
  EBUSY otherwise; `scripts/find-locker.ps1` identifies lockers via the
  Restart Manager). Icon: `build\icon.ico` generated by
  `scripts\generate-icon.ps1` (System.Drawing; electron-builder accepts an
  ICO-wrapped 256px PNG). Packaging pitfalls found (each a debugging round):
  - Preload MUST be CommonJS: sandboxed preloads run outside the ESM
    pipeline ("Cannot use import statement outside a module"). Fixed by
    excluding src/electron/preload.ts from the ESM tsconfig and compiling
    it with tsconfig.preload.json; `npm run build` chains both.
  - The ACP SDK declares `zod` as a PEER dependency — it only worked in dev
    because npm hoisted vitest's zod; the packaged app crashed with
    ERR_MODULE_NOT_FOUND until `zod` was added to OUR dependencies.
  - A "JavaScript error" modal from an OLD build keeps appearing while the
    new build is still running — kill instances before re-testing.
  - The packaged app gets its own identity: userData is now
    `%APPDATA%\LyX ACP Assist` (appId com.guzma.lyx-acp-assist) instead of
    the generic `%APPDATA%\Electron`.
  - Verified end-to-end: packaged exe starts, serves the UI, `/api/status`
    reports the live LyX pipe, remote debugging (--remote-debugging-port)
    confirms the renderer loads our URL.