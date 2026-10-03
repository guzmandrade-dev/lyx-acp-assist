LyX LLM Integration Ideas

To integrate LLM assistance into LyX using an ACP (or MCP) client, you have a few architectural paths since LyX does not have a native, built-in plugin system for modern AI APIs. Because LyX acts as a graphical front end that generates LaTeX behind the scenes, the most effective approach is to interact with the underlying document directly or utilize LyX's external communication pipes.

Here are the primary ways you can set this up:

* The LyXServer Pipe Approach: LyX has a built-in feature called LyXServer that allows external programs to communicate with it via named pipes. You can write a lightweight local client (e.g., in Python) that listens for selected text or commands from LyX, sends the payload to your LLM (via your ACP/MCP client), and then streams the response back into the document.

* External Scripting via Custom Keybindings: You can map a keyboard shortcut in LyX to trigger an external script. This script can grab the current selection (or the temporary .tex file LyX generates), pass it to your LLM client, and return the modified text to your clipboard or directly back into the editor.

* File-Level MCP Integration: If your ACP/MCP client supports file-watching, you can run it directly against the directory where your .lyx or exported .tex files are saved. The LLM can read the project context and propose diffs, which you can then pull into LyX manually or via an automated reload.

## Decided Architecture (2026-10-03)

Pure LyXServer companion app - Copilot-for-Word-style assist, but LyX remains the editor:

1. Electron companion app (reuse Visual Research Pal's shell: Express + ACP agent over
   stdio, agent-agnostic, chat sidebar; no LLM in the app).
2. Read path: trigger `file-save` via pipe, then parse the `.lyx` file from disk with a
   pure-TypeScript read-only parser (lq used only as reference/fixtures, never a runtime
   dependency). Parsing is for agent context/addressing only.
3. Write path: LyXServer named pipe (`server-insert`, selection replacement via
   cut+insert/clipboard). LyX is the single writer of truth - the agent never edits the
   file behind LyX's back, so the document can never be corrupted by the parser.
4. Selection context: `copy` LFUN + system clipboard read.

Key asymmetry: lq's hard problem is lossless *writing*; ours is only *reading*.
A misparse degrades suggestion quality, never document integrity.

## Spike Plan (validate before building)

- Spike 1: DONE - named-pipe round-trip from Node works (server-get-filename,
  server-get-layout, buffer-write, self-insert). See AGENTS.md for protocol
  details and Windows quirks.
- Spike 2: clipboard selection round-trip fidelity (plain text vs. LaTeX formats,
  math/inset handling).
- Spike 3: minimal `.lyx` TS parser against lq's fixture files.

Working Directly with the .lyx Format

The key to your idea is bypassing LaTeX entirely. When you type in LyX, it saves data in its own custom markup language. Because this is highly structured, an LLM can easily be trained or prompted to output this exact syntax.

Existing Tools: lq (LyX Query)

There is already an open-source project called lq that proves this concept works. It is a CLI tool that parses .lyx files into a syntax tree, allows you to mutate them (insert, delete, or change text), and serializes them back perfectly without breaking the file. It operates entirely independently of LaTeX.

How to Build the "Sidebar" Experience

Since LyX is built on the Qt framework and doesn't have an extension store like VS Code or Word, a sidebar inside the app itself is unlikely without forking the source code. However, you can achieve the exact same workflow with a Companion App:

1. The Interface: Build a small, floating desktop window that sits next to LyX.

2. The Connection: Use the LyXServer named pipe. Your companion app can listen to what you are doing in LyX.

3. The Interaction: When you highlight text in LyX and click "Rewrite" in your sidebar, the sidebar asks the LLM for a revision (formatted in .lyx markup).

4. The Insertion: The sidebar sends a command back through the LyXServer to replace the highlighted text with the new LLM-generated .lyx markup.

The Syntax Tree Approach & LyXServer Safety

* Why Raw Text Editing Fails: Editing a .lyx file directly as raw text is risky because it can corrupt the document's preamble, template settings, and cross-references.

* The Syntax Tree Solution: A robust integration requires a parser that separates "content" from "metadata" (like an Abstract Syntax Tree). The LLM should only ever interact with the specific node or paragraph the user is editing.

* LyXServer for Safe Injection: Instead of writing directly to the file, the LLM can send commands via the LyXServer (e.g., server-set-text). This allows LyX itself to handle the typing, ensuring all internal formatting and references remain perfectly intact.
