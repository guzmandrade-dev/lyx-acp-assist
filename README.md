# ACP Assist

Copilot-style LLM assistants for document editors. Each app is a floating
companion panel that reads your document, chats, and writes **directly into
the live editor document**. All reasoning is delegated to an external agent
over the [Agent Client Protocol](https://agentclientprotocol.com/) (ACP);
there is no LLM and no API key inside these apps.

| App | Description |
|---|---|
| **[LyX ACP Assist](apps/lyx)** | Assistant for [LyX](https://www.lyx.org/) — writes through the LyXServer named pipe and the `application/x-lyx` clipboard format, so LyX itself performs every insertion |
| **[LibreOffice ACP Assist](apps/libreoffice)** | Assistant for [LibreOffice](https://www.libreoffice.org/) — Writer, Calc, and Impress via a small in-process UNO bridge (`.oxt`) with per-module adapters |

Both apps share one architecture: the editor stays the **single writer of
truth**, the agent decides intent via a small vocabulary of action tags that
the app executes mechanically, and every edit is one undo step. The panel is
a quiet chat surface that floats beside the document.

## Repository layout

```
packages/core/    @acp-assist/core: shared ACP client, types, attachment
                  conversion, chat-history persistence, restart replay
apps/lyx/         LyX companion (Electron + read-only .lyx parser + pipe client)
apps/libreoffice/  LibreOffice companion (Electron + UNO bridge + module adapters)
```

npm workspaces: install once at the root (`npm install`), then develop,
test, and package from either app's directory. Each app stays
self-contained in packaging; `@acp-assist/core` rides along as a regular
workspace dependency. See each app's README for requirements and usage.

## Development

Node.js 22+. From either app's directory:

```bash
npm install
npm test         # vitest
npm run typecheck
npm start        # builds TypeScript and launches the Electron companion
npm run package  # installers for Windows, macOS, and Linux
```

## History

This repository absorbed the full histories of the former standalone
repositories `lyx-acp-assist` and `libreoffice-acp-assist`. Earlier commits
were rewritten so their file paths match this layout; commit messages,
authorship, and ordering are preserved. SHAs differ from the old
repositories.