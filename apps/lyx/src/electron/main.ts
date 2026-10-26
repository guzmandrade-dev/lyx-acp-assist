/**
 * Electron main (thin, Track C): everything shared lives in
 * @acp-assist/panel createElectronMain; this file only supplies the LyX
 * specifics. preload.ts stays here (see the panel package note).
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createElectronMain } from '@acp-assist/panel/electron';
import { writeCompanionRecord } from '@acp-assist/core';
import { createServer } from '../server.js';
import { createNativeClipboard } from '../clipboard/native-clipboard.js';
import { PANEL_CONFIG } from '../panel-config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

createElectronMain({
  windowTitle: 'LyX ACP Assist',
  appName: 'LyX',
  watchedProcessName: 'LyX',
  appDistDir: __dirname,
  // The app's own logo.svg (all other panel assets are shared).
  assetsDir: path.join(__dirname, '..', '..', 'public'),
  createServer: (paths) =>
    createServer({
      publicDir: paths.publicDir,
      assetsDir: paths.assetsDir,
      clipboard: createNativeClipboard(),
      panelConfig: PANEL_CONFIG,
      historyDir: paths.historyDir,
      attachmentsDir: paths.attachmentsDir,
      logDir: paths.logDir,
      settingsDir: paths.userDataDir,
    }),
  // Companion record (audit B1 handshake): dev tools read the port +
  // API bearer token from <userData>/companion.json. The LyX app has no
  // in-editor consumer yet (unlike LO's sidebar); the record exists so
  // scripts can auth.
  writeRecord: ({ url, port, token, exe, userDataDir }) =>
    writeCompanionRecord(path.join(userDataDir, 'companion.json'), {
      pid: process.pid,
      port,
      url,
      exe,
      token,
    }),
});
