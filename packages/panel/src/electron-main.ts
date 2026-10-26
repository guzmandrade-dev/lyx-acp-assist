/**
 * Shared Electron main (audit Track C): both companion apps' mains were
 * ~190 lines differing only in window title, watched foreground process
 * name, the server construction, and the discovery record. The app's
 * main.ts shrinks to a createElectronMain(options) call.
 *
 * NOTE: preload.ts intentionally stays per-app (5 identical lines): it is
 * compiled per-app by tsconfig.preload.json into the dist directory the
 * packaged main.js expects — moving it would complicate the packaging
 * layout for no maintenance win.
 */

import { app, BrowserWindow, ipcMain, Menu } from 'electron';
import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { panelPublicDir } from './index.js';

export interface ElectronMainOptions {
  /** Window/taskbar title. */
  windowTitle: string;
  /** Log-line prefix (app name). */
  appName: string;
  /** Foreground process name that floats the window ('LyX' | 'soffice'). */
  watchedProcessName: string;
  /**
   * The APP's compiled-electron directory (its main.ts `__dirname`) —
   * preload.js and the window icon live there; the panel assets come
   * from this package.
   */
  appDistDir: string;
  /** Per-app asset overrides (logo.svg); passed through to createServer. */
  assetsDir?: string;
  /** Build the app's Express server (paths under userData provided). */
  createServer: (paths: {
    publicDir: string;
    assetsDir?: string;
    userDataDir: string;
    historyDir: string;
    attachmentsDir: string;
    logDir: string;
  }) => import('express').Express;
  /** Write the companion discovery record once listening. */
  writeRecord: (info: {
    url: string;
    port: number;
    token: string;
    exe: string | null;
    userDataDir: string;
  }) => Promise<void>;
  /** Optional cleanup on quit (e.g. remove the discovery record). */
  removeRecord?: () => Promise<void>;
}

export function createElectronMain(options: ElectronMainOptions): void {
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
   * Emulate "always-on-top only for the editor": poll the Windows
   * foreground window with one persistent PowerShell process; float when
   * it belongs to the watched editor process. When our own window is
   * focused, keep the current state.
   */
  function startFocusWatcher(): void {
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
        if (state === lastState || state === 'electron') continue;
        lastState = state;
        watcherLastState = state;
        applyAlwaysOnTop(followMode && state === options.watchedProcessName);
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
    options.removeRecord?.().catch(() => undefined);
  });

  async function startApp(): Promise<void> {
    const publicDir = panelPublicDir();
    if (!fs.existsSync(path.join(publicDir, 'index.html'))) {
      throw new Error(`panel public dir not found at ${publicDir}`);
    }
    const userDataDir = app.getPath('userData');
    const server = options.createServer({
      publicDir,
      assetsDir: options.assetsDir,
      userDataDir,
      historyDir: path.join(userDataDir, 'history'),
      attachmentsDir: path.join(userDataDir, 'attachments'),
      logDir: path.join(userDataDir, 'logs'),
    });

    // Dynamic port (discovery-first rule; multiple companion instances
    // are first-class): bind :0 and report the URL; PORT overrides for tests.
    const port = process.env.PORT ? Number.parseInt(process.env.PORT, 10) : 0;
    await new Promise<void>((resolve) => {
      httpServer = server.listen(port, '127.0.0.1', () => resolve());
    });
    const address = httpServer?.address();
    if (typeof address !== 'object' || address === null) throw new Error('server address missing');
    const url = `http://127.0.0.1:${address.port}`;
    console.log(`${options.appName} ACP Assist server at ${url}`);

    // Discovery record: external tools (dev drivers, the LO sidebar) read
    // the port + API bearer token from it.
    options
      .writeRecord({
        url,
        port: address.port,
        token: (server.locals.apiToken as string) ?? '',
        exe: app.isPackaged ? process.execPath : null,
        userDataDir,
      })
      .catch(() => undefined);

    await app.whenReady();

    ipcMain.on('window/toggle-always-on-top', () => {
      followMode = !followMode;
      applyAlwaysOnTop(followMode && watcherLastState === options.watchedProcessName);
    });

    // Window/taskbar icon: the 256px raster next to the app bundle. Absent in
    // unpackaged CI checkouts (build/ is gitignored), so degrade silently.
    const windowIcon = path.join(options.appDistDir, '..', '..', 'build', 'icon-256.png');
    const windowIconOpt = fs.existsSync(windowIcon) ? { icon: windowIcon } : {};

    mainWindow = new BrowserWindow({
      width: 420,
      height: 680,
      // Framed window: frameless has cross-platform issues (Linux/macOS).
      alwaysOnTop: false, // managed by the editor-follow watcher below
      ...windowIconOpt,
      title: options.windowTitle,
      webPreferences: {
        contextIsolation: true,
        preload: path.join(options.appDistDir, 'preload.js'),
      },
    });
    await mainWindow.loadURL(url);
    // Electron shows no context menu unless the app builds one. Without this,
    // right-click was dead and users could not paste into the composer.
    mainWindow.webContents.on('context-menu', (_event, params) => {
      Menu.buildFromTemplate([
        { label: 'Cut', role: 'cut', enabled: params.editFlags.canCut },
        { label: 'Copy', role: 'copy', enabled: params.editFlags.canCopy },
        { label: 'Paste', role: 'paste', enabled: params.editFlags.canPaste },
        { label: 'Select All', role: 'selectAll', enabled: params.editFlags.canSelectAll },
      ]).popup({ window: mainWindow ?? undefined });
    });
    mainWindow.on('closed', () => {
      mainWindow = null;
    });

    startFocusWatcher();
  }

  app.on('window-all-closed', () => {
    app.quit();
  });

  startApp().catch((err) => {
    console.error(err);
    app.quit();
  });
}
