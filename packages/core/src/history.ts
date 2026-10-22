/**
 * Per-document chat-history persistence and restart replay, shared by the
 * companion apps. Histories are keyed by the app's conversation key
 * (document path or URL) and stored as `<sha256-prefix>.json` files.
 */

import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Turn, TurnMeta } from './types.js';

/** Key for the unsaved-document pseudo conversation. */
export const UNSAVED_KEY = '(unsaved)';

/**
 * Conversation-history replay after an app restart: the agent process is
 * new and has no memory, so it must be briefed on the turns it missed.
 * A turn counts as "replayed" once it has been sent in one prompt.
 */
export const HISTORY_REPLAY_LIMIT = 20;
/** Per-turn character cap when replaying history into a prompt. */
export const HISTORY_REPLAY_CHAR_LIMIT = 500;

/**
 * List persisted conversation keys. Entries whose key fails the optional
 * `exists` check (e.g. the document file is gone) are skipped.
 */
export async function listKnownDocuments(
  historyDir: string,
  options: { exists?: (key: string) => Promise<boolean> } = {},
): Promise<string[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(historyDir);
  } catch {
    return [];
  }
  const keys: string[] = [];
  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue;
    try {
      const raw = await fs.readFile(path.join(historyDir, entry), 'utf8');
      const data = JSON.parse(raw) as { key?: string };
      const key = data.key;
      if (typeof key !== 'string' || key === UNSAVED_KEY) continue;
      if (options.exists && !(await options.exists(key))) continue;
      keys.push(key);
    } catch {
      /* unreadable entry — skip */
    }
  }
  return keys;
}

export function historyFile(dir: string, key: string): string {
  const hash = createHash('sha256').update(key).digest('hex').slice(0, 16);
  return path.join(dir, `${hash}.json`);
}

export async function loadHistory(dir: string, key: string): Promise<Turn[]> {
  try {
    const raw = await fs.readFile(historyFile(dir, key), 'utf8');
    const data = JSON.parse(raw) as { key?: string; turns: Turn[] };
    if (data.key !== key) return []; // hash collision guard
    return Array.isArray(data.turns) ? data.turns : [];
  } catch {
    return [];
  }
}

export async function saveHistory(dir: string, key: string, turns: Turn[]): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(historyFile(dir, key), JSON.stringify({ key, turns }, null, 2), 'utf8');
}

export interface HistoryReplayOptions {
  /**
   * Fenced content blocks stripped from replayed assistant turns (they
   * are reported via the meta line instead), e.g. /```lyx[\s\S]*?```/g
   * or /```(?:writer|calc|impress)[\s\S]*?```/g.
   */
  blockPattern: RegExp;
  /** Renders the address suffix of an applied action (e.g. " p5"). */
  describeTarget?: (meta: TurnMeta) => string;
}

export function formatHistoryReplay(
  turns: Turn[],
  unseen: number,
  options: HistoryReplayOptions,
): string {
  const count = Math.min(Math.max(0, unseen), turns.length, HISTORY_REPLAY_LIMIT);
  if (count <= 0) return '';
  const lines: string[] = [
    `Conversation so far (earlier turns, replayed because the app was restarted — you have no memory of these):`,
    `The user can see this history; treat it as context, not as a request to continue anything.`,
  ];
  for (const turn of turns.slice(0, count)) {
    const label = turn.role === 'user' ? 'User' : 'You';
    let text = (turn.content ?? '')
      // The replay is context, not a request to re-apply: drop the action
      // tag and any fenced content block (the meta line reports the
      // outcome).
      .replace(options.blockPattern, '')
      .replace(/\[ACTION:\s*[^\]]*\]/gi, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (text.length > HISTORY_REPLAY_CHAR_LIMIT) {
      text = `${text.slice(0, HISTORY_REPLAY_CHAR_LIMIT)}…`;
    }
    lines.push(`- ${label}: ${text}`);
    if (turn.role === 'assistant' && turn.meta) {
      const m = turn.meta;
      if (m.result === 'applied' && m.action !== 'none') {
        const at = options.describeTarget ? options.describeTarget(m) : '';
        lines.push(`  (applied [ACTION: ${m.action}${at}] in the document)`);
      } else if (m.result === 'error') {
        lines.push(`  (action ${m.action} FAILED: ${m.error ?? 'unknown error'})`);
      } else if (m.result === 'cancelled') {
        lines.push(`  (action ${m.action} was cancelled before applying)`);
      }
    }
  }
  return '\n' + lines.join('\n');
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}