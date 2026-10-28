/**
 * Shared conversation store: per-document chat turns held in memory,
 * persisted to disk, and replayed to the agent after a restart.
 *
 * Both companion apps use the same mechanics and differ only in how the
 * conversation key is derived (LyX: document path on disk; LibreOffice:
 * the bridge's active-document URL) — hence the `keyOf` callback.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import type express from 'express';
import type { Turn, TurnMeta } from './types.js';
import { formatHistoryReplay, type HistoryReplayOptions, loadHistory, saveHistory } from './history.js';

/** Max document edits one user message may apply (app-level safety stop). */
export const MAX_ACTIONS_PER_MESSAGE = 10;

/**
 * The app-level error logger: console + best-effort append to
 * `<logDir>/errors.log`. Logging must never break the request path.
 */
export function createLogError(logDir?: string) {
  return (scope: string, err: unknown): void => {
    const message = err instanceof Error ? err.message : String(err);
    const line = `[${new Date().toISOString()}] ${scope}: ${message}\n`;
    console.error(line.trim());
    if (logDir) {
      fs.appendFile(path.join(logDir, 'errors.log'), line, 'utf8').catch(() => {
        /* logging must never break the request path */
      });
    }
  };
}

export interface WrapOptions {
  /** The app's error logger (see createLogError). */
  logError: (scope: string, err: unknown) => void;
  /**
   * Maps a thrown error to the HTTP status sent (default: 500). Apps map
   * their transport errors (bridge / LyX pipe) to 503.
   */
  mapStatus?: (err: unknown) => number;
}

/**
 * The apps' identical async route wrappers — try/catch,
 * log via the app's logError, respond `{ error }` with the mapped
 * status. They differed only in the Error→503 mapping.
 */
export function createWrap(options: WrapOptions) {
  return (handler: (req: express.Request, res: express.Response) => Promise<unknown>) =>
    async (req: express.Request, res: express.Response) => {
      try {
        await handler(req, res);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const status = options.mapStatus ? options.mapStatus(err) : 500;
        options.logError(`[api] ${req.path}`, err);
        res.status(status).json({ error: message });
      }
    };
}

/** Start an SSE response; returns the frame sender. */
export const startSse = (res: express.Response) => {
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });
  return (obj: unknown) => {
    res.write(`data: ${JSON.stringify(obj)}\n\n`);
  };
};

/** End an already-started SSE response with an error frame. */
export const sseFail = (res: express.Response, err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  res.write(`data: ${JSON.stringify({ error: message })}\n\n`);
  res.write('data: {"done":true}\n\n');
  res.end();
};

export interface ConversationStoreOptions {
  /** Directory for persisted chat history (per document). Optional. */
  historyDir?: string;
  /** The app's error logger (see createLogError). */
  logError: (scope: string, err: unknown) => void;
  /** Per-session conversation map (the caller owns and exposes it). */
  conversations: Map<string, Turn[]>;
  /** Per-session unseen-history counters (the caller owns and exposes it). */
  historyHandoff: Map<string, number>;
  /** Current conversation key (per-app: document path / bridge doc url). */
  keyOf: () => string;
  /** Replay rendering (app-specific block pattern + target rendering). */
  replayOptions: HistoryReplayOptions;
}

export interface ConversationStore {
  /** Get (creating if needed) the conversation for a key. */
  ensure: (key: string) => Promise<Turn[]>;
  /** The current conversation key. */
  key: () => string;
  /** Leading persisted turns the fresh agent process has NOT seen. */
  unseenCount: (key: string) => number;
  /** Replay block for unseen turns ('' when the agent knows everything). */
  buildHistoryPrefix: (key: string) => string;
  /** Record one user + assistant exchange in the current conversation. */
  recordTurn: (user: string, assistant: string) => Promise<void>;
  /**
   * Record one step of a multi-action run WITHOUT a matching user turn:
   * the user asked once, the app applied several edits. UI and history
   * see each outcome; the log keeps the original request as the user turn.
   */
  recordActionStep: (assistant: string, step: number) => Promise<void>;
  /**
   * Record the outcome of the action the assistant proposed in the LAST
   * turn, so a failed or successful document action survives a restart.
   */
  recordTurnMeta: (meta: TurnMeta) => Promise<void>;
  /**
   * Write any pending (debounced) history changes to disk immediately.
   * The stream loop calls this at turn boundaries; a crash can then only
   * lose the in-flight step, never a completed one.
   */
  flush: (key?: string) => Promise<void>;
}

