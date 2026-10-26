/**
 * HTTP client for the in-LibreOffice bridge (.oxt), plus discovery of
 * live bridge instances via the per-user `bridges/` directory.
 *
 * Contract (see extension/acpbridge.py): every request carries
 * `Authorization: Bearer <token>`; the bridge binds 127.0.0.1 only and
 * writes a `<pid>.json` discovery record when it starts.
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { TIMINGS } from '../timings.js';

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

/** Discovery-record protocol this companion speaks (bumps on breaking
 * record/HTTP changes; acpbridge.py's PROTOCOL must match). */
export const BRIDGE_PROTOCOL = 1;

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

/** The per-user app directory (parent of bridges/, holds companion.json). */
export function assistDir(): string {
  return path.join(bridgesDir(), '..');
}

export interface CompanionRecord {
  pid: number;
  port: number;
  url: string;
  /** Executable to launch for "open companion" (null in dev/browser mode). */
  exe: string | null;
  /**
   * Companion API bearer token (audit B1): the LO sidebar's status probe
   * reads it from this record and sends it as Authorization.
   */
  token: string;
}

/** Write this companion's discovery record (the in-LO status panel reads it). */
export async function writeCompanionRecord(record: CompanionRecord): Promise<void> {
  const file = path.join(assistDir(), 'companion.json');
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(record, null, 2), 'utf8');
}

/** Remove this companion's discovery record (best-effort, for shutdown). */
export async function removeCompanionRecord(): Promise<void> {
  await fs.rm(path.join(assistDir(), 'companion.json'), { force: true }).catch(() => undefined);
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
      // Audit B6: a record from a different discovery-protocol version
      // may carry fields we do not understand — ignore it instead of
      // talking to it (the protocol field exists for exactly this).
      if (raw.protocol !== BRIDGE_PROTOCOL) continue;
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

/** One sheet in a Calc document. */
export interface CalcSheet {
  name: string;
  /** Used range in A1 notation (e.g. "A1:D12"), sheet-relative. */
  usedRange: string;
  active: boolean;
}

/** A capped values/formulas grid read from a Calc sheet. */
export interface CalcGrid {
  values: string[][];
  /** Full grid (plain values where no formula); null when none has one. */
  formulas: string[][] | null;
  truncated: boolean;
}

/** The user's current selection in a Calc document. */
export interface CalcSelection extends CalcGrid {
  sheet: string;
  /** All selected ranges ("Sheet1!A1:B3"); data below is the FIRST range. */
  ranges: string[];
  /** Top-left cell of the first range (A1). */
  anchor: string;
  rows: number;
  cols: number;
}

/** The active sheet's used-range data (the agent's window on the sheet). */
export interface CalcSheetData extends CalcGrid {
  sheet: string;
  range: string;
}

/** Calc branch of /document (see _read_calc in the bridge). */
export interface CalcInfo {
  sheets: CalcSheet[];
  selection: CalcSelection | null;
  data: CalcSheetData | null;
}

/** One text-bearing shape on a slide, classified by the bridge. */
export interface SlideShapeInfo {
  i: number;
  kind: 'title' | 'body' | 'text' | 'other';
  /** Null for 'other' shapes (counted, not read). */
  text: string | null;
}

/** One slide in an Impress/Draw document (0-based `i`). */
export interface SlideInfo {
  i: number;
  name: string;
  current: boolean;
  shapes: SlideShapeInfo[];
}

/** One selected frame, located by (slide, shape) indices (both 0-based). */
export interface SlidesSelectionShape {
  slide: number;
  shape: number;
  kind: 'title' | 'body' | 'text' | 'other';
  text: string | null;
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
  /**
   * Writer: selected text ranges. Impress/Draw: selected frames as
   * {slide, shape, kind, text} objects (the bridge reuses the key).
   */
  selection?: string[] | SlidesSelectionShape[] | null;
  /** Calc only: sheets, selection data, active-sheet data. */
  calc?: CalcInfo;
  /** Impress/Draw only: the slide outline (capped; truncated flag below). */
  slides?: SlideInfo[];
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

export type EditMode =
  | 'insert' | 'insert-top' | 'insert-after' | 'rewrite' | 'rewrite-at' | 'delete-at'
  // Calc
  | 'write-cells' | 'insert-rows' | 'insert-cols'
  // Impress / Draw
  | 'rewrite-frame' | 'rewrite-slide' | 'insert-slide-after';

export interface EditPayload {
  mode: EditMode;
  /** 1-based paragraph address for insert-after / rewrite-at / delete-at. */
  target?: number | null;
  /** Calc: A1 anchor cell for write-cells / insert-rows / insert-cols. */
  anchor?: string | null;
  /** Calc: number of rows/columns to insert (default 1). */
  count?: number;
  /** Record the edit as a tracked change (default true). */
  tracked?: boolean;
  /** Writer: content paragraphs; required for every mode except delete-at.
   * Impress rewrite-frame sends plain strings instead of run structures. */
  paragraphs?: BlockParagraph[] | string[];
  /** Calc: TSV rows of cells for write-cells (strings; '=' prefix = formula). */
  rows?: string[][];
  /** Impress/Draw: 0-based slide index (rewrite-frame, rewrite-slide). */
  slide?: number;
  /** Impress/Draw: 0-based shape index on the slide (rewrite-frame). */
  shape?: number;
  /** Impress/Draw: new slide title (rewrite-slide, insert-slide-after). */
  title?: string;
  /** Impress/Draw: body paragraph lines (rewrite-slide, insert-slide-after). */
  body?: string[];
}

export interface EditResult {
  applied: boolean;
  title: string;
  mode: EditMode;
  target?: number | null;
  /** Calc: sheet name and resolved A1 anchor. */
  sheet?: string;
  anchor?: string;
  /** Impress/Draw: the slide index the edit touched (0-based; the anchor
   * for insert-slide-after, 0 = inserted at the very start). */
  slide?: number;
  /** Impress/Draw rewrite-frame: the shape index that was rewritten. */
  shape?: number;
}

// --- client ----------------------------------------------------------------

export class BridgeClient {
  readonly record: BridgeRecord;
  private base: string;

  constructor(record: BridgeRecord) {
    this.record = record;
    this.base = `http://127.0.0.1:${record.port}`;
  }

  private async request(method: string, apiPath: string, body?: unknown, timeoutMs: number = TIMINGS.bridgeRequestTimeoutMs): Promise<unknown> {
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

  /**
   * Track D: the bridge's /events long-poll — the selection-changed and
   * document-edited feed the server watcher consumes (one long-poll per
   * session; see acpbridge.py `_events`). Returns the fresh events and
   * the new cursor.
   */
  events(since: number, timeoutMs = TIMINGS.eventPollMs): Promise<{ events: { seq: number; type: string; ts: string }[]; last: number }> {
    return this.request(
      'GET',
      `/events?since=${since}&timeout=${Math.round(timeoutMs / 1000)}`,
      undefined,
      timeoutMs + 10_000,
    ) as Promise<{ events: { seq: number; type: string; ts: string }[]; last: number }>;
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