# AGENTS.md — libreoffice-acp-assist

Important project context and decisions. Read this before doing any work here.

## What this project is

A Copilot-for-Office-style LLM assistant for **LibreOffice** (Writer first, then
Calc and Impress): a floating companion panel that reads the document, chats,
and writes **directly into the live document** — not a diff/code-review tool.
Companion architecture: LibreOffice stays the editor; our app is a chat
surface plus context provider; all reasoning is delegated to an external
**ACP agent over stdio** (agent-agnostic — `vibe-acp`, `copilot --acp`,
`goose acp`). No LLM, no API keys inside this app.

The design deliberately mirrors the sibling project **LyX ACP Assist**
(`apps/lyx` in this monorepo): Electron + Express + TypeScript
companion, `@agentclientprotocol/sdk`, one input box with agent-decided
action tags, per-document chat history, undo UX. Shared code (ACP client,
types, attachment conversion, history persistence) lives in the workspace
package `@acp-assist/core` (`packages/core` at the monorepo root);
app-specific code stays under `src/` here.
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
  `-env:UserInstallation=file:///C:/Users/<user>/AppData/Local/Temp/lo-acp-bridge`
  (replace `<user>`)
- For validation suites, LibreOffice runs with a UNO socket:
  `--accept=socket,host=localhost,port=2002;urp; --nodefault --norestore`,
  and the client connects via the bundled python to
  `uno:socket,host=localhost,port=2002;urp;StarOffice.ComponentContext`.
- Windows box; LibreOffice windows are reachable for UI-level checks via the
  computer-use tools (menubar items appear in the accessibility tree).

## Bridge implementation rules (verified by the Phase 0 feasibility probes)

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
10. **Only the VIEW cursor has typing semantics.** Plain `XTextCursor`
    inserts never advance the cursor past the written text (and
    `insertString` on a text cursor can land *before* previously written
    text — probes 1–3), so multi-paragraph writes through a text cursor
    degenerate. Every bridge edit mode therefore positions the
    **view cursor** (`vc.gotoRange(...)`) and types through it.
11. **`createTextCursorByRange(para)` returns a COLLAPSED cursor** (at the
    range end), not an expanded range. To select a paragraph's text:
    `vc.gotoRange(para.getStart(), False)` then `vc.goRight(n, True)`.
    Verified working for delete/rewrite selections (probe 5/7).
12. **insert-top needs the content-then-break choreography**: break-first
    at the document start degenerates (empty paragraph + content merges
    into the old first paragraph). Insert content first, then a break
    after EVERY paragraph — verified by probe 7 (T1/T1b).
13. **Tracked deletions keep ghost text in model reads**: with
    `RecordChanges` on, deleted text stays in the document model until
    the user accepts the redline — paragraph enumeration `getString()`
    still includes it, with the typed replacement PRECEDING the ghost
    (probe 6/7 + e2e). Consequences: (a) `/document` reads show the
    pre-accept state — the agent's context says so; (b) paragraph indices
    stay stable across pending deletions, which keeps [pN] addressing
    consistent in multi-action runs; (c) e2e assertions on edited
    paragraphs must expect `NEW + OLD` concatenation in tracked mode.
    Untracked edits (`tracked: false`) delete for real.
14. **Set run properties explicitly ON and OFF** (CharWeight 100 /
    FontSlant NONE when a flag is absent): typing continues the previous
    run's direct character formatting, so an unstyled run after a bold
    run would silently inherit bold.
