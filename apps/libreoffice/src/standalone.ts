/**
 * Standalone server entry (no Electron): serves the SHARED panel and the
 * API on a dynamic port (PORT env overrides). Used for development and
 * for driving the app end-to-end from scripts/tools.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from './server.js';
import { createStandaloneServer } from '@acp-assist/panel';
import { writeCompanionRecord, removeCompanionRecord } from './bridge/client.js';
import { PANEL_CONFIG } from './panel-config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

createStandaloneServer({
  appName: 'LibreOffice',
  dataDirName: 'lo-acp-assist-dev',
  // The app's own logo.svg (all other panel assets are shared).
  assetsDir: path.join(__dirname, '..', 'public'),
  createServer: (paths) =>
    createServer({
      publicDir: paths.publicDir,
      assetsDir: paths.assetsDir,
      panelConfig: PANEL_CONFIG,
      historyDir: paths.historyDir,
      attachmentsDir: paths.attachmentsDir,
      logDir: paths.logDir,
      settingsDir: paths.settingsDir,
      // Dev run: the packaged extension built from extension/ at the repo root.
      oxtPath: path.join(__dirname, '..', 'acp-bridge.oxt'),
    }),
  // Discovery record for the in-LibreOffice status panel (dev mode: no
  // packaged exe, so "open companion" resolves to this URL in a browser).
  writeRecord: ({ url, port, token }) =>
    writeCompanionRecord({
      pid: process.pid,
      port,
      url,
      exe: null,
      token,
    }),
  removeRecord: () => removeCompanionRecord(),
});
