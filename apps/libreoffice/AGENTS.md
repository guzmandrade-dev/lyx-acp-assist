# AGENTS.md — libreoffice-acp-assist

Important project context and decisions. Read this before doing any work here.

## What this project is

A Copilot-for-Office-style LLM assistant for **LibreOffice** (Writer first, then
Calc and Impress): a floating companion panel that reads the document, chats,
and writes **directly into the live document** — not a diff/code-review tool.
Companion architecture: LibreOffice stays the editor; our app is a chat
surface plus context provider; all reasoning is delegated to an external
**ACP agent over stdio** (agent-agnostic — `opencode acp`, `copilot --acp`,
`goose acp`). No LLM, no API keys inside this app.

The design deliberately mirrors the sibling project **LyX ACP Assist**
(`C:\Users\guzma\Git\lyx-acp-assist`): Electron + Express + TypeScript
companion, `@agentclientprotocol/sdk`, one input box with agent-decided
action tags, per-document chat history, undo UX. Reuse its code
(`src/acp/`, `src/server.ts`, `src/electron/`, `public/`) wherever possible.
The LyX project is the reference for conventions; this file follows its
AGENTS.md split (README = user-facing; AGENTS.md = decisions, verified
facts, pitfalls).

## Decided architecture (2026-10-16) — do not relitigate casually

**Minimal Python `.oxt` "bridge" inside LibreOffice (Option A) + Electron
companion outside.**

1. **Bridge = dumb transport.** A Python UNO component (bundled LibreOffice
   Python, zero user dependencies) runs an HTTP server on a dynamic
   localhost port inside the LibreOffice process. No business logic there —
   just a JSON read/write/event surface over UNO. All intelligence stays in
   the companion, and the same bridge serves Writer, Calc, and Impress.
2. **Companion = the app.** Electron panel, ACP client, action-tag execution,
   context building, per-document history — ported from lyx-acp-assist.
3. **Writer first, module-adapter abstraction from day one.** The bridge
   reports the active module type; the companion selects a per-module
   adapter (context builder + action handlers). Calc and Impress are new
   adapters, not new architectures.
4. **Agent edits land as tracked changes by default** (`RecordChanges` on),
   each wrapped in one labeled undo-manager transaction. Accept/reject in
   LibreOffice's own *Edit > Track Changes*; undo at the edit level.
5. **Dynamic ports + discovery files everywhere** — no fixed ports. Bridges
   write `<pid>.json` records (port + bearer token) into a per-user
   `bridges/` directory; the companion scans, drops dead PIDs, shows every
   live LibreOffice instance. The companion's own Express server follows the
   same rule, so multiple LibreOffice *and* multiple companion instances are
   first-class (the Visual Research Pal failure mode must not come back).
6. **Streaming: robust first.** The edit lands only at the end of the reply,
   inside one undo transaction — same model as the LyX app. Streaming edits
   are a possible later enhancement for *both* projects.

### Rejected / deferred alternatives

- **External UNO socket connection** (`soffice --accept=socket,...` + Python
  sidecar): no extension to install, but requires LibreOffice launched with
  the accept flag; an already-running instance can't be retrofitted without a
  restart. Real UX paper cut. Rejected as primary; still useful as the
  *test harness* for validation suites (see below).
