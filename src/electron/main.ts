import { app, BrowserWindow, clipboard, ClipboardItem, ipcMain } from 'electron';
import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { RawClipboard } from '../clipboard/lyx-clipboard.js';
import { createServer } from '../server.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let mainWindow: BrowserWindow | null = null;
let httpServer: import('node:http').Server | null = null;
/** When true (default), the window floats on top only while LyX is focused. */
let lyxFollowMode = true;
let focusWatcher: ChildProcess | null = null;

/**
 * Emulate "always-on-top only for LyX": poll the Windows foreground window
 * with one persistent PowerShell process; float when it belongs to LyX.
 * When our own window is focused, keep the current state.
 */
function startLyxFocusWatcher(): void {
  if (process.platform !== 'win32' || focusWatcher) return;
  const script = [
    'Add-Type @"',
    'using System;using System.Runtime.InteropServices;',
    'public class FG{[DllImport("user32.dll")]public static extern IntPtr GetForegroundWindow();',
    '[DllImport("user32.dll")]public static extern uint GetWindowThreadProcessId(IntPtr h,out uint pid);}',
    '"@',
    'while($true){',
    '  $h=[FG]::GetForegroundWindow(); $fgPid=[uint32]0; [FG]::GetWindowThreadProcessId($h,[ref]$fgPid)|Out-Null',
    '  $proc = Get-Process -Id $fgPid -ErrorAction SilentlyContinue',
    '  if($proc -eq $null){ Write-Output "OTHER" } else { Write-Output $proc.ProcessName }',
    '  Start-Sleep -Milliseconds 500',
    '}',
  ].join('\n');

  focusWatcher = spawn(
    'powershell',
    ['-NoProfile', '-STA', '-Command', script],
    { windowsHide: true },
  );
  let lastState: string | null = null;
  focusWatcher.stdout?.setEncoding('utf8');
  focusWatcher.stdout?.on('data', (chunk: string) => {
    for (const line of chunk.split('\n')) {
      const state = line.trim();
      if (!state) continue;
      // React only on state CHANGES; ignore our own Electron process.
      if (state === lastState || state === 'electron') continue;
      lastState = state;
      const isLyx = state === 'LyX';
      if (mainWindow) mainWindow.setAlwaysOnTop(lyxFollowMode && isLyx);
    }
  });
  focusWatcher.on('error', (e) => console.error('focus watcher failed:', e.message));
  focusWatcher.on('exit', () => {
    focusWatcher = null;
    if (mainWindow) mainWindow.setAlwaysOnTop(false);
  });
}

app.on('before-quit', () => {
  focusWatcher?.kill();
});

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
  const historyDir = path.join(app.getPath('userData'), 'history');
  const attachmentsDir = path.join(app.getPath('userData'), 'attachments');
  const server = createServer({ publicDir, clipboard: electronClipboard, historyDir, attachmentsDir });

  const port = process.env.PORT ? Number.parseInt(process.env.PORT, 10) : 0;
  await new Promise<void>((resolve) => {
    httpServer = server.listen(port, '127.0.0.1', () => resolve());
  });
  const address = httpServer?.address();
  if (typeof address !== 'object' || address === null) throw new Error('server address missing');
  const url = `http://127.0.0.1:${address.port}`;
  console.log(`LyX ACP Assist server at ${url}`);

  await app.whenReady();

  ipcMain.on('window/toggle-always-on-top', () => {
    if (mainWindow) {
      lyxFollowMode = !lyxFollowMode;
      if (!lyxFollowMode) mainWindow.setAlwaysOnTop(false);
    }
  });

  mainWindow = new BrowserWindow({
    width: 420,
    height: 680,
    // Framed window: frameless has cross-platform issues (Linux/macOS).
    alwaysOnTop: false, // managed by the LyX-follow watcher below
    title: 'LyX ACP Assist',
    webPreferences: {
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
    },
  });
  await mainWindow.loadURL(url);
  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  startLyxFocusWatcher();
}

app.on('window-all-closed', () => {
  app.quit();
});

startApp().catch((err) => {
  console.error(err);
  app.quit();
});