import { app, BrowserWindow, ipcMain } from 'electron';
import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createNativeClipboard } from '../clipboard/native-clipboard.js';
import { createServer } from '../server.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let mainWindow: BrowserWindow | null = null;
let httpServer: import('node:http').Server | null = null;
/** When false (default), the window never floats on top; the pin toggle enables it. */
let lyxFollowMode = false;
let focusWatcher: ChildProcess | null = null;
/** Last foreground process name seen by the watcher. */
let watcherLastState: string | null = null;
/** Last always-on-top value actually applied (avoid redundant Win32 calls). */
let lastAppliedTop: boolean | null = null;

function applyAlwaysOnTop(top: boolean): void {
  if (top === lastAppliedTop) return;
  lastAppliedTop = top;
  mainWindow?.setAlwaysOnTop(top);
}

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
      watcherLastState = state;
      applyAlwaysOnTop(lyxFollowMode && state === 'LyX');
    }
  });
  focusWatcher.on('error', (e) => console.error('focus watcher failed:', e.message));
  focusWatcher.on('exit', () => {
    focusWatcher = null;
    lastAppliedTop = null;
    mainWindow?.setAlwaysOnTop(false);
  });
}

app.on('before-quit', () => {
  focusWatcher?.kill();
});

/**
 * Clipboard strategy (live-verified 2026-10-04): Electron's W3C clipboard
 * API cannot reliably write the RAW `application/x-lyx` OS format that LyX
 * parses — Chromium wraps custom MIME types in the Web Custom Format spec,
 * and even the `osclipboard` escape-hatch writes are sometimes invisible to
 * native apps (read-back goes through the same wrapper, so verification is
 * self-consistent while LyX still falls back to plain text and inserts
 * LITERAL markup). The native adapter bypasses Electron entirely:
 * .NET/WinForms on Windows, wl-copy/xclip on Linux, NSPasteboard on macOS.
 */
async function startApp(): Promise<void> {
  const publicDir = path.join(__dirname, '..', '..', 'public');
  if (!fs.existsSync(path.join(publicDir, 'index.html'))) {
    throw new Error(`public dir not found at ${publicDir} (run from built output with public/)`);
  }
  const historyDir = path.join(app.getPath('userData'), 'history');
  const attachmentsDir = path.join(app.getPath('userData'), 'attachments');
  const logDir = path.join(app.getPath('userData'), 'logs');
  const server = createServer({
    publicDir,
    clipboard: createNativeClipboard(),
    historyDir,
    attachmentsDir,
    logDir,
    settingsDir: app.getPath('userData'),
  });

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
    lyxFollowMode = !lyxFollowMode;
    applyAlwaysOnTop(lyxFollowMode && watcherLastState === 'LyX');
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