- **Full in-app sidebar (LibreThinker's approach)**: rejected as primary —
  LibreOffice's sidebar toolkit is poor for streaming chat UIs, and ACP agent
  process management (spawning CLI processes, stdio multiplexing) belongs in
  Node. A thin sidebar deck (status, launch/focus companion, restart bridge,
  refresh agent) is planned for Phase 4 only.
- **Math and Base modules**: out of scope for now. Draw rides free through
  the Impress adapter.

## Environment facts (verified 2026-10-16)

- LibreOffice **26.8.1.1** at `C:\Program Files\LibreOffice`
  (`program\soffice.exe`, `program\unopkg.exe`).
- Bundled Python **3.13.15** at `program\python.exe` with full stdlib
  (`http.server`, `json`, `secrets`, …) and pyuno (`program\uno.py`) —
  the same interpreter runs in-process via the Python-UNO component loader.
- Scratch profile for all testing (never touch the user's real profile):
  `-env:UserInstallation=file:///C:/Users/guzma/AppData/Local/Temp/lo-acp-spike`
- For validation suites, LibreOffice runs with a UNO socket:
  `--accept=socket,host=localhost,port=2002;urp; --nodefault --norestore`,
  and the client connects via the bundled python to
  `uno:socket,host=localhost,port=2002;urp;StarOffice.ComponentContext`.
- Windows box; LibreOffice windows are reachable for UI-level checks via the
  computer-use tools (menubar items appear in the accessibility tree).

## Bridge implementation rules (verified by the Phase 0 spike)

1. **Ship a Python UNO component, NOT ScriptProvider scripts.** Script URLs
   for extension-hosted Python embed the package's transient unpack path
   (`...uno_packages/luXXXX.tmp_/...`), which changes on every reinstall —
   useless for static menu wiring. The working pattern (localwriter's):
   register the `.py` in the manifest with media-type
   `application/vnd.sun.star.uno-component;type=Python`, expose
   `g_ImplementationHelper.addImplementation(cls, "org.libreofficeacp.bridge",
   ("com.sun.star.task.Job",))` implementing `XJobExecutor`, and dispatch it
   with `service:org.libreofficeacp.bridge?start` / `?stop` URLs wired in
   `Addons.xcu`. No RDB needed for standard interfaces only.
   `XSCRIPTCONTEXT` does not exist in that context — fall back to
   `uno.getComponentContext()`.
2. **The HTTP thread must never touch UNO.** UNO document calls are not
   thread-safe (SolarMutex). Every operation is marshaled onto the main
   thread via `com.sun.star.awt.AsyncCallback.addCallback` with a Python
   `Event` to block on (timeout → HTTP 500). Verified reliable from
   background threads; this is the load-bearing design decision.
3. **Insert at the view cursor is typing semantics.** `\n` in inserted text
   becomes real paragraph breaks (`insertControlCharacter` with
   `PARAGRAPH_BREAK`), existing content is pushed down, and the cursor ends
   after the inserted run (`goLeft(len, True)` → set props →
   `goRight(len, False)`). Reading back, paragraph separators come as
   `\r\n` — **normalize to `\n`** when building agent context.
4. **Undo**: `doc.getUndoManager()`: `enterUndoContext("ACP edit")` /
   `leaveUndoContext()`; availability check is `isUndoPossible()`
   (NOT `isUndoable` — that name doesn't exist and raises AttributeError).
5. **Tracked changes**: set `RecordChanges` (a doc property) *before*
   entering the undo context, restore the previous value *after* leaving it
   (so the toggle itself isn't undone). Edits then appear as redlines;
   `doc.getRedlines()` enumerates them (`RedlineType` = `Insert`).
6. **`unopkg add` fails if an extension with the same identifier is already
   installed** — the companion's installer/updater must `unopkg remove
   org.libreofficeacp.bridge` first, then add, then restart the office.
7. **Server shutdown**: `ThreadingHTTPServer.shutdown()` alone leaves the
   listening socket open and clients hang until timeout — call
   `server_close()` too so clients fail fast.
8. **Menu items in Addons.xcu** work with `service:` URLs; use `&amp;`-escaped
   ampersands in any query strings. The current description.xml namespace is
   `http://openoffice.org/extensions/description/2006` (the legacy
   `http://openoffice.org/2000/description` is rejected by unopkg in 26.8).
9. **pyuno object identity**: `d is other` is always False across calls
   (fresh wrappers); compare by `getTitle()`/URL or UNO equality, not `is`.

## Spike artifacts (Phase 0, all 26 checks passed, 2026-10-16)

- `spike/oxt/` — the bridge `.oxt` sources: `acpbridge.py` (~380 lines:
  HTTP server, discovery records, token auth, `/status`, `/document`,
  `/documents`, `/insert` (text, style, bold, tracked), `/undo`,
  `/events?since&timeout` long-poll), `Addons.xcu` (ACP Assist menu),
  `description.xml`, `META-INF/manifest.xml`.
- `spike/validate/client_validate.py` — UNO-mechanics suite (13 checks), run
  against a socket-connected LibreOffice with a scratch profile.
- `spike/validate/bridge_e2e.py` — end-to-end bridge suite (13 checks),
  reads the discovery record, exercises every endpoint over HTTP.
- Re-run cycle: repackage (zip `spike/oxt` contents with the bundled python's
  `zipfile` — forward-slash entries matter), `unopkg remove` + `add` with the
  scratch profile env, relaunch soffice with `--accept`, dispatch
  `service:org.libreofficeacp.bridge?start`, run the suites.

When touching bridge behavior, add/extend a check in `spike/validate/` and
run the relevant suite before declaring the work done.

## House rules (user instructions)

- **Do not commit or open PRs without explicit approval.** Finish tasks with
  the changes ready to commit.
- **Do not create worktrees**; work on the local branch unless explicitly
  approved.
- Keep this file (AGENTS.md) for decisions, verified facts, pitfalls, and
  house rules; keep README.md user-facing. Mirror the lyx-acp-assist
  conventions.

## Current state

Phase 0 spike complete and validated end-to-end (Windows, LibreOffice
26.8.1.1). No companion code yet — Phase 1 is porting the lyx-acp-assist
companion against the spike bridge through a proper module-adapter
interface. Roadmap and scope live in README.md.