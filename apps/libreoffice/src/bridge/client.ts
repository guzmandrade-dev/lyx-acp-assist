/**
 * HTTP client for the in-LibreOffice bridge (.oxt), plus discovery of
 * live bridge instances via the per-user `bridges/` directory.
 *
 * Contract (see spike/oxt/acpbridge.py): every request carries
 * `Authorization: Bearer <token>`; the bridge binds 127.0.0.1 only and
 * writes a `<pid>.json` discovery record when it starts.
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

/** One `<pid>.json` discovery record written by a bridge. */
export interface BridgeRecord {
  app: string;
  protocol: number;
  pid: number;
  port: number;
  token: string;
  startedAt: string;
  platform?: string;
}

export class BridgeError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'BridgeError';
  }
}

/** Where the bridges write their discovery records, per platform. */
export function bridgesDir(): string {
  const app = 'LibreOffice ACP Assist';
  if (process.platform === 'win32') {
    return path.join(process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming'), app, 'bridges');
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', app, 'bridges');
  }
  return path.join(process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), '.config'), app, 'bridges');
}

/** True when a process with this PID exists (best-effort liveness probe). */
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Scan the discovery directory and return every live bridge record,
 * newest start time first. Records of dead PIDs are removed lazily.
 */
export async function discoverBridges(dir: string = bridgesDir()): Promise<BridgeRecord[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return [];
  }
  const records: BridgeRecord[] = [];
  const stale: string[] = [];
  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue;
    const file = path.join(dir, entry);
    try {
      const raw = JSON.parse(await fs.readFile(file, 'utf8')) as BridgeRecord;
      if (typeof raw !== 'object' || typeof raw.port !== 'number' || typeof raw.token !== 'string') continue;
      if (typeof raw.pid === 'number' && !pidAlive(raw.pid)) {
        stale.push(file);
        continue;
      }
      records.push(raw);
    } catch {
      /* unreadable record — ignore */
    }
  }
  await Promise.all(stale.map((f) => fs.unlink(f).catch(() => undefined)));
  records.sort((a, b) => (b.startedAt ?? '').localeCompare(a.startedAt ?? ''));
  return records;
}

// --- bridge API types ------------------------------------------------------

export interface BridgeStatus {
  active: boolean;
  module?: string;
  title?: string;
  url?: string;
  recordChanges?: boolean;
  pid: number;
  port: number;
  startedAt: string;
}

export interface BridgeDocumentEntry {
  title: string;
  url: string;
  module: string;
  active: boolean;
}

export interface WriterParagraph {
  i: number;
  text: string;
  style: string;
}

export interface BridgeDocument {
  active: boolean;
  module: string;
  title: string;
  url: string;
  /** Writer only: full paragraph list with [pN] indices (0-based `i`). */
  paragraphs?: WriterParagraph[];
  /** Writer only: whole-document plain text (\n separated). */
  text?: string;
  /** Writer only: selected text ranges, null when nothing is selected. */
  selection?: string[] | null;
  /** Style name of the paragraph containing the cursor. */
  cursorStyle?: string | null;
  /** True when the paragraph list is preview-truncated (lazy fetch). */
  truncated?: boolean;
}

/** One run of inline-formatted text inside a block paragraph. */
export interface BlockRun {
  text: string;
  bold?: boolean;
  italic?: boolean;
  code?: boolean;
}

/** One paragraph the agent wants written, with its style and inline runs. */
export interface BlockParagraph {
  /** Writer paragraph style name (e.g. "Heading 1"), or null for default. */
  style: string | null;
  runs: BlockRun[];
}

export type EditMode = 'insert' | 'insert-top' | 'insert-after' | 'rewrite' | 'rewrite-at' | 'delete-at';

export interface EditPayload {
  mode: EditMode;
  /** 1-based paragraph address for insert-after / rewrite-at / delete-at. */
  target?: number | null;
  /** Record the edit as a tracked change (default true). */
  tracked?: boolean;
  /** Content paragraphs; required for every mode except delete-at. */
  paragraphs?: BlockParagraph[];
}

export interface EditResult {
  applied: boolean;
  title: string;
  mode: EditMode;
  target?: number | null;
}

// --- client ----------------------------------------------------------------

export class BridgeClient {
  readonly record: BridgeRecord;
  private base: string;

  constructor(record: BridgeRecord) {
    this.record = record;
    this.base = `http://127.0.0.1:${record.port}`;
  }

  private async request(method: string, apiPath: string, body?: unknown, timeoutMs = 40_000): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(`${this.base}${apiPath}`, {
        method,
        headers: {
          Authorization: `Bearer ${this.record.token}`,
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
      const text = await res.text();
      const data = text ? (JSON.parse(text) as Record<string, unknown>) : {};
      if (!res.ok) {
        throw new BridgeError(String(data.error ?? `bridge returned ${res.status}`), res.status);
      }
      return data;
    } catch (e) {
      if (e instanceof BridgeError) throw e;
      const message = e instanceof Error ? e.message : String(e);
      throw new BridgeError(`bridge unreachable (${message})`);
    } finally {
      clearTimeout(timer);
    }
  }

  status(): Promise<BridgeStatus> {
    return this.request('GET', '/status') as Promise<BridgeStatus>;
  }

  documents(): Promise<{ documents: BridgeDocumentEntry[] }> {
    return this.request('GET', '/documents') as Promise<{ documents: BridgeDocumentEntry[] }>;
  }

  document(): Promise<BridgeDocument> {
    return this.request('GET', '/document') as Promise<BridgeDocument>;
  }

  /** Lazy fetch: the full text of one paragraph (large documents). */
  paragraph(index: number): Promise<{ i: number; text: string; style: string }> {
    return this.request('GET', `/document/p/${index}`) as Promise<{ i: number; text: string; style: string }>;
  }

  edit(payload: EditPayload): Promise<EditResult> {
    return this.request('POST', '/edit', payload) as Promise<EditResult>;
  }

  /** Make another open document the active one (by URL or title). */
  activate(urlOrTitle: string): Promise<{ activated: string }> {
    return this.request('POST', '/activate', { url: urlOrTitle }) as Promise<{ activated: string }>;
  }

  undo(): Promise<{ undone: boolean; reason?: string }> {
    return this.request('POST', '/undo') as Promise<{ undone: boolean; reason?: string }>;
  }
}