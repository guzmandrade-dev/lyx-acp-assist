/**
 * One-click install of the bridge .oxt into the user's LibreOffice
 * (AGENTS.md rule 6: `unopkg add` fails if the extension is already
 * installed, so remove first — a failed remove of a not-yet-installed
 * extension is fine). Runs unopkg against the user's REAL profile: the
 * route only calls this after the user clicked a confirm dialog.
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export const BRIDGE_EXT_ID = 'org.libreofficeacp.bridge';

export interface InstallStep {
  command: string;
  ok: boolean;
  output: string;
}

export interface InstallResult {
  ok: boolean;
  steps: InstallStep[];
  message: string;
}

/** Locate unopkg.exe (LO_UNOPKG env wins, then the standard install dirs). */
export function findUnopkg(): string | null {
  const candidates: string[] = [];
  if (process.env.LO_UNOPKG) candidates.push(process.env.LO_UNOPKG);
  if (process.platform === 'win32') {
    const root = process.env.PROGRAMFILES ?? 'C:\\Program Files';
    candidates.push(
      path.join(root, 'LibreOffice', 'program', 'unopkg.exe'),
      'C:\\Program Files (x86)\\LibreOffice\\program\\unopkg.exe',
    );
  } else {
    candidates.push('/usr/bin/unopkg', '/usr/local/bin/unopkg',
      '/Applications/LibreOffice.app/Contents/MacOS/unopkg');
  }
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch {
      /* unreadable candidate — try the next */
    }
  }
  return null;
}

/** Best-effort check for a running LibreOffice (unopkg wants it closed). */
export async function sofficeRunning(): Promise<boolean> {
  if (process.platform === 'win32') {
    const out = await run(['tasklist', '/FI', 'IMAGENAME eq soffice.bin', '/FO', 'CSV', '/NH'], 15_000);
    return /soffice\.bin/i.test(out.output);
  }
  try {
    await run(['pgrep', '-x', 'soffice.bin'], 15_000);
    return true;
  } catch {
    return false;
  }
}

/**
 * Locate the LibreOffice user profile directory (the `user/` dir inside
 * the versioned profile root). Returns null when no profile exists yet.
 * LO_USER_PROFILE env override wins (tests, custom installs).
 */
export function findLoUserProfile(): string | null {
  if (process.env.LO_USER_PROFILE) return process.env.LO_USER_PROFILE;
  const home = process.env.HOME ?? process.env.USERPROFILE ?? '';
  const roots: string[] = [];
  if (process.platform === 'win32') {
    roots.push(path.join(process.env.APPDATA ?? path.join(home, 'AppData', 'Roaming'), 'LibreOffice'));
  } else if (process.platform === 'darwin') {
    roots.push(path.join(home, 'Library', 'Application Support', 'LibreOffice'));
  } else {
    roots.push(path.join(process.env.XDG_CONFIG_HOME ?? path.join(home, '.config'), 'libreoffice'));
  }
  for (const root of roots) {
    try {
      for (const entry of fs.readdirSync(root)) {
        const userDir = path.join(root, entry, 'user');
        if (fs.statSync(userDir).isDirectory()) return userDir;
      }
    } catch {
      /* profile root not present — try next */
    }
  }
  return null;
}

/**
 * Delete LibreOffice's extension package-registry cache
 * (`<profile>/user/uno_packages/cache`). LibreOffice builds this cache on
 * first launch and does NOT rebuild it when unopkg adds an extension
 * later — the configuration PackageRegistryBackend (backenddb.xml) keeps
 * pointing at the old set of .xcu layers, so the sidebar deck/panel/
 * factory registrations never reach the runtime config. Deleting the
 * cache forces the next LibreOffice start to re-read every extension's
 * .xcu files from scratch. Only safe when LibreOffice is not running
 * (the installer route already enforces that with a 409).
 */
export function clearPackageCache(userProfile: string): boolean {
  const cacheDir = path.join(userProfile, 'uno_packages', 'cache');
  try {
    fs.rmSync(cacheDir, { recursive: true, force: true });
    return !fs.existsSync(cacheDir);
  } catch {
    return false;
  }
}

/** Test hook: override unopkg runner (installBridge reads it per call). */
export let runUnopkgForTesting: ((cmd: string[], timeoutMs: number) => Promise<RunResult>) | null = null;
export function setRunUnopkgForTesting(fn: ((cmd: string[], timeoutMs: number) => Promise<RunResult>) | null): void {
  runUnopkgForTesting = fn;
}

/** Remove-then-add (rule 6). A failing remove of an absent extension is OK. */
export async function installBridge(unopkgPath: string, oxtPath: string): Promise<InstallResult> {
  const steps: InstallStep[] = [];
  const quoted = (s: string) => (s.includes(' ') ? `"${s}"` : s);
  const doRun = runUnopkgForTesting ?? run;
  const remove = await doRun([unopkgPath, 'remove', BRIDGE_EXT_ID], 120_000);
  steps.push({
    command: `unopkg remove ${BRIDGE_EXT_ID}`,
    ok: true, // absence of the extension is the normal first-run case
    output: remove.output.trim(),
  });
  const add = await doRun([unopkgPath, 'add', oxtPath], 120_000);
  steps.push({
    command: `unopkg add ${quoted(path.basename(oxtPath))}`,
    ok: add.ok,
    output: add.output.trim(),
  });
  if (!add.ok) {
    return {
      ok: false,
      steps,
      message: `unopkg add failed (exit ${add.code}): ${add.output.trim().slice(0, 400)}`,
    };
  }
  // Force LibreOffice to re-read the extension's .xcu config layers on
  // next launch. Without this, a stale package-registry cache hides the
  // sidebar deck/panel/factory registrations and the deck renders empty
  // (verified live 2026-10-21: the deck button appears but the panel is
  // blank because Sidebar.xcu / Factories.xcu never reach the runtime
  // configuration backend).
  let cacheCleared = false;
  const profile = getLoUserProfile();
  if (profile) {
    cacheCleared = clearPackageCache(profile);
    steps.push({
      command: `clear package cache (${path.join('uno_packages', 'cache')})`,
      ok: true,
      output: cacheCleared ? 'removed' : 'nothing to remove',
    });
  }
  return {
    ok: true,
    steps,
    message:
      'Extension installed. Restart LibreOffice, then use menu ACP Assist > Start bridge.' +
      (cacheCleared ? ' (Package cache cleared so the sidebar deck registers cleanly.)' : ''),
  };
}

/** Test hook: override the profile lookup (installBridge reads it per call). */
let loUserProfileOverride: string | null | undefined;
export function setLoUserProfileForTesting(profile: string | null): void {
  loUserProfileOverride = profile;
}
function getLoUserProfile(): string | null {
  if (loUserProfileOverride !== undefined) return loUserProfileOverride;
  return findLoUserProfile();
}

interface RunResult {
  ok: boolean;
  code: number | null;
  output: string;
}

function run(cmd: string[], timeoutMs: number): Promise<RunResult> {
  return new Promise((resolve) => {
    let out = '';
    const child = spawn(cmd[0]!, cmd.slice(1), { windowsHide: true });
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.stdout?.on('data', (d: Buffer) => (out += d.toString('utf8')));
    child.stderr?.on('data', (d: Buffer) => (out += d.toString('utf8')));
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ ok: false, code: null, output: e.message });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, code, output: out });
    });
  });
}
