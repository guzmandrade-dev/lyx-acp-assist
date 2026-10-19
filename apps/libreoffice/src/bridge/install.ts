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

/** Remove-then-add (rule 6). A failing remove of an absent extension is OK. */
export async function installBridge(unopkgPath: string, oxtPath: string): Promise<InstallResult> {
  const steps: InstallStep[] = [];
  const quoted = (s: string) => (s.includes(' ') ? `"${s}"` : s);
  const remove = await run([unopkgPath, 'remove', BRIDGE_EXT_ID], 120_000);
  steps.push({
    command: `unopkg remove ${BRIDGE_EXT_ID}`,
    ok: true, // absence of the extension is the normal first-run case
    output: remove.output.trim(),
  });
  const add = await run([unopkgPath, 'add', oxtPath], 120_000);
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
  return {
    ok: true,
    steps,
    message: 'Extension installed. Restart LibreOffice, then use menu ACP Assist > Start bridge.',
  };
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
