/**
 * Shared panel assets + config (audit Track C). The two companion apps'
 * panels were ~85% identical; the shared `public/` here is served by
 * express.static exactly like the per-app copies were, parameterized by
 * a small config injected same-origin into index.html together with the
 * API bearer token — no bundler, no extra fetch, synchronous boot.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type express from 'express';

/**
 * Everything app-specific about the panel. The shared app.js reads it
 * from `window.__ACP_PANEL_CONFIG__` at boot.
 */
export interface PanelConfig {
  /** User-facing editor name ('LyX' | 'LibreOffice'). */
  appName: string;
  /** Empty-state / window title. */
  appTitle: string;
  /** Fenced content-block language(s) the agent writes ('lyx' or
   * '(?:writer|calc|impress)'). */
  fenceRe: string;
  /** /api/status field reporting the editor connection. */
  statusKey: string;
  /** Status line text when the editor is unreachable. */
  statusMissing: string;
  /** Cursor context word: 'layout' (LyX) | 'style' (LibreOffice). */
  cursorTerm: string;
  /** LyX-only: save-consent modal + VCS warning badge. */
  hasSaveConsent: boolean;
  /** LO-only: one-click bridge installer. */
  hasInstallFlow: boolean;
  /** Refresh the selection on composer interaction (LO: yes; LyX: NO —
   * the selection read clobbers the user's clipboard). */
  composerRefreshSelection: boolean;
  /**
   * The "talking to the editor" busy label shown while requests that
   * dispatch into the editor are in flight (e.g. 'talking to LyX…').
   */
  busyText: string;
  /**
   * The server pushes refresh frames (the bridge's /events feed) over a
   * per-session SSE channel; the panel refreshes on them INSTEAD of the
   * composer-typing/focus heuristics. LO: true. LyX: false (no push
   * source — the pipe is polled; the heuristics stay).
   */
  eventPush: boolean;
  /** CSS theme class on <html> (e.g. 'theme-lyx'); null = default. */
  theme: string | null;
}

/** The panel package's public/ directory (shared assets). */
export function panelPublicDir(): string {
  // dist/index.js -> ../public
  return path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
}

/**
 * The boot script served at /panel-boot.js: assigns the token + config
 * and applies the theme class. It is an EXTERNAL same-origin script on
 * purpose — the panel's tight CSP (`default-src 'self'`, no
 * 'unsafe-inline') blocks inline scripts, and an injected inline
 * <script> silently never ran (found by the Track C live browser
 * check). A cross-origin page still cannot read this response.
 */
export function createPanelBootScript(options: {
  token: string;
  config: PanelConfig;
}): express.RequestHandler {
  const theme = options.config.theme
    ? `document.documentElement.classList.add(${JSON.stringify(options.config.theme)});`
    : '';
  const js =
    `window.__ACP_TOKEN__ = ${JSON.stringify(options.token)};` +
    `window.__ACP_PANEL_CONFIG__ = ${JSON.stringify(options.config)};${theme}`;
  return (_req, res) => {
    res.type('application/javascript').send(js);
  };
}

/**
 * Serve the panel's index.html with the boot script reference injected
 * (same-origin; see createPanelBootScript). Read once, cached; a read
 * failure serves a loud 500.
 */
export function createPanelIndexHandler(
  publicDir: string,
  options: { token: string; config: PanelConfig },
): express.RequestHandler {
  let html: Promise<string> | null = null;
  const load = () => {
    html ??= fs
      .readFile(path.join(publicDir, 'index.html'), 'utf8')
      .then((raw) =>
        raw.replace(
          '</head>',
          `<script src="/panel-boot.js"></script>\n</head>`,
        ),
      );
    return html;
  };
  return async (_req, res) => {
    try {
      res.type('html').send(await load());
    } catch {
      res.status(500).send('panel index.html not found');
    }
  };
}
export { createStandaloneServer, type StandaloneServerOptions } from './standalone.js';
