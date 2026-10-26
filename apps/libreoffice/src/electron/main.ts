/**
 * Electron main (thin, Track C): everything shared lives in
 * @acp-assist/panel createElectronMain; this file only supplies the
 * LibreOffice specifics. preload.ts stays here (see the panel package
 * note).
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { app } from 'electron';
import { createElectronMain } from '@acp-assist/panel/electron';
import { writeCompanionRecord, removeCompanionRecord } from '../bridge/client.js';
import { createServer } from '../server.js';
import { PANEL_CONFIG } from '../panel-config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

createElectronMain({
  windowTitle: 'LibreOffice ACP Assist',
  appName: 'LibreOffice',
  watchedProcessName: 'soffice', // soffice.bin reports its ProcessName as "soffice"
  appDistDir: __dirname,
  // The app's own logo.svg (all other panel assets are shared).
  assetsDir: path.join(__dirname, '..', '..', 'public'),
  createServer: (paths) =>
    createServer({
      publicDir: paths.publicDir,
      assetsDir: paths.assetsDir,
      panelConfig: PANEL_CONFIG,
      historyDir: paths.historyDir,
      attachmentsDir: paths.attachmentsDir,
      logDir: paths.logDir,
      settingsDir: paths.userDataDir,
      // Packaged app: the oxt rides in extraResources; dev: repo root.
      oxtPath: oxtPath(),
    }),
  // Discovery record for the in-LibreOffice status panel. Packaged:
  // relaunch the app exe; dev: null → the panel opens the URL in a
  // browser instead.
  writeRecord: ({ url, port, token, exe }) =>
    writeCompanionRecord({
      pid: process.pid,
      port,
      url,
      exe,
      token,
    }),
  removeRecord: () => removeCompanionRecord(),
});

function oxtPath(): string {
  // dist/electron -> apps/libreoffice/acp-bridge.oxt (dev) or the
  // packaged extraResources dir.
  return app.isPackaged
    ? path.join(process.resourcesPath, 'acp-bridge.oxt')
    : path.join(__dirname, '..', '..', 'acp-bridge.oxt');
}
