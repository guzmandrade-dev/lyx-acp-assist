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
}

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

  function persist(key: string, turns: Turn[]): void {
    if (options.historyDir) {
      saveHistory(options.historyDir, key, turns).catch((e) =>
        options.logError('[history] save failed', e),
      );
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
      persist(key, turns);
    },
    async recordActionStep(assistant: string, _step: number) {
      const key = keyOf();
      const turns = await ensure(key);
      turns.push({ role: 'assistant', content: assistant, timestamp: new Date().toISOString() });
      persist(key, turns);
    },
    async recordTurnMeta(meta: TurnMeta) {
      const key = keyOf();
      const turns = await ensure(key);
      const last = turns[turns.length - 1];
      if (!last || last.role !== 'assistant') return;
      last.meta = meta;
      persist(key, turns);
    },
  };
}