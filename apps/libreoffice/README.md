# LibreOffice ACP Assist

A Copilot-for-Office-style AI assistant for [LibreOffice](https://www.libreoffice.org/)
— a floating companion panel that reads your document, chats, and writes
**directly into the live LibreOffice document** across **Writer, Calc, and
Impress**. All reasoning is delegated to an external agent over the
[Agent Client Protocol](https://agentclientprotocol.com/) (ACP); there is no
LLM and no API key inside this app.

This project mirrors the proven architecture of its sibling project
**LyX ACP Assist** (`lyx-acp-assist`): the document stays the single writer of
truth, all edits go through the application's own machinery, and the agent
expresses intent through a small vocabulary of action tags that the app
executes mechanically.

> **Status: Phases 1–3 complete and live-tested** — the in-process bridge,
> undo transactions, tracked changes, formatted inserts, live selection
> events, Calc cell reads/writes, and the Impress/Draw slide actions all
> pass their validation suites on LibreOffice 26.8.1.1 / Windows, and each
> module's multi-action flow was verified live with an ACP agent
> (vibe-acp). Developer-facing notes, decisions, and
> verified technical facts live in [AGENTS.md](AGENTS.md).

## Why this is *easier* than the LyX version

LyX has no scripting API, so LyX ACP Assist reaches it through two awkward
hacks: the LyXServer named pipe (LFUN dispatch strings) and a custom
`application/x-lyx` clipboard format so that LyX itself performs every paste.

LibreOffice is the opposite case: it has **UNO**, a mature, cross-module
programmatic API. We read the document model (text, structure, selections,
sheets, slides) directly and insert/replace content without touching the
clipboard. UNO also gives us things LyX could never offer:

- a real **undo manager** per document — every agent edit is one labeled,
  one-click-undoable transaction;
- **tracked changes** — every agent edit can land as a *pending change* the
  user accepts or rejects, exactly like a code assistant's diff review;
- **selection-change and document events** — the panel live-updates as you
  move the cursor;
- **one uniform API across all modules** — Writer, Calc, and Impress are
  reachable from the same bridge.

## How it works

```
┌──────────────┐   ACP (stdio JSON-RPC)   ┌─────────────────┐
│  ACP agent   │◄────────────────────────►│  Electron       │
│ (vibe-acp,   │                          │  companion       │
│  copilot,    │                          │  (chat panel)    │
│  goose, …)   │                          └───────┬─────────┘
└──────────────┘                                  │ HTTP (localhost)
                                          ┌───────▼─────────┐
                                          │  UNO bridge      │
                                          │  inside LibreOffice│
                                          │  (small .oxt)    │
                                          └───────┬─────────┘
                                                  │ UNO API
                                          ┌───────▼─────────┐
                                          │ Writer / Calc /  │
                                          │ Impress document │
                                          └──────────────────┘
```

- **Electron companion** (reused from the LyX app): floating chat panel,
  Express API, streaming responses, file attachments, per-document history.
- **ACP client** (reused verbatim): agent-agnostic — `vibe-acp`,
  `copilot --acp`, `goose acp`, or any ACP-speaking CLI.
- **UNO bridge** (new): a small Python `.oxt` extension that runs inside
  LibreOffice and exposes read/write/event operations on the active document
  over localhost HTTP. It is deliberately dumb — all intelligence lives in
  the companion, and the same bridge serves every module.
- **Module adapters** (new): per-module context building and action
  execution (see below).

### Multiple instances, ports, and discovery

No fixed ports anywhere — that's the class of bug that plagued earlier
companion apps. Each bridge binds an OS-assigned localhost port and writes a
discovery record (port + auth token) into a well-known per-user directory;
the companion scans it, drops stale records, and shows every running
LibreOffice instance. Multiple LibreOffice instances (separate profiles) and
multiple companion instances side by side just work.

One companion session talks to **one** bridge at a time — it attaches to the
most recently started LibreOffice instance it finds. All live instances are
visible in the panel; switching to another one is a reconnect, not a
simultaneous link.

### Installing the bridge

If no bridge is found and LibreOffice is installed, the panel's status line
shows an **Install bridge…** button. It installs the bundled `.oxt` into your
LibreOffice profile in one click (after a confirmation): close LibreOffice
first, click the button, restart LibreOffice, then start the bridge from the
menu (**ACP Assist > Start bridge**). The install also clears LibreOffice's
extension cache so the sidebar deck registers cleanly on the next launch.
Manual install works too — LibreOffice's Extension Manager, or `unopkg add`
from LibreOffice's `program` directory (delete `user/uno_packages/cache/`
afterwards if the sidebar deck shows up empty).

## One input box, agent-decided intent

You type a single message; the agent decides whether to reply in chat or edit
the document, and ends its reply with an action tag the app executes. The
vocabulary is module-specific; **every edit lands as a pending tracked
change with a one-click Undo.**

**Common:** `[ACTION: none]` — prose reply, document untouched.

**Writer** (paragraphs addressed as `[pN]`):

| Action | Effect |
|---|---|
| `[ACTION: insert]` | Insert at the cursor |
| `[ACTION: insert-after pN]` | Insert new paragraph(s) after `[pN]` |
| `[ACTION: rewrite]` | Replace the active selection |
| `[ACTION: rewrite-at pN]` | Replace paragraph `[pN]` (verified first) |
| `[ACTION: delete-at pN]` | Delete paragraph `[pN]` |

**Calc** (active sheet + selection surfaced as TSV with values *and*
formulas, cells addressed as `A1`):

| Action | Effect |
|---|---|
| `[ACTION: write-cells]` | Write a TSV block at the selection's top-left cell; `[ACTION: write-cells B2]` anchors it at `B2` |
| `[ACTION: rewrite]` | Replace the selected cells |
| `[ACTION: insert-rows]` / `[ACTION: insert-rows A5]` | Insert an empty row above the selection / cell |
| `[ACTION: insert-cols]` / `[ACTION: insert-cols C1]` | Insert an empty column left of the selection / cell |

**Impress** (slides addressed as `[sN]`):

| Action | Effect |
|---|---|
| `[ACTION: rewrite]` | Replace text in the selected frame(s) |
| `[ACTION: insert-after sN]` | New slide(s) after `[sN]` (title + body layout) |
| `[ACTION: rewrite-slide sN]` | Replace a slide's outline text |

### Pending changes, accept or reject

In **Writer and Calc**, agent edits are applied with change tracking on by
default, so every insertion, rewrite, and deletion appears as a tracked
change. You accept or reject each one in LibreOffice's own *Edit > Track
Changes > Manage* — the code-assistant review workflow, with zero Git
dependency. Each edit is also a single labeled undo transaction, so a quick
Ctrl+Z also reverts it as a whole.

In **Impress and Draw** these modules have no change tracking, so edits
land directly: each edit is one entry in the bridge's undo journal, and the
panel's Undo button reverts it as a whole (one click per edit). A
per-document toggle is planned for users who prefer silent application.

## Multi-module support

The bridge reports the active module type (`Writer | Calc | Impress | Draw |
other`), and the companion selects a **module adapter** that owns two jobs:

1. **Context building** — what the agent sees: Writer's outline + paragraph
   text + selection; Calc's sheet inventory + selected range as TSV with
   values *and* formulas; Impress's slide outline + selected frame text.
2. **Action execution** — verify preconditions (e.g. "paragraph `[p5]` still
   starts with the quoted text") before applying, then apply through UNO
   inside one undo transaction.

Draw is reachable for free through the Impress adapter; Math and Base are
out of scope for now.

## What we share with lyx-acp-assist

Shared code lives in the workspace package `@acp-assist/core`
(`packages/core` at the monorepo root), used by both apps:

- ACP client over stdio (agent-agnostic), shared types, agent-process spawn
- Attachment-to-text conversion (markitdown chain)
- Chat-history persistence and restart replay

Also reused in spirit from the sibling app: `src/server.ts` — Express
API: sessions, unified message stream, attachments — `src/electron/`
(shell, floating-window logic), and `public/` (companion panel UI, with
module-aware status/undo labels).

Replaced: everything LyX-specific — the `.lyx` parser, the LyXServer pipe
client, and the native clipboard adapters (the biggest platform-specific
liability of the LyX app disappears entirely). The bridge already
implements the replacement: a live in-process HTTP bridge in `extension/`.

## Roadmap

- **Phase 0 — feasibility spike: done.** All risks validated (see
  [AGENTS.md](AGENTS.md) for the findings).
- **Phase 1 — Writer MVP: done.** Chat + action loop ported and live-tested
  against the bridge; parity with LyX ACP Assist for text documents.
- **Phase 2 — Calc: done.** Sheet/selection context (TSV values +
  formulas) and cell actions (write-cells, rewrite, insert-rows/cols),
  bridge-validated end-to-end and live-tested with an ACP agent
  (multi-action run, one undo per edit).
- **Phase 3 — Impress/Draw: done.** Slide outline context and slide/frame
  actions (rewrite, rewrite-slide, insert-after with s0 = insert at the
  very start). These modules have no change tracking, so each edit is one
  entry in the bridge's undo journal — one click on Undo reverts it
  (42/42 e2e checks); live-tested with an ACP agent (two-action run,
  both edits reverted one undo each).
- **Phase 4 — polish:** one-click `.oxt` install from the panel, packaging
  (Electron installers + `.oxt`), CI, and multi-instance discovery are
  done; remaining: sidebar deck in LibreOffice (connection status,
  launch/focus companion, restart bridge, refresh agent) and
  multi-document tabs.

## Inspirations and differences

- [LibreThinker](https://github.com/mihailthebuilder/librethinker-extension)
  and [localwriter](https://github.com/balisujohn/localwriter) prove the
  `.oxt` distribution model and the sidebar/hotkey UX, but both hard-wire
  direct LLM API calls (BYOK or local Ollama/OpenAI-compatible servers). We
  take their distribution/installation pattern, but **not** their LLM wiring:
  here the agent is external, interchangeable, and the app contains no
  model, no keys, no inference.
- **LyX ACP Assist** contributes the whole companion architecture: Electron
  panel, ACP client, action-tag protocol, undo UX.