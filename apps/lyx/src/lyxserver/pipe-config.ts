/**
 * LyX environment discovery: where is the server pipe, and what else can the
 * app learn from LyX's configuration without the pipe?
 *
 * The LyXServer pipe path is USER-CONFIGURABLE (LyX: Preferences -> Paths ->
 * LyXServer pipe). On Windows LyX keeps its configuration in a versioned
 * user directory (%APPDATA%\LyX<version>\preferences, key `\serverpipe`);
 * the stored form uses forward slashes ("//./pipe/lyxpipe"), which must be
 * normalized to \\.\pipe\lyxpipe for the Win32 namespace.
 *
 * The same user directory holds the `session` file with recently opened
 * documents (full paths), used by the write-only fallback (see client.ts)
 * to resolve the active document without pipe replies.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

export interface LyxEnvironment {
  /** Resolved pipe base (no .in/.out suffix), e.g. `\\.\pipe\lyxpipe`. */
  pipeBase: string;
  /** LyX user directory (e.g. `%APPDATA%\LyX2.5`), when found. */
  userDir: string | null;
}

/** Match `LyX2.5`, `LyX2.4.1`, ... in an app-data directory listing. */
const WINDIR_RE = /^LyX(\d+(?:\.\d+)*)$/i;

/** `\serverpipe "..."` from a LyX preferences file (multiline). */
const SERVERPIPE_RE = /^\\serverpipe\s+"(.+)"\s*$/m;

export function parseServerPipe(content: string): string | null {
  return SERVERPIPE_RE.exec(content)?.[1] ?? null;
}

/**
 * Document paths from LyX's `session` file: last-opened (ordered by their
 * slot number) first, then the recent-files list. Written by LyX at exit,
 * so entries can lag the live session; callers treat them as candidates.
 */
export function parseSessionFilePaths(content: string): string[] {
  const lastOpened: Array<{ n: number; p: string }> = [];
  const recent: string[] = [];
  let section = '';
  for (const raw of content.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const header = /^\[(.+)\]$/.exec(line);
    if (header) {
      section = header[1]?.toLowerCase() ?? '';
      continue;
    }
    if (section === 'last opened files') {
      const m = /^(\d+)\s*,\s*(.+)$/.exec(line);
      const slot = m?.[1];
      const p = m?.[2];
      if (slot !== undefined && p !== undefined) {
        lastOpened.push({ n: Number.parseInt(slot, 10), p: p.trim() });
      }
    } else if (section === 'recent files') {
      recent.push(line);
    }
  }
  return [...lastOpened.sort((a, b) => a.n - b.n).map((e) => e.p), ...recent];
}

export interface ParsedWindowTitle {
  fileName: string;
  /** Directory hint shown in the title, e.g. `~\Documents`. */
  dirHint: string | null;
}

/**
 * Parse a LyX main-window title. Live format (Windows, LyX 2.5):
 *   "sample.lyx (~\Documents) - LyX"
 *   "doc.lyx - LyX"            (no directory hint)
 *   "LyX"                      (no document)
 */
export function parseWindowTitle(title: string): ParsedWindowTitle | null {
  const m = /^(.+?)\s+-\s+LyX(?:\s*[\d.]+)?$/i.exec(title.trim());
  const rest = m?.[1]?.trim();
  if (rest === undefined) return null;
  // Qt window-modification marker: GuiView sets the title to
  // "<display name>[*] - LyX" (GuiView.cpp updateWindowTitle) and Qt
  // substitutes "[*]" with "*" while the buffer is dirty ("doc.lyx
  // (~\Docs)* - LyX") and strips it when clean. Without this, a dirty
  // buffer (one paste into an unsaved document) makes the write-only
  // filename fallback unresolvable and breaks multi-action runs.
  const clean = rest.replace(/\s*(?:\[\*\]|\*)$/, '');
  const paren = /^(.+?)\s*\((.+)\)$/.exec(clean);
  const fileName = paren?.[1]?.trim();
  const dirHint = paren?.[2]?.trim();
  if (fileName !== undefined && dirHint !== undefined) return { fileName, dirHint };
  return { fileName: clean, dirHint: null };
}

/**
 * Resolve the LyX pipe base and user directory:
 *   1. LyX's own preferences (`\serverpipe`), newest version first
 *   2. platform default (`\\.\pipe\lyxpipe` on Windows, `~/.lyxpipe` else)
 * The LYX_PIPE env override is applied by the caller (client default).
 */
export function discoverLyxEnvironment(options?: {
  appDataDir?: string;
  homeDir?: string;
}): LyxEnvironment {
  const home = options?.homeDir ?? process.env.HOME ?? process.env.USERPROFILE ?? '~';
  const defaultBase = process.platform === 'win32' ? '\\\\.\\pipe\\lyxpipe' : `${home}/.lyxpipe`;

  // Windows layout: %APPDATA%\LyX<version>\preferences.
  const appData = options?.appDataDir ?? process.env.APPDATA;
  if (appData && fs.existsSync(appData)) {
    const dirs = fs
      .readdirSync(appData)
      .map((name) => ({ name, m: WINDIR_RE.exec(name) }))
      .filter((e): e is { name: string; m: RegExpExecArray } => e.m !== null)
      .sort((a, b) => compareVersionsDesc(a.m[1] ?? '', b.m[1] ?? ''));
    for (const dir of dirs) {
      const userDir = path.join(appData, dir.name);
      const serverPipe = readPreferencesServerPipe(userDir);
      if (serverPipe !== null) {
        return {
          pipeBase: process.platform === 'win32' ? serverPipe.replace(/\//g, '\\') : serverPipe,
          userDir,
        };
      }
    }
    const newest = dirs[0]?.name;
    if (newest) return { pipeBase: defaultBase, userDir: path.join(appData, newest) };
  }

  // Unix layout: ~/.lyx/preferences.
  const unixUserDir = path.join(home, '.lyx');
  const unixPipe = readPreferencesServerPipe(unixUserDir);
  if (unixPipe !== null) return { pipeBase: unixPipe, userDir: unixUserDir };

  return { pipeBase: defaultBase, userDir: null };
}

function readPreferencesServerPipe(userDir: string): string | null {
  try {
    return parseServerPipe(fs.readFileSync(path.join(userDir, 'preferences'), 'utf8'));
  } catch {
    return null;
  }
}

function compareVersionsDesc(a: string, b: string): number {
  const pa = a.split('.').map((n) => Number.parseInt(n, 10));
  const pb = b.split('.').map((n) => Number.parseInt(n, 10));
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pb[i] ?? 0) - (pa[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/**
 * Main-window title of the running LyX process (Windows; the write-only
 * fallback's substitute for `server-get-filename`). Null when LyX is not
 * running or has no titled window (e.g. only a splash document).
 */
export function readLyxWindowTitle(): Promise<string | null> {
  if (process.platform !== 'win32') return Promise.resolve(null);
  return new Promise((resolve) => {
    const child = spawn(
      'powershell',
      [
        '-NoProfile',
        '-Command',
        '(Get-Process -Name LyX -ErrorAction SilentlyContinue | ' +
          'Where-Object { $_.MainWindowTitle } | Select-Object -First 1).MainWindowTitle',
      ],
      { windowsHide: true },
    );
    let stdout = '';
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (d: string) => (stdout += d));
    child.on('error', () => resolve(null));
    child.on('close', () => resolve(stdout.trim() || null));
    child.stdin?.end();
  });
}