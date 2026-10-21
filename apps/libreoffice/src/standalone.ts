/**
 * Standalone server entry (no Electron): serves the panel and the API on
 * a dynamic port (PORT env overrides). Used for development and for
 * driving the app end-to-end from scripts/tools.
 */

import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createServer } from './server.js';
import { writeCompanionRecord, removeCompanionRecord } from './bridge/client.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const publicDir = path.join(__dirname, '..', 'public');
if (!fs.existsSync(path.join(publicDir, 'index.html'))) {
  throw new Error(`public dir not found at ${publicDir}`);
}
const dataDir = path.join(os.tmpdir(), 'lo-acp-assist-dev');
const server = createServer({
  publicDir,
  historyDir: path.join(dataDir, 'history'),
  attachmentsDir: path.join(dataDir, 'attachments'),
  logDir: path.join(dataDir, 'logs'),
  settingsDir: dataDir,
  // Dev run: the packaged extension from the repo (spike/).
  oxtPath: path.join(__dirname, '..', 'spike', 'acp-bridge-spike.oxt'),
});

const port = process.env.PORT ? Number.parseInt(process.env.PORT, 10) : 0;
const httpServer = server.listen(port, '127.0.0.1', () => {
  const address = httpServer.address();
  const actual = typeof address === 'object' && address ? address.port : port;
  console.log(`LibreOffice ACP Assist dev server at http://127.0.0.1:${actual}`);
  // Discovery record for the in-LibreOffice status panel (dev mode: no
  // packaged exe, so "open companion" resolves to this URL in a browser).
  writeCompanionRecord({
    pid: process.pid,
    port: actual,
    url: `http://127.0.0.1:${actual}`,
    exe: null,
  }).catch(() => undefined);
});

/** Best-effort record removal on Ctrl+C / SIGTERM. */
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    httpServer.close();
    removeCompanionRecord().finally(() => process.exit(0));
  });
}