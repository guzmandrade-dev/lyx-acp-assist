/**
 * Standalone server entry (no Electron): serves the SHARED panel and the
 * API on a dynamic port (PORT env overrides). Used for development and
 * for driving the app end-to-end from scripts/tools.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from './server.js';
import { createNativeClipboard } from './clipboard/native-clipboard.js';
import { createStandaloneServer } from '@acp-assist/panel';
import { writeCompanionRecord } from '@acp-assist/core';
import { PANEL_CONFIG } from './panel-config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

createStandaloneServer({
  appName: 'LyX',
  dataDirName: 'lyx-acp-assist-dev',
  // The app's own logo.svg (all other panel assets are shared).
  assetsDir: path.join(__dirname, '..', 'public'),
  createServer: (paths) =>
    createServer({
      publicDir: paths.publicDir,
      assetsDir: paths.assetsDir,
      clipboard: createNativeClipboard(),
      panelConfig: PANEL_CONFIG,
      historyDir: paths.historyDir,
      attachmentsDir: paths.attachmentsDir,
      logDir: paths.logDir,
      settingsDir: paths.settingsDir,
    }),
  // Companion record (audit B1 handshake): dev tools (live_drive.mjs)
  // read the port + API bearer token from <dev dataDir>/companion.json.
  writeRecord: ({ url, port, token, dataDir }) =>
    writeCompanionRecord(path.join(dataDir, 'companion.json'), {
      pid: process.pid,
      port,
      url,
      exe: null,
      token,
    }),
});
