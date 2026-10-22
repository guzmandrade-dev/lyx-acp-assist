import { app, BrowserWindow, ipcMain } from 'electron';
import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createServer } from '../server.js';
import { writeCompanionRecord, removeCompanionRecord } from '../bridge/client.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let mainWindow: BrowserWindow | null = null;
let httpServer: import('node:http').Server | null = null;
/** When false (default), the window never floats on top; the pin toggle enables it. */
let followMode = false;
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
 * Emulate "always-on-top only for LibreOffice": poll the Windows
 * foreground window with one persistent PowerShell process; float when it
 * belongs to LibreOffice (soffice.bin). When our own window is focused,
 * keep the current state.
 */
function startSofficeFocusWatcher(): void {
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

  focusWatcher = spawn('powershell', ['-NoProfile', '-STA', '-Command', script], { windowsHide: true });
  let lastState: string | null = null;
  focusWatcher.stdout?.setEncoding('utf8');
  focusWatcher.stdout?.on('data', (chunk: string) => {
    for (const line of chunk.split('\n')) {
      const state = line.trim();
      if (!state) continue;
      // React only on state CHANGES; ignore our own Electron process.
      // soffice.bin reports its ProcessName as "soffice".
      if (state === lastState || state === 'electron') continue;
      lastState = state;
      watcherLastState = state;
      applyAlwaysOnTop(followMode && state === 'soffice');
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
  removeCompanionRecord().catch(() => undefined);
});

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
    historyDir,
    attachmentsDir,
    logDir,
    settingsDir: app.getPath('userData'),
    // Packaged app: the oxt rides in extraResources; dev: repo root.
    oxtPath: app.isPackaged
      ? path.join(process.resourcesPath, 'acp-bridge.oxt')
      : path.join(__dirname, '..', '..', 'acp-bridge.oxt'),
  });

  // Dynamic port (discovery-first rule; multiple companion instances are
  // first-class): bind :0 and report the URL; PORT overrides for tests.
  const port = process.env.PORT ? Number.parseInt(process.env.PORT, 10) : 0;
  await new Promise<void>((resolve) => {
    httpServer = server.listen(port, '127.0.0.1', () => resolve());
  });
  const address = httpServer?.address();
  if (typeof address !== 'object' || address === null) throw new Error('server address missing');
  const url = `http://127.0.0.1:${address.port}`;
  console.log(`LibreOffice ACP Assist server at ${url}`);

  // Discovery record for the in-LibreOffice status panel. Packaged:
  // relaunch the app exe; dev: null → the panel opens the URL in a
  // browser instead.
  writeCompanionRecord({
    pid: process.pid,
    port: address.port,
    url,
    exe: app.isPackaged ? process.execPath : null,
  }).catch(() => undefined);

  await app.whenReady();

  ipcMain.on('window/toggle-always-on-top', () => {
    followMode = !followMode;
    applyAlwaysOnTop(followMode && watcherLastState === 'soffice');
  });

  // Window/taskbar icon: the 256px raster next to the app bundle. Absent in
  // unpackaged CI checkouts (build/ is gitignored), so degrade silently.
  const windowIcon = path.join(__dirname, '..', '..', 'build', 'icon-256.png');
  const windowIconOpt = fs.existsSync(windowIcon) ? { icon: windowIcon } : {};

  mainWindow = new BrowserWindow({
    width: 420,
    height: 680,
    // Framed window: frameless has cross-platform issues (Linux/macOS).
    alwaysOnTop: false, // managed by the soffice-follow watcher below
    ...windowIconOpt,
    title: 'LibreOffice ACP Assist',
    webPreferences: {
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
    },
  });
  await mainWindow.loadURL(url);
  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  startSofficeFocusWatcher();
}

app.on('window-all-closed', () => {
  app.quit();
});

startApp().catch((err) => {
  console.error(err);
  app.quit();
});