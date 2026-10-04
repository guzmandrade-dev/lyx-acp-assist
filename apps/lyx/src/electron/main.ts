import { app, BrowserWindow, clipboard, ClipboardItem } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { RawClipboard } from '../clipboard/lyx-clipboard.js';
import { createServer } from '../server.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let mainWindow: BrowserWindow | null = null;
let httpServer: import('node:http').Server | null = null;

/**
 * Chromium writes custom MIME types using the Web Custom Format spec
 * (magic header + name), which LyX cannot parse. Writing the RAW OS
 * format requires Electron's escape-hatch MIME:
 *   electron application/osclipboard;format="<format>"
 * Verified against LyX: raw writes are parsed by LyX's clipboard monitor;
 * WCF-wrapped writes are silently ignored (see AGENTS.md).
 */
function osFormatMime(format: string): string {
  return `electron application/osclipboard;format="${format}"`;
}

const electronClipboard: RawClipboard = {
  async hasFormat(format) {
    // Electron hides custom formats from clipboard.has(); attempt a read.
    return (await this.readFormat(format)) !== null;
  },
  async readFormat(format) {
    const items = await clipboard.read();
    for (const mime of [format, osFormatMime(format)]) {
      for (const item of items) {
        if (item.types.includes(mime)) {
          const value = await item.getType(mime);
          if (value instanceof Blob) {
            return Buffer.from(await value.arrayBuffer());
          }
          return null;
        }
      }
    }
    return null;
  },
  async write(formats) {
    const entries: Record<string, string | Blob> = {};
    for (const [type, data] of Object.entries(formats)) {
      if (type === 'text/plain') {
        entries[type] = typeof data === 'string' ? data : data.toString('utf8');
      } else {
        // Custom format: write the raw OS format via the escape hatch.
        const bytes = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
        entries[osFormatMime(type)] = new Blob([new Uint8Array(bytes)]);
      }
    }
    await clipboard.write([new ClipboardItem(entries)]);
  },
  async readText() {
    return clipboard.readText();
  },
};

async function startApp(): Promise<void> {
  const publicDir = path.join(__dirname, '..', '..', 'public');
  if (!fs.existsSync(path.join(publicDir, 'index.html'))) {
    throw new Error(`public dir not found at ${publicDir} (run from built output with public/)`);
  }
  const server = createServer({ publicDir, clipboard: electronClipboard });

  const port = process.env.PORT ? Number.parseInt(process.env.PORT, 10) : 0;
  await new Promise<void>((resolve) => {
    httpServer = server.listen(port, '127.0.0.1', () => resolve());
  });
  const address = httpServer?.address();
  if (typeof address !== 'object' || address === null) throw new Error('server address missing');
  const url = `http://127.0.0.1:${address.port}`;
  console.log(`LyX ACP Assist server at ${url}`);

  await app.whenReady();
  mainWindow = new BrowserWindow({
    width: 480,
    height: 760,
    title: 'LyX ACP Assist',
    autoHideMenuBar: true,
  });
  await mainWindow.loadURL(url);
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.on('window-all-closed', () => {
  app.quit();
});

startApp().catch((err) => {
  console.error(err);
  app.quit();
});