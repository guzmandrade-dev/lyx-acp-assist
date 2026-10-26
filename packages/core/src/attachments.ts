/**
 * Best-effort text/markdown extraction for an uploaded attachment:
 * text formats are read directly; binary formats (PDF, DOCX, XLSX, ...)
 * go through the markitdown CLI when it is installed.
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import type { Attachment } from './types.js';

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

/** Options for the per-app extractor factory (audit Track D). */
export interface AttachmentExtractorOptions {
  /**
   * File extensions (WITHOUT the leading dot) the app reads as text
   * directly (e.g. 'lyx', 'odt'); everything else goes through the
   * markitdown converter chain.
   */
  extensions: readonly string[];
  /**
   * Name of the env var that overrides the markitdown converter path
   * (read per call, e.g. LYX_MARKITDOWN / LO_MARKITDOWN).
   */
  envVar?: string;
}

/**
 * Audit Track D: factory for the apps' identical `extractAttachmentText`
 * wrappers — they differ only in the textual-extension list and the
 * env var name, so each app keeps just that pair.
 */
export function createAttachmentExtractor(
  options: AttachmentExtractorOptions,
): (filePath: string, name: string) => Promise<string | null> {
  const textualFile = new RegExp(
    `\\.(${options.extensions.map(escapeRegExp).join('|')})$`,
    'i',
  );
  return (filePath, name) =>
    extractAttachmentText(filePath, name, {
      textualFile,
      markitdownEnv: options.envVar ? process.env[options.envVar] : undefined,
    });
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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
/**
 * Audit Track D: the attachment prompt section, character-identical in
 * both apps' buildAutoPrompt — extracted here once.
 */
export function buildAttachmentBlock(attachments: Attachment[]): string[] {
  if (attachments.length === 0) return [];
  const parts: string[] = [
    '',
    'Attached files (reference material the user attached for this ' +
      'message; the ACTIVE document you may edit is only the one ' +
      'described above — never write into the attachments):',
  ];
  for (const att of attachments) {
    parts.push('', `--- ${att.name} (stored at: ${att.path}) ---`);
    if (att.text) {
      parts.push(
        '[Excerpt below may be TRUNCATED. If you cannot find something ' +
          'in it, read or search the FULL stored file at the path above ' +
          'with your file tools before concluding it is absent. When ' +
          'searching, use short distinctive substrings — the user may ' +
          'misspell or translate terms.]',
      );
      parts.push(att.text);
    } else {
      parts.push(
        '[No text could be extracted on the app side. The file is at the ' +
          'path above; read it yourself if you have file-reading tools.]',
      );
    }
  }
  return parts;
}