/**
 * How long persist batches writes before hitting the disk. Turn pushes and
 * their meta updates arrive within milliseconds of each other, so this
 * coalesces each (turn, meta) pair — and rapid multi-action steps — into
 * ONE rewrite of the growing history file instead of one per call.
 */
const PERSIST_DEBOUNCE_MS = 500;

export function createConversationStore(options: ConversationStoreOptions): ConversationStore {
  const { conversations, historyHandoff, keyOf } = options;

  async function ensure(key: string): Promise<Turn[]> {
    let turns = conversations.get(key);
    if (!turns) {
      turns = [];
      conversations.set(key, turns);
      // Load persisted history if available. These turns predate this
      // process: the agent cannot see them unless we replay them (it has
      // no memory across restarts).
      if (options.historyDir) {
        try {
          const loaded = await loadHistory(options.historyDir, key);
          turns.push(...loaded);
          historyHandoff.set(key, loaded.length);
        } catch {
          /* unreadable history — start empty */
        }
      }
    }
    return turns;
  }

  const pendingTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const dirty = new Set<string>();

  function writeNow(key: string): void {
    if (!options.historyDir) return;
    dirty.delete(key);
    const turns = conversations.get(key);
    if (!turns) return;
    saveHistory(options.historyDir, key, turns).catch((e) =>
      options.logError('[history] save failed', e),
    );
  }

  /** Debounced persist: one write per burst of record* calls. */
  function persist(key: string): void {
    if (!options.historyDir) return;
    dirty.add(key);
    if (pendingTimers.has(key)) return; // a write is already scheduled
    const timer = setTimeout(() => {
      pendingTimers.delete(key);
      if (dirty.has(key)) writeNow(key);
    }, PERSIST_DEBOUNCE_MS);
    // Never hold the process (or an Electron quit) open for a pending write.
    if (typeof timer.unref === 'function') timer.unref();
    pendingTimers.set(key, timer);
  }

  async function flush(key?: string): Promise<void> {
    const keys = key ? [key] : [...new Set([...pendingTimers.keys(), ...dirty])];
    for (const k of keys) {
      const timer = pendingTimers.get(k);
      if (timer) {
        clearTimeout(timer);
        pendingTimers.delete(k);
      }
      if (!dirty.has(k)) continue;
      dirty.delete(k);
      if (!options.historyDir) continue;
      const turns = conversations.get(k);
      if (!turns) continue;
      try {
        await saveHistory(options.historyDir, k, turns);
      } catch (e) {
        options.logError('[history] save failed', e);
      }
    }
  }

  return {
    ensure,
    key: keyOf,
    unseenCount: (key) => historyHandoff.get(key) ?? 0,
    buildHistoryPrefix: (key) =>
      formatHistoryReplay(conversations.get(key) ?? [], historyHandoff.get(key) ?? 0, options.replayOptions),
    async recordTurn(user: string, assistant: string) {
      const key = keyOf();
      const turns = await ensure(key);
      turns.push(
        { role: 'user', content: user, timestamp: new Date().toISOString() },
        { role: 'assistant', content: assistant, timestamp: new Date().toISOString() },
      );
      persist(key);
    },
    async recordActionStep(assistant: string, _step: number) {
      const key = keyOf();
      const turns = await ensure(key);
      turns.push({ role: 'assistant', content: assistant, timestamp: new Date().toISOString() });
      persist(key);
    },
    async recordTurnMeta(meta: TurnMeta) {
      const key = keyOf();
      const turns = await ensure(key);
      const last = turns[turns.length - 1];
      if (!last || last.role !== 'assistant') return;
      last.meta = meta;
      persist(key);
    },
    flush,
  };
}