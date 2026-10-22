/**
 * Standalone server entry (no Electron): serves the panel and the API on
 * a dynamic port (PORT env overrides). Used for development and for
 * driving the app end-to-end from scripts/tools without launching the
 * Electron shell (ported from the LibreOffice app's dev entry).
 */

import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createServer } from './server.js';
import { createNativeClipboard } from './clipboard/native-clipboard.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const publicDir = path.join(__dirname, '..', 'public');
if (!fs.existsSync(path.join(publicDir, 'index.html'))) {
  throw new Error(`public dir not found at ${publicDir}`);
}
const dataDir = path.join(os.tmpdir(), 'lyx-acp-assist-dev');
const server = createServer({
  publicDir,
  clipboard: createNativeClipboard(),
  historyDir: path.join(dataDir, 'history'),
  attachmentsDir: path.join(dataDir, 'attachments'),
  logDir: path.join(dataDir, 'logs'),
  settingsDir: dataDir,
});

const port = process.env.PORT ? Number.parseInt(process.env.PORT, 10) : 0;
const httpServer = server.listen(port, '127.0.0.1', () => {
  const address = httpServer.address();
  const actual = typeof address === 'object' && address ? address.port : port;
  console.log(`LyX ACP Assist dev server at http://127.0.0.1:${actual}`);
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    httpServer.close();
    process.exit(0);
  });
}