15. **Tracked paragraph-mark deletions need the dispatch path.** Raw
    `setString("")` on a view-cursor selection that includes the
    paragraph break silently no-ops (or half-applies, cancelling
    never-accepted insertions but leaving an empty paragraph) under
    RecordChanges inside undo contexts — probes 8-9. Use the
    `.uno:Delete` dispatch instead (the UI's own edit route): it records
    a clean pending-deletion redline for real content, and coalesces
    never-accepted insertions like the UI does. After it, if the target
    paragraph became EMPTY (the coalescing artifact), remove that empty
    paragraph with an UNTRACKED setString cleanup inside the same undo
    context — content-free, so nothing reviewable is lost, and one undo
    restores the whole edit (probes 10-11).

## Calc bridge rules (verified 2026-10-16, Phase 2)

16. **Structural row/column inserts use `insertByIndex`** —
    `sheet.getRows().insertByIndex(row, count)` /
    `sheet.getColumns().insertByIndex(col, count)`. There is no
    `insertBy` (AttributeError). Edits live in the same
    one-undo-transaction pattern as Writer.
17. **Formula references follow the moved data on row/col inserts**:
    with `=B2*2` at B3, inserting a row above row 2 moves the formula
    to B4 AND rewrites it to `=B3*2` — the computed value is preserved.
    Do not assume refs stay textually fixed.
18. **`RecordChanges` is a readable/writable document property on Calc**
    (reads `False` by default; toggling around the undo context works).
    The bridge treats it as optional anyway (`_get_record_changes`
    returns None for modules that don't expose it). Calc redline
    enumeration is NOT yet verified — only content + undo are asserted.
19. **Read path is `getDataArray()` + `getFormulaArray()`** on a capped
    range: raw values (floats for numbers AND dates — no display
    formatting), normalized by the bridge (int-valued floats → ints,
    None → ""). The formula grid is returned only when at least one
    cell's formula starts with `=`; otherwise `formulas` is null.
20. **`loadComponentFromURL` over the UNO socket does NOT focus the new
    document** — the bridge serves the desktop's CURRENT component, so
    validation harnesses must `controller.getFrame().activate()` after
    loading (this bit both the Writer and Calc e2e sections on a fresh
    soffice). This is a harness concern, not a companion one: real user
    interaction always has a focused window.
21. **Calc selection objects come in two shapes**: single range
    (SheetCellRange — `getRangeAddress()`) and multi (SheetCellRanges —
    enumerate). The bridge handles both; data is read from the FIRST
    range, all range names are listed.

## Impress/Draw bridge rules (verified 2026-10-18, Phase 3 probes 12–12i)

22. **Slide enumeration**: `doc.getDrawPages()` (XIndexAccess) →
    `getCount()` / `getByIndex(i)`; each page is an XShapes
    (`getCount()` / `getByIndex(j)`). `page.getName()` returns POSITIONAL
    names (`page1`, `page2`, … renumbered after inserts) — never use it as
    identity; the 0-based page index is the identity. A fresh
    `private:factory/simpress` deck has ONE slide with `TitleTextShape` +
    `SubtitleShape` placeholders; placeholder shapes read as `''` (the
    "Click to add" hints are UI-only).
23. **Shape classification must use `getShapeType()`**, NOT
    `supportsService` — a SubtitleShape reports `supportsService(
    "com.sun.star.presentation.SubtitleShape") == False` (it only
    supports `drawing.TextShape`) while its type name is correct. Kind
    mapping: `presentation.TitleTextShape` → title;
    `presentation.OutlinerShape` / `presentation.SubtitleShape` → body;
    `drawing.TextShape` → text; everything else → other (count only).
24. **Shape text**: `getString()`/`setString()` use `\n` as the paragraph
    separator (NO `\r\n`, unlike Writer — normalization is a harmless
    no-op). `setString("a\nb")` creates real paragraphs. `ParaStyleName`
    does NOT exist on shape paragraphs (UnknownPropertyException on read
    AND write — even non-empty ones); never touch it. Manually created
    presentation shapes auto-format correctly (title CharHeight 44,
    outliner 32 with bullets), so plain `setString` is enough.
25. **pyuno `==` works across fresh wrappers** (a page fetched twice
    compares equal); `is` never does. Use `==` scans for "which slide
    index is this page / which (slide, shape) is this selected shape".
    `ctrl.getCurrentPage()` returns the active page; index discovery is an
    `==` scan. `ctrl.setCurrentPage(page)` switches it and fires
    selection-changed (as does `ctrl.select(shape)`).
26. **Selection**: `ctrl.getSelection()` is `None` with nothing selected,
    else an SvxShapeCollection (XShapes: `getCount()`/`getByIndex()`) for
    single AND multi shape selections. Locate each selected shape's
    (slide, shape) indices by `==` scan over all pages. What a controller
    returns while the user is TEXT-EDITING inside a shape is unprobed (no
    programmatic route into text-edit mode) — the bridge treats
    non-shape selections as no-selection.
27. **Impress/Draw undo is fundamentally different from Writer/Calc**
    (probe 12d): API text edits (`setString`, cursor insertString), plain
    `drawing.TextShape` adds, and `shape.dispose()` create NO undo
    actions; `insertNewByIndex` pushes a BROKEN action (undo() succeeds
    but the page stays). Only presentation-shape adds, shape moves, and
    the `.uno:InsertPage` / `.uno:DeletePage` dispatches record working
    actions. Therefore: Impress/Draw edits run inside
    `um.lock()`/`um.unlock()` (verified to suppress ALL undo recording,
    API and dispatch alike) and the bridge keeps a **per-edit undo
    journal**; `/undo` pops the journal entry (restore texts and/or
    `.uno:DeletePage` the inserted page, both under lock). Empty journal →
    fall back to the native `um.undo()` (the user's own UI edits). Known
    limitation: interleaved user edits can desync journal indices
    (best-effort, skip-missing on restore).
28. **`enterHiddenUndoContext()` is unusable** — it throws
    EmptyUndoStackException without a previous undo action. `lock()` is
    the recording suppressor.
29. **`insertNewByIndex(i)` lands the new page at 0-based index `i+1`**
    (AFTER page i) — `insertNewByIndex(0)` can NEVER produce index 0. To
    insert after 1-based slide N → `insertNewByIndex(N-1)`. API-inserted
    pages are EMPTY (no placeholders): create the presentation shapes
    manually with cloned default geometry — title pos (1400,628) size
    (25199,2629); body pos (1400,3685) size (25199,9134).
30. **Page deletion**: XDrawPages has NO `removeByIndex`, and
    `page.dispose()` is a TRAP — it does not remove the page, it corrupts
    it (subsequent reads throw RuntimeException). The only working
    removal is the `.uno:DeletePage` dispatch, which deletes the CURRENT
    page: steer with `setCurrentPage(target)` first. Under `um.lock()` it
    records no undo action; without lock it is properly undoable.
31. **s0 (insert at the very start) needs a text-swap choreography**
    (rule 29 blocks a page at index 0): insert the new page at index 1,
    move slide 1's title/body text into the new page's shapes, then write
    the new content into slide 1's shapes. Net effect: new content on
    slide 1, old slide-1 content on slide 2. Journal: restore slide 1's
    original texts + delete the page at index 1. Requires slide 1 to have
    a title frame (refused otherwise).
32. **`.uno:InsertSlide` and `.uno:DeleteSlide` are dead in the socket
    context** (no-op even with a verified current page); `.uno:InsertPage`
    works even inside Impress (creates a Title+Outliner placeholder page
    after the current page — the bridge does not use it; the API route +
    journal is chosen) and `.uno:DuplicatePage` duplicates after the
    current page.
33. **`RecordChanges` and `getRedlines()` are ABSENT on Impress/Draw
    documents** (getPropertyValue/getRedlines throw) — the tracking
    toggle is skipped (`_get_record_changes` already returns None) and
    edits are undo-only (via the journal). This matches the README's
    promise.
34. **Draw behaves identically for every primitive above** (verified
    12i): getDrawPages/getCurrentPage/setCurrentPage/`==` scans/
    selection-as-collection/locked DeletePage all work the same. Draw has
    no presentation shapes — inserted pages get a plain `TextShape`
    carrying the whole content, and `rewrite-slide` is refused (no
    title/body frames; use rewrite on a selected frame).
35. **Multi-instance discovery verified (2026-10-18)**: two soffice
    processes, separate scratch profiles + accept sockets (2002/2003),
    the oxt installed into BOTH profiles — both bridges run
    simultaneously, each writing its own `<pid>.json` record with a
    distinct OS-assigned port AND token. `discoverBridges()` returns
    both, newest-started first; each record reaches only its own bridge
    with its own token. Killing one soffice (real `taskkill` by PID)
    makes the next scan drop its record AND unlink the file — same for
    a synthetic dead-PID record. `bridge_ctl.py` takes `[host] [port]`,
    so instance B is `bridge_ctl.py start localhost 2003`. Companion
    side is dynamic by construction (both `standalone.ts` and
    `electron/main.ts` bind `:0`, PORT overrides). UX fact: the server
    attaches to `bridges[0]` (newest, `src/server.ts` `pickBridge`) —
    one session ↔ one bridge; switching instances = reconnect.
    Check script: `test-bridge/multi_instance_check.mjs` (7/7).

## Repository layout (reorganized 2026-10-21)

- `extension/` — the shippable bridge `.oxt` sources (was `spike/oxt/`):
  `acpbridge.py` (HTTP server,
  discovery records, token auth, `/status`, `/document` (Writer: paragraphs +
  styles + selection + cursorStyle + lazy preview mode; Calc: sheet
  inventory + capped selection/used-range values+formulas grids),
  `/documents`, `/document/p/:i` lazy paragraph fetch, `/edit` (Writer
  modes: insert, insert-top, insert-after, rewrite, rewrite-at, delete-at;
  Calc modes: write-cells (A1 anchor or selection top-left, `=`-prefixed
  cells become formulas), insert-rows, insert-cols; tracked-changes + one
  undo transaction per edit), `/activate`, `/undo`, `/events?since&timeout`
  long-poll), `Addons.xcu` (ACP Assist menu), `description.xml`,
  `META-INF/manifest.xml`. Packaged into `acp-bridge.oxt` by
  `scripts/package-oxt.py` (`npm run package:oxt`; gitignored).
- `test-bridge/` — the bridge validation suites and probes (was
  `spike/validate/`):
  - `client_validate.py` — UNO-mechanics suite (13 checks), run
    against a socket-connected LibreOffice with a scratch profile.
  - `bridge_e2e.py` — end-to-end bridge suite (47 checks:
    16 Writer/general + 7 Calc + 14 Impress + 3 Draw + 4 sidebar +
    activate/stop), reads the discovery record, exercises every endpoint
    over HTTP. Needs a FRESH soffice (its initial checks assume
    no open documents; run it after a restart, not right after
    client_validate.py which leaves documents open).
  - `multi_instance_check.mjs` — companion-side discovery
    check (run with node, needs `npm run build`): requires TWO live bridge
    instances (separate profiles + accept sockets, oxt in both), asserts
    both records found newest-first, each reachable with its own token,
    distinct ports, dead-PID records dropped + unlinked. 7 checks
    (rule 35).
  - `bridge_ctl.py` — start/stop the bridge over the UNO
    socket (test helper).
  - `cursor_probe*.py` — the empirical UNO cursor-semantics
    probes that produced rules 10–14 above (kept for reference; not part of
    the pass/fail suites). `cursor_probe12*.py` (12, 12b–12l) did the same
    for Impress/Draw and the sidebar deck and produced rules 22–44.
- Re-run cycle: `npm run package:oxt`, `unopkg remove` + `add` with the
  scratch profile env, relaunch soffice with `--accept`, dispatch
  `service:org.libreofficeacp.bridge?start`, run the suites.

When touching bridge behavior, add/extend a check in `test-bridge/` and
run the relevant suite before declaring the work done.

## Sidebar deck rules (verified 2026-10-21, Phase 4)

36. **Sidebar `ContextList` is a STRING-LIST, not a string**: the .xcu
    value MUST carry `oor:separator=";"` with items like
    `any, any, visible ;` (exactly LO's own Sidebar.xcu syntax). A plain
    string value gets whitespace-split by the config layer into garbage
    items (`'any,'` etc.) that ReadContextList silently rejects — the deck
    registers in config but never matches any context and the deck button
    never appears. This was the entire "missing deck button" debugging
    session; the e2e now asserts the merged ContextList shape.
37. **Toolkit.createWindow: WindowServiceName is "pushbutton"**, NOT
    "button" — the raw VCL toolkit returns None for "button" in 26.8
    (probe 12k). "fixedtext" works as expected.
38. **XSidebarPanel.getHeightForWidth returns a LayoutSize STRUCT**
    (`com.sun.star.ui.LayoutSize(min, max, preferred)`), not a bare long
    — returning an int raises a type-coercion RuntimeException over the
    socket.
39. **pyuno proxy contract for panel objects over the UNO socket**: the
    panel arrives typed as XInterface. queryInterface needs an explicit
    `uno.getTypeByName("com.sun.star.ui.XToolPanel")` — the *imported
    interface class* is NOT a UNO type. Readonly interface attributes
    (`XToolPanel.Window`) dispatch via getattr on the Python object —
    expose them as a `@property`, not only via the getter method.
40. **frame.getContainerWindow() does not expose XAccessible over the
    socket** — LO-side a11y-tree walking from Python failed. Use the
    Windows accessibility tree (computer-use tools) to drive/verify the
    LibreOffice UI; the deck bar buttons appear there as AXButtons.
41. **Extension icon URLs**: `vnd.sun.star.extension:<id>/icon.png`
    (single colon) works for deck IconURL; the PNG needs a plain
    manifest file-entry. A 32px PNG renders at native size (41×43 button
    vs 57×59 for LO's own SVG icons) — acceptable for the deck bar.
42. **Deck registration flow (verified live)**: Sidebar.xcu deck+panel
    merge into org.openoffice.Office.UI.Sidebar (ConfigurationProvider
    confirms), Factories.xcu registers the factory under
    org.openoffice.Office.UI.Factories/Registered/UIElementFactories
    (Type=toolpanel, Name=ACPPanelFactory), the framework instantiates
    the factory by implementation name through the service manager when
    the deck opens (createUIElement receives Frame/ParentWindow/Sidebar
    args), and the panel populates the framework-provided parent window
    with toolkit widgets. Buttons must be created with SHOW attribute;
    click handlers run on the main thread.
43. **SAL_WARN capture**: launch `soffice.bin` directly (not the
    soffice.exe shim) with stderr redirected — the sidebar context
    parser logs every rejected ContextList entry under sfx.sidebar.
44. **Status reads must not block the UI thread**: the panel's status
    worker runs HTTP on a daemon thread and marshals label updates back
    via com.sun.star.awt.AsyncCallback (same pattern as the bridge's
    MainThreadCall — rule 2 applies to panel code too).
45. **Raw VCL toolkit windows do NOT implement XPropertySet** (probe
    2026-10-21, visible AND invisible fixedtext windows):
    `queryInterface(XPropertySet)` is None and `setPropertyValue` raises
    AttributeError — in-process and over the socket alike. Commit 03b821c
    ("set explicit FontHeight on sidebar status labels") therefore broke
    panel INSTANTIATION everywhere (deck renders empty: no labels, no
    buttons). Its "verified live" claim ran against a stale cached oxt
    (the AX verification quoted 244x18 bounds — the OLD geometry the
    commit changed away from). Reverted 2026-10-21; the e2e factory check
    is the regression guard (it failed 46/47 with the crash). If a label
    font ever really needs setting, use a control + model
    (UnoControlFixedTextModel), not property sets on the raw window.
46. **Extension .xcu config layers MUST use the `oor:component-data`
    format** (verified live 2026-10-21 with a ConfigurationProvider probe
    against a scratch-profile socket): the `oor:items`
    registrymodifications format does NOT register set members —
    Deck['ACPDeck'] / Panel['ACPStatusPanel'] silently vanish from the
    merged config (only a parent-path NODE fuse on UIElementFactories
    merged, which is how the broken build still registered the factory).
    A session mid-flight converted Sidebar.xcu/Factories.xcu to item
    format to chase the empty-deck symptom; that was the wrong turn (the
    empty deck was the rule-45 FontHeight crash) and was reverted.
    Quick format probe helper pattern: `acp_probe_sidebar.py`-style
    ConfigurationProvider reads over the accept socket.

## Sidebar deck (done 2026-10-21)

Phase 4's in-LibreOffice presence, complete and verified live in the UI
(computer-use AX tree; every control exercised):

- `extension/acppanel.py`: AcpPanelFactory (XUIElementFactory,
  implementation name org.libreofficeacp.PanelFactory) + AcpPanel
  (XUIElement/XToolPanel/XSidebarPanel/XComponent) — two status labels
  (bridge: newest live discovery record + /status probe; companion:
  companion.json record + /api/status probe) and three buttons: Refresh
  status, Restart bridge (dispatches service:...?stop+?start — verified:
  bridge came up on a fresh dynamic port and the label updated to
  "running on port N (writer document)"), Open companion
  (SystemShellExecute on the record's exe, or the URL in dev mode —
  verified: the panel URL opened in the default browser).
- `extension/Sidebar.xcu` + `Factories.xcu` + `icon.png` (+ manifest
  entries; Addons.xcu gains "Show status panel" (Ctrl+F5) menu item).
- Companion side writes its discovery record
  (`%APPDATA%/LibreOffice ACP Assist/companion.json`, pid/port/url/exe):
  `src/bridge/client.ts` helpers, written by `standalone.ts` (exe: null
  → dev URL) and `electron/main.ts` (exe: process.execPath when
  packaged), removed on shutdown.
- e2e: 4 sidebar checks (config registration incl. the ContextList
  regression guard, factory instantiation with interface queries) —
  bridge_e2e now **47/47**. Probes 12j–12l document the discovery.

- **Do not commit or open PRs without explicit approval.** Finish tasks with
  the changes ready to commit. (Standing exception, approved 2026-10-17:
  small structured commits as work progresses — but never commit
  `next-steps.md`, the cross-session handoff file; it stays untracked.)
- **Do not create worktrees**; work on the local branch unless explicitly
  approved.
- **opencode is RETIRED (2026-10-18, user request — security breach).**
  The default agent everywhere (code defaults, docs, live regressions) is
  `vibe-acp` (no args; on PATH). Historical mentions of opencode in live-test records stay as
  facts, but never run it for new work.
- Keep this file (AGENTS.md) for decisions, verified facts, pitfalls, and
  house rules; keep README.md user-facing. Mirror the lyx-acp-assist
  conventions.

## Current state

Phase 1 (Writer MVP) is complete and live-tested end-to-end with opencode:
companion ported from lyx-acp-assist, multi-action loop, bridge client,
Writer adapter — all 37 unit/server tests pass.

Phase 2 (Calc) is complete and live-tested end-to-end with opencode
(2026-10-17, re-verified independently):
- Bridge: Calc read (sheets, selection values+formulas, active-sheet
  used-range data, all capped/trimmed) + write-cells / insert-rows /
  insert-cols inside one undo transaction; mechanics 13/13.
- Companion: `src/modules/calc.ts` adapter (A1 addressing, ```calc TSV
  blocks, write-cells/rewrite/insert-rows/insert-cols action tags),
  Calc-aware context/selection building, UI feedback labels.
- Live regression (opencode): the agent ran a two-action run
  (insert-cols E1, then write-cells E1 with correct per-row
  =Qty*Price formulas) and stopped cleanly; both edits reverted with
  one undo each.

Phase 3 (Impress/Draw) is complete and live-tested end-to-end with
vibe-acp (2026-10-18):
- Bridge: Impress/Draw read (slide outline with shape kinds, current
  slide, selection with (slide, shape) indices, capped/truncated) +
  rewrite-frame / rewrite-slide / insert-slide-after (s0 = insert at
  the very start via the rule-31 text swap) + `/document/s/:i` lazy
  fetch; edits run inside `um.lock()` and revert through the undo
  journal (rule 27); e2e 42/42 (16 Writer/general + 7 Calc + 14 Impress +
  3 Draw + activate/stop), mechanics 13/13.
- Companion: `src/modules/impress.ts` adapter (serves draw too;
  ```impress blocks: first line = title, following lines = body;
  rewrite / rewrite-slide / insert-after tags), deck-outline context,
  frame selection block, module-aware UI feedback labels + TurnMeta
  module field; npm test 54/54.
- Live regression (vibe-acp — verified as a third ACP agent alongside opencode): the agent ran a
  two-action run (insert-after s2 "Conclusions" with two bullets, then
  rewrite-slide s1 to an informal title-only reword) and stopped with
  `none`; deck verified via UNO (4 slides, right indices, body
  untouched), and two /undo clicks restored the exact original deck.
  Helpers: `test-bridge/seed_deck.py`, `verify_deck.py`,
  `live_drive.mjs` (drives the panel's HTTP API from plain node).

Next: Phase 4 (polish) — panel UI smoke test DONE (2026-10-18, see
below); multi-instance discovery test DONE (2026-10-18, rule 35);
companion auto-install of the .oxt DONE (2026-10-18, see "Bridge
auto-install" below); packaging + CI DONE (2026-10-18, see "Packaging
and CI" below); remaining: sidebar deck. The optional small UI bits are
DONE (2026-10-19, see "Panel UI bits test" below).
Roadmap and scope live in README.md.

## Bridge auto-install (done 2026-10-18)

One-click .oxt install from the panel: `src/bridge/install.ts`
(findUnopkg with LO_UNOPKG env override; sofficeRunning probe;
rule-6 remove-then-add via spawned unopkg), server routes
`GET /api/bridge/install/preflight` (read-only: oxt found, unopkg
found, soffice running) and `POST /api/bridge/install` (409 while
LibreOffice runs; runs against the user's REAL profile, so the panel
confirms before calling). Panel shows an "Install bridge…" button in
the status line only when preflight says canInstall. oxtPath: dev =
`acp-bridge.oxt` (repo root, `npm run package:oxt`), packaged app = electron-builder
extraResources (`process.resourcesPath`). 7 route tests with injected
fakes; npm test 61/61. Verified live: preflight returns canInstall
on this box, and the REAL-profile install flow is now exercised
END-TO-END (2026-10-19, user consent): extension removed from the real
profile, the panel showed the failure state + "Install bridge…" button,
the click + confirm ran the real unopkg install, `unopkg list` confirmed
it, a real-profile LibreOffice relaunch + bridge start connected the
panel again. Note: the panel evaluates canInstall at CONNECT time —
after installing, click Reconnect (or relaunch) to proceed.

### Package-cache clearing (added 2026-10-21)

**LibreOffice does NOT rebuild its extension package-registry cache
(`user/uno_packages/cache/`) when `unopkg add` runs later.** The cache
holds `backenddb.xml` files for the bundle / component /
configuration PackageRegistryBackends. If the cache was built before
the extension (or from an older oxt without Sidebar.xcu/Factories.xcu),
the next LibreOffice launch reads the STALE cache and the sidebar
deck's config layers never reach the runtime — the deck button appears
in the deck bar but the deck renders EMPTY (no panel, no labels).
This is the failure the user hit on 2026-10-21 with the
`npm start → install bridge → open LibreOffice → open ACP sidebar`
flow.

Fix (in `src/bridge/install.ts`): after a successful `unopkg add`,
`installBridge` calls `clearPackageCache(profile)` which deletes
`user/uno_packages/cache/` (found via `findLoUserProfile()` —
LO_USER_PROFILE env override wins, then the per-OS profile roots).
The 409-while-soffice-runs guard makes this safe: the cache is only
deleted when LibreOffice is fully closed, so the next launch rebuilds
it from scratch and picks up Sidebar.xcu + Factories.xcu as config
overlay layers. The success message tells the user the cache was
cleared. 4 unit tests; npm test 66/66.

### unopkg retry: clear pmap between remove and add (2026-10-21)

Second live failure, same flow: the user clicked **Install bridge**,
`unopkg remove` succeeded (old extension gone) but `unopkg add`
FAILED with `VersionException "Extension has already been added"` —
leaving the profile with NO extension at all. Root cause: `unopkg
remove` cleans the backend DBs (`cache/registry/*/backenddb.xml`)
but NOT the package map (`uno_packages/uno_packages.pmap`) nor the
unpacked cache dirs (`cache/uno_packages/lu*.tmp*`). The next
`unopkg add` reads the stale pmap, sees our identifier, and refuses.

Fix: `clearPackageCache` now deletes BOTH `uno_packages/cache/`
AND `uno_packages/uno_packages.pmap`, and `installBridge` runs it
BETWEEN `unopkg remove` and `unopkg add` (not after). Verified live:
the remove→clear→add sequence installs cleanly (6 components
registered: 3 configuration-data + 2 Python UNO components + 1
bundle), and a fresh Writer launch shows the ACP Assist menu + sidebar
deck button. Test asserts the step ordering (cache clear before add)
and that the stale pmap is gone before add runs.

## Panel UI smoke test (done 2026-10-18)

First full walk of the actual chat panel (`public/`) — driven in a browser
against the standalone dev server + a live bridge, with a real vibe-acp
session. Verified: status indicator, document selector, agent settings
(vibe-acp default), streaming message render, applied-edit feedback line
("✓ Inserted after [p3] in LibreOffice") with inline undo, the undo button
round-trip (paragraph re-verified gone via the bridge), reload history
persistence, pin toggle, zero console errors. Two bugs found and fixed
(commit 7045b2a): history replay leaked the raw ```writer content block
(the persisted action is now passed to the renderer, matching live), and
a lowercase "the" in the welcome hint from the LyX rename. The Electron
shell (`npm start`) is still only typechecked — never launched.

## Panel UI bits test (done 2026-10-19)

The three controls the first smoke test did not cover, exercised live in
the browser against the dev server + a live bridge + real vibe-acp turns:

- **Attach flow**: "+" → file picker → chip renders → consumed by the next
  message (chip cleared after send) → the agent answered a question only
  answerable from the attached .md (91.7% backup-supplier score). Zero
  console errors.
- **Stop button**: BUG FOUND AND FIXED (commit 37fbade): Stop aborts the
  fetch client-side (two abort paths — awaiting response headers and
  mid-stream); both previously left a silent empty bubble with no
  feedback. Both now render "(no response)" + "Stopped before applying".
  Server-side fact: vibe-acp IGNORES the ACP session/cancel notification
  (the generation runs to completion in the background, recorded in
  history with a cancelled outcome); the client abort is what the user
  actually sees. Also: vibe-acp prepends MCP-connection noise ("The
  following MCP servers failed to connect: markitdown") to its replies —
  agent quirk, not an app bug.
- **Reconnect button**: tears down and recreates the session; the
  per-document conversation history reloads correctly. Also observed:
  reconnect is what re-evaluates the install button's preflight.
## Packaging and CI (done 2026-10-18)

- **Icons**: `scripts/generate-icon.ps1` ported from lyx-acp-assist with a
  LibreOffice-green palette matching the new `public/logo.svg` (replacing
  the LyX-logo one). Generates `build/icon.ico` + `icon-256/512.png`
  (gitignored; regenerate on Windows with
  `powershell -File scripts/generate-icon.ps1`).
- **`npm run package` verified working** (first run ever): NSIS setup,
  portable .exe, and zip all build; `acp-bridge.oxt` lands in the
  app's `resources/` via electron-builder `extraResources`. The script
  now passes `--publish never` (v26's implicit CI-detection publish
  tries to publish with no GH_TOKEN otherwise).
- **AGENT-SESSION PITFALL**: under this agent harness, packaging into a
  repo-local output dir fails (`EPERM` renaming the freshly extracted
  `win-unpacked.tmp` — something in the harness watches the repo tree
  and holds new dirs; the lock even survives minutes and
  `Restart Manager` reports no holder). Building with
  `--config.directories.output` OUTSIDE the repo (e.g. %TEMP%) works
  fine. In a normal user shell `npm run package` should just work.
- **Electron shell first launch verified** (`npm start`, 2026-10-18):
  dynamic-port server, panel served, install preflight works, soffice
  focus watcher (PowerShell) starts, clean exit. AGENT-SESSION
  PITFALL: the harness exports `ELECTRON_RUN_AS_NODE=1`, which
  electron.exe inherits and then runs main.js as plain Node
  (`SyntaxError: ... does not provide an export named 'BrowserWindow'`)
  — launch with the variable cleared. The pin/floating behavior was NOT
  visually verified (no computer-use tooling that session).
- **CI**: `.github/workflows/build.yml` ported from lyx-acp-assist —
  test (npm test + typecheck) → assets (Windows runner: icons +
  rebuilds the gitignored .oxt from extension/ via scripts/package-oxt.py) →
  per-OS electron-builder builds → draft release on v* tags, artifacts
  include the .oxt. Never pushed; untested against GitHub.
