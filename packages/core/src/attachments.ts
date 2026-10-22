/**
 * Best-effort text/markdown extraction for an uploaded attachment:
 * text formats are read directly; binary formats (PDF, DOCX, XLSX, ...)
 * go through the markitdown CLI when it is installed.
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

export const ATTACHMENT_TEXT_LIMIT = 40_000;

/**
 * Default extensions read as text directly (no converter needed). Apps
 * with editor-specific formats (e.g. `.lyx`, `.odt`) pass their own.
 */
const DEFAULT_TEXTUAL_FILE =
  /\.(txt|md|markdown|csv|tsv|json|xml|bib|log|html?|yaml|yml|py|js|ts)$/i;

export interface AttachmentTextOptions {
  /** Extensions the app can read as text directly. */
  textualFile?: RegExp;
  /** Preferred markitdown override (e.g. LYX_MARKITDOWN / LO_MARKITDOWN). */
  markitdownEnv?: string | undefined;
}

export async function extractAttachmentText(
  filePath: string,
  name: string,
  options: AttachmentTextOptions = {},
): Promise<string | null> {
  const textualFile = options.textualFile ?? DEFAULT_TEXTUAL_FILE;
  if (textualFile.test(name)) {
    try {
      const raw = await fs.readFile(filePath, 'utf8');
      return raw.slice(0, ATTACHMENT_TEXT_LIMIT);
    } catch {
      return null;
    }
  }
  for (const command of markitdownCandidates(options.markitdownEnv)) {
    try {
      const quoted = command.includes(' ')
        ? `"${command.replace(/"/g, '')}"`
        : command;
      const out = await runCommand(`${quoted} "${filePath}"`, 60_000);
      if (out.trim()) return out.slice(0, ATTACHMENT_TEXT_LIMIT);
    } catch {
      /* try the next converter */
    }
  }
  return null;
}

/**
 * Converter candidates, most preferred first: an env-var override,
 * then `markitdown` on PATH, then `uvx markitdown`, then the
 * markitdown-mcp venv (the same install the markitdown MCP server uses
 * on this machine).
 */
function markitdownCandidates(envOverride: string | undefined): string[] {
  const candidates: string[] = [];
  if (envOverride) candidates.push(envOverride);
  candidates.push('markitdown', 'uvx markitdown');
  if (process.platform === 'win32') {
    candidates.push(
      path.join(
        os.homedir(), '.local', 'venvs', 'markitdown-mcp', 'Scripts', 'markitdown.exe',
      ),
    );
  }
  return candidates;
}

function runCommand(command: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, { shell: true, windowsHide: true });
    let out = '';
    let err = '';
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.stdout?.on('data', (d: Buffer) => (out += d.toString('utf8')));
    child.stderr?.on('data', (d: Buffer) => (err += d.toString('utf8')));
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(out);
      else reject(new Error(`exit ${code}: ${err.slice(0, 200)}`));
    });
  });
}