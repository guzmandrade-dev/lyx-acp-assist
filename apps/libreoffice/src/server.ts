/**
 * Express API + session orchestration for the LibreOffice ACP companion.
 *
 * One session = one bridge (one LibreOffice instance) + one ACP agent.
 * Documents are tracked dynamically: every request re-reads the bridge's
 * active document; conversations are keyed per document URL. All reads
 * and writes go through the in-LibreOffice bridge (spike/oxt) — the
 * bridge is the only thing that touches UNO, and LibreOffice remains the
 * single writer of truth.
 */

import { randomUUID, createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import express from 'express';
import type { ContentBlock } from '@agentclientprotocol/sdk';
import {
  BridgeClient,
  BridgeError,
  discoverBridges,
} from './bridge/client.js';
import { writerAdapter } from './modules/writer.js';
import { genericAdapter } from './modules/generic.js';
import type { ModuleAdapter, AgentAction, ActionOutcome, SelectionInfo } from './modules/types.js';
import { extractContentBlock, parseContentBlock } from './modules/markdown.js';
import { AcpClient } from './acp/client.js';

export interface AgentSettings {
  command: string;
  args: string[];
  env: Record<string, string>;
}

export interface Turn {
  role: 'user' | 'assistant';
  content: string;
  timestamp: string;
  /** Outcome of the action this assistant turn proposed (see TurnMeta). */
  meta?: TurnMeta;
}

export interface TurnMeta {
  action: string;
  target?: number | null;
  result: 'applied' | 'error' | 'cancelled';
  error?: string;
  step?: number;
}

const UNSAVED_KEY = '(unsaved)';

/** Conversation-history replay after an app restart (agent has no memory). */
const HISTORY_REPLAY_LIMIT = 20;
const HISTORY_REPLAY_CHAR_LIMIT = 500;

/** Max document edits per user message (app-level safety stop). */
const MAX_ACTIONS_PER_MESSAGE = 10;

/** Minimal agent surface the server needs (AcpClient satisfies this). */
export interface AgentRunner {
  start(): Promise<void>;
  stop(): void;
  createSession(sessionId: string): Promise<void>;
  cancel(sessionId: string): void;
  prompt(
    sessionId: string,
    content: ContentBlock[],
    options?: {
      onChunk?: (chunk: string) => void;
      onToolCall?: (tool: { title: string; status: string; kind: string }) => void;
      timeoutMs?: number;
    },
  ): Promise<string>;
}

export interface Session {
  id: string;
  bridge: BridgeClient;
  agent: AgentRunner;
  conversations: Map<string, Turn[]>;
  /** Leading persisted turns per key the fresh agent process has not seen. */
  historyHandoff: Map<string, number>;
  knownDocuments: Set<string>;
  /** Active document {url,title,module}; refreshed from the bridge. */
  activeDoc: { url: string; title: string; module: string } | null;
  cancelRequested: boolean;
  attachments: Attachment[];
}

export interface ServerOptions {
  publicDir: string;
  historyDir?: string;
  attachmentsDir?: string;
  logDir?: string;
  settingsDir?: string;
}

/** A file the user attached to the next message. */
export interface Attachment {
  id: string;
  name: string;
  path: string;
  text: string | null;
}

export function createServer(options: ServerOptions & {
  /** Test hook: inject a fake agent process instead of spawning one. */
  agentFactory?: (settings: AgentSettings) => AgentRunner;
  /** Test hook: inject a fake bridge client instead of discovery. */
  bridgeFactory?: () => BridgeClient;
}) {
  const app = express();
  app.use(express.json({ limit: '50mb' }));
  app.use(express.static(options.publicDir, { maxAge: 0, etag: false, lastModified: false }));

  const sessions = new Map<string, Session>();

  function logError(scope: string, err: unknown): void {
    const message = err instanceof Error ? err.message : String(err);
    const line = `[${new Date().toISOString()}] ${scope}: ${message}\n`;
    console.error(line.trim());
    if (options.logDir) {
      fs.appendFile(path.join(options.logDir, 'errors.log'), line, 'utf8').catch(() => undefined);
    }
  }

  const wrap = (handler: (req: express.Request, res: express.Response) => Promise<unknown>) =>
    async (req: express.Request, res: express.Response) => {
      try {
        await handler(req, res);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const status = err instanceof BridgeError ? 503 : 500;
        logError(`[api] ${req.path}`, err);
        res.status(status).json({ error: message });
      }
    };

  const startSse = (res: express.Response) => {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    return (obj: unknown) => {
      res.write(`data: ${JSON.stringify(obj)}\n\n`);
    };
  };

  const sseFail = (res: express.Response, err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    res.write(`data: ${JSON.stringify({ error: message })}\n\n`);
    res.write('data: {"done":true}\n\n');
    res.end();
  };

  async function recordTurnMeta(session: Session, meta: TurnMeta): Promise<void> {
    const key = conversationKey(session);
    const turns = await ensureConversation(session, key);
    const last = turns[turns.length - 1];
    if (!last || last.role !== 'assistant') return;
    last.meta = meta;
    if (options.historyDir) {
      saveHistory(options.historyDir, key, turns).catch((e) => logError('[history] save failed', e));
    }
  }

  // --- adapter selection ---------------------------------------------------

  function adapterFor(module: string): ModuleAdapter {
    return module === 'writer' ? writerAdapter : genericAdapter;
  }

  // --- status / settings ---------------------------------------------------

  app.get('/api/status', async (_req, res) => {
    try {
      if (options.bridgeFactory) {
        // Test hook: a fake bridge is injected; discovery is bypassed.
        res.json({ bridgeAvailable: true });
        return;
      }
      const bridges = await discoverBridges();
      res.json({ bridgeAvailable: bridges.length > 0 });
    } catch (e) {
      logError('[api] status', e);
      res.json({ bridgeAvailable: false });
    }
  });

  const settingsFile = options.settingsDir
    ? path.join(options.settingsDir, 'agent-settings.json')
    : null;

  async function readAgentSettingsFile(): Promise<Partial<AgentSettings>> {
    if (!settingsFile) return {};
    try {
      const raw = JSON.parse(await fs.readFile(settingsFile, 'utf8'));
      return raw && typeof raw === 'object' ? raw : {};
    } catch {
      return {};
    }
  }

  app.get('/api/settings/agent', (_req, res) => {
    readAgentSettingsFile()
      .then((s) => res.json(s))
      .catch(() => res.json({}));
  });

  app.put(
    '/api/settings/agent',
    wrap(async (req, res) => {
      const s = readAgentSettingsBody(req.body);
      if (!settingsFile) {
        res.json(s);
        return;
      }
      await fs.mkdir(options.settingsDir!, { recursive: true });
      const previous = await readAgentSettingsFile();
      const merged = { ...previous, ...s };
      await fs.writeFile(settingsFile, JSON.stringify(merged, null, 2), 'utf8');
      res.json(merged);
    }),
  );

  function readAgentSettingsBody(body: unknown): Partial<AgentSettings> {
    const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
    const out: Partial<AgentSettings> = {};
    if (typeof b.command === 'string') out.command = b.command.trim();
    if (typeof b.args === 'string') out.args = b.args.trim().split(/\s+/).filter(Boolean);
    else if (Array.isArray(b.args)) {
      out.args = b.args.filter((a): a is string => typeof a === 'string' && a.trim().length > 0);
    }
    if (b.env && typeof b.env === 'object') {
      out.env = Object.fromEntries(
        Object.entries(b.env as Record<string, unknown>).filter(
          (e): e is [string, string] => typeof e[1] === 'string',
        ),
      );
    }
    return out;
  }

  // --- session ---------------------------------------------------------------

  app.post(
    '/api/session',
    wrap(async (req, res) => {
      const persisted = await readAgentSettingsFile();
      const requested = req.body?.agent as Partial<AgentSettings> | undefined;
      const settings: AgentSettings = {
        command: requested?.command ?? persisted.command ?? 'opencode',
        args: requested?.args ?? persisted.args ?? ['acp'],
        env: requested?.env ?? persisted.env ?? {},
      };

      const bridge = options.bridgeFactory
        ? options.bridgeFactory()
        : await pickBridge();
      const agent: AgentRunner = options.agentFactory
        ? options.agentFactory(settings)
        : new AcpClient(settings);
      await agent.start();

      const id = randomUUID();
      const session: Session = {
        id,
        bridge,
        agent,
        conversations: new Map(),
        historyHandoff: new Map(),
        knownDocuments: new Set(),
        activeDoc: null,
        cancelRequested: false,
        attachments: [],
      };
      sessions.set(id, session);
      await agent.createSession(id);

      if (options.historyDir) {
        for (const docPath of await listKnownDocuments(options.historyDir)) {
          session.knownDocuments.add(docPath);
        }
      }

      res.json(await sessionInfo(session));
    }),
  );

  /** Newest live bridge record, or throw a user-facing error. */
  async function pickBridge(): Promise<BridgeClient> {
    const bridges = await discoverBridges();
    if (bridges.length === 0) {
      throw new BridgeError(
        'No LibreOffice bridge found. Start LibreOffice (with the ACP Assist ' +
          'extension installed) and use menu ACP Assist > Start bridge.',
      );
    }
    return new BridgeClient(bridges[0]!);
  }

  app.get(
    '/api/session/:id',
    wrap(async (req, res) => {
      const session = getSession(req.params['id']);
      res.json(await sessionInfo(session));
    }),
  );

  app.delete(
    '/api/session/:id',
    wrap(async (req, res) => {
      const session = getSession(req.params['id']);
      sessions.delete(session.id);
      session.agent.stop();
      res.json({ ok: true });
    }),
  );

  app.post(
    '/api/session/:id/cancel',
    wrap(async (req, res) => {
      const session = getSession(req.params['id']);
      session.cancelRequested = true;
      session.agent.cancel(session.id);
      res.json({ ok: true });
    }),
  );

  // --- attachments -----------------------------------------------------------

  app.post(
    '/api/session/:id/attachments',
    wrap(async (req, res) => {
      const session = getSession(req.params['id']);
      if (!options.attachmentsDir) throw new Error('Attachments are not configured.');
      const name = (req.body?.name as string | undefined)?.trim();
      const data = req.body?.data as string | undefined;
      if (!name || !data) {
        res.status(400).json({ error: 'name and data are required' });
        return;
      }
      await fs.mkdir(options.attachmentsDir, { recursive: true });
      const safe = name.replace(/[^\w.\- ]+/g, '_');
      const id = randomUUID();
      const filePath = path.join(options.attachmentsDir, `${id}-${safe}`);
      await fs.writeFile(filePath, Buffer.from(data, 'base64'));
      const text = await extractAttachmentText(filePath, name);
      const att: Attachment = { id, name, path: filePath, text };
      session.attachments.push(att);
      res.json({ id, name, converted: text !== null });
    }),
  );

  app.delete(
    '/api/session/:id/attachments/:attId',
    wrap(async (req, res) => {
      const session = getSession(req.params['id']);
      const attId = String(req.params['attId'] ?? '');
      const idx = session.attachments.findIndex((a) => a.id === attId);
      if (idx >= 0) {
        const removed = session.attachments.splice(idx, 1);
        removed[0] && fs.unlink(removed[0].path).catch(() => undefined);
      }
      res.json({ ok: true });
    }),
  );

  // --- documents ---------------------------------------------------------------

  app.get(
    '/api/session/:id/documents',
    wrap(async (req, res) => {
      const session = getSession(req.params['id']);
      const active = await refreshActiveDocument(session);
      res.json({
        active,
        documents: [...session.knownDocuments],
      });
    }),
  );

  /** Activate another open document inside LibreOffice (same bridge). */
  app.post(
    '/api/session/:id/documents/switch',
    wrap(async (req, res) => {
      const session = getSession(req.params['id']);
      const target = req.body?.path as string | undefined;
      if (!target) {
        res.status(400).json({ error: 'path is required' });
        return;
      }
      await session.bridge.activate(target);
      await sleep(200);
      const active = await refreshActiveDocument(session);
      res.json({ active, documents: [...session.knownDocuments] });
    }),
  );

  // --- selection -------------------------------------------------------------

  app.get(
    '/api/session/:id/selection',
    wrap(async (req, res) => {
      const session = getSession(req.params['id']);
      const sel = await readSelection(session);
      const words = sel.text ? sel.text.trim().split(/\s+/).length : 0;
      res.json({ ...sel, stats: [words] });
    }),
  );

  // --- message (unified; the agent infers the action) --------------------------

  /**
   * Streaming message: one input for everything. The agent decides the
   * intent and ends its reply with an action tag (see the Writer adapter).
   * After a document action is applied, the app re-reads the document and
   * prompts the agent again for the next edit (multi-action loop), up to
   * MAX_ACTIONS_PER_MESSAGE edits.
   *
   * SSE frames: {"text": ...} chunks, {"tool": ...} agent tool activity,
   * {"applied": action, "target": pN} per applied edit, {"appliedStep": n},
   * {"stopped": reason}, {"done": true}. Errors: {"error": ...},
   * {"cancelled": true}.
   */
  app.post('/api/session/:id/message/stream', async (req, res) => {
    const maybeSession = sessions.get(param(req.params['id']));
    if (!maybeSession) {
      res.status(404).json({ error: 'Unknown session' });
      return;
    }
    const session: Session = maybeSession;
    const message = (req.body?.message as string | undefined)?.trim();
    if (!message) {
      res.status(400).json({ error: 'message is required' });
      return;
    }

    let turnRecorded = false;
    let lastAction: AgentAction = 'none';
    let lastTarget: number | null = null;

    try {
      await refreshActiveDocument(session);
      const doc = await session.bridge.document();
      const adapter = adapterFor(doc.module);
      const contextText = adapter.buildContextBlock(doc, doc.url || null);
      const selection = await readSelection(session);
      const send = startSse(res);
      session.cancelRequested = false;

      const attachments = session.attachments;
      session.attachments = [];

      const historyPrefix = buildHistoryPrefix(session, conversationKey(session));
      const initialPrompt = buildAutoPrompt(contextText, adapter, selection, message, attachments, historyPrefix);
      if (historyPrefix) {
        session.historyHandoff.delete(conversationKey(session));
      }

      const completed: string[] = [];
      let step = 0;
      let stoppedReason: 'done' | 'none' | 'cancelled' | 'error' | 'limit' = 'done';

      while (step < MAX_ACTIONS_PER_MESSAGE) {
        step += 1;
        if (session.cancelRequested) {
          send({ cancelled: true });
          stoppedReason = 'cancelled';
          break;
        }
        let prompt: string;
        if (step === 1) {
          prompt = initialPrompt;
        } else {
          await refreshActiveDocument(session);
          const freshDoc = await session.bridge.document();
          const freshSel = await readSelection(session);
          prompt = buildContinuationPrompt(
            adapter.buildContextBlock(freshDoc, freshDoc.url || null),
            adapter,
            freshSel,
            message,
            completed,
          );
        }

        // --- prompt once, parse the action, apply it ---------------------
        const reply = await session.agent.prompt(session.id, [{ type: 'text', text: prompt }], {
          onChunk: (chunk) => send({ text: chunk, ...(step > 1 ? { step } : {}) }),
          onToolCall: (tool) => send({ tool }),
          timeoutMs: 240_000,
        });
        const outcome = parseAction(reply);

        if (step === 1) {
          await recordTurn(session, message, reply);
        } else {
          await recordActionStep(session, reply, step);
        }
        turnRecorded = true;
        lastAction = outcome.action;
        lastTarget = outcome.target;

        const noteMeta = async (result: 'applied' | 'error' | 'cancelled', error?: string) => {
          await recordTurnMeta(session, {
            action: outcome.action,
            target: outcome.target,
            result,
            ...(error ? { error } : {}),
            ...(step > 1 ? { step } : {}),
          });
        };

        if (session.cancelRequested) {
          send({ cancelled: true, ...(step > 1 ? { step } : {}) });
          await noteMeta('cancelled');
          stoppedReason = 'cancelled';
          break;
        }
        if (outcome.action === 'none' || outcome.action === 'continue') {
          send({ action: 'none', ...(step > 1 ? { step } : {}) });
          await noteMeta('applied');
          stoppedReason = 'none';
          break;
        }

        try {
          const freshDoc = step === 1 ? doc : await session.bridge.document();
          const applied = await adapter.applyAction(session.bridge, freshDoc, await readSelection(session), outcome);
          send({ applied: outcome.action, target: outcome.target, ...(step > 1 ? { step } : {}) });
          await noteMeta('applied');
          completed.push(applied.description);
          send({ appliedStep: step, action: outcome.action, target: outcome.target });
        } catch (e) {
          const message2 = e instanceof Error ? e.message : String(e);
          send({ error: message2, ...(step > 1 ? { step } : {}) });
          await noteMeta('error', message2);
          stoppedReason = 'error';
          break;
        }
      }

      if (step >= MAX_ACTIONS_PER_MESSAGE && stoppedReason === 'done') {
        stoppedReason = 'limit';
        send({
          text: `\nStopped after ${MAX_ACTIONS_PER_MESSAGE} document edits (safety limit). Send "continue" to apply more edits.`,
        });
      }
      send({ stopped: stoppedReason, appliedCount: completed.length });
      send({ done: true });
      res.end();
    } catch (err) {
      const message2 = err instanceof Error ? err.message : String(err);
      logError('[api] message/stream', err);
      if (!res.headersSent) {
        res.status(err instanceof BridgeError ? 503 : 500).json({ error: message2 });
      } else {
        sseFail(res, err);
      }
      if (turnRecorded) {
        await recordTurnMeta(session, {
          action: lastAction,
          target: lastTarget,
          result: lastAction === 'none' ? 'applied' : 'error',
          error: message2,
        }).catch(() => undefined);
      }
    }
  });

  // --- undo --------------------------------------------------------------------

  app.post(
    '/api/session/:id/undo',
    wrap(async (req, res) => {
      const session = getSession(req.params['id']);
      const r = await session.bridge.undo();
      res.json({ ok: r.undone, ...(r.undone ? {} : { reason: r.reason ?? 'nothing to undo' }) });
    }),
  );

  // --- helpers -------------------------------------------------------------------

  function param(id: string | string[] | undefined): string {
    return Array.isArray(id) ? (id[0] ?? '') : (id ?? '');
  }

  function getSession(id: string | string[] | undefined): Session {
    const session = sessions.get(param(id));
    if (!session) throw new Error('Unknown session');
    return session;
  }

  /** Re-read the active document from the bridge and track it. */
  async function refreshActiveDocument(session: Session): Promise<string | null> {
    const st = await session.bridge.status();
    if (!st.active) {
      session.activeDoc = null;
      await ensureConversation(session, UNSAVED_KEY);
      return null;
    }
    session.activeDoc = { url: st.url ?? '', title: st.title ?? '', module: st.module ?? 'unknown' };
    const key = st.url || st.title || UNSAVED_KEY;
    if (key !== UNSAVED_KEY) session.knownDocuments.add(key);
    await ensureConversation(session, key);
    return key;
  }

  function conversationKey(session: Session): string {
    const doc = session.activeDoc;
    if (!doc) return UNSAVED_KEY;
    return doc.url || doc.title || UNSAVED_KEY;
  }

  async function ensureConversation(session: Session, key: string): Promise<Turn[]> {
    let turns = session.conversations.get(key);
    if (!turns) {
      turns = [];
      session.conversations.set(key, turns);
      if (options.historyDir) {
        try {
          const loaded = await loadHistory(options.historyDir, key);
          turns.push(...loaded);
          session.historyHandoff.set(key, loaded.length);
        } catch {
          /* unreadable history — start empty */
        }
      }
    }
    return turns;
  }

  function buildHistoryPrefix(session: Session, key: string): string {
    const turns = session.conversations.get(key) ?? [];
    return formatHistoryReplay(turns, session.historyHandoff.get(key) ?? 0);
  }

  async function recordTurn(session: Session, user: string, assistant: string) {
    const key = conversationKey(session);
    const turns = await ensureConversation(session, key);
    turns.push(
      { role: 'user', content: user, timestamp: new Date().toISOString() },
      { role: 'assistant', content: assistant, timestamp: new Date().toISOString() },
    );
    if (options.historyDir) {
      saveHistory(options.historyDir, key, turns).catch((e) => logError('[history] save failed', e));
    }
  }

  async function recordActionStep(session: Session, assistant: string, _step: number) {
    const key = conversationKey(session);
    const turns = await ensureConversation(session, key);
    turns.push({ role: 'assistant', content: assistant, timestamp: new Date().toISOString() });
    if (options.historyDir) {
      saveHistory(options.historyDir, key, turns).catch((e) => logError('[history] save failed', e));
    }
  }

  async function sessionInfo(session: Session) {
    const docKey = await refreshActiveDocument(session);
    let outline = '';
    let layout: string | null = null;
    let conversation: Turn[] = [];
    try {
      const doc = await session.bridge.document();
      const adapter = adapterFor(doc.module);
      outline = adapter.renderOutline?.(doc) ?? '';
      layout = doc.cursorStyle ?? null;
      conversation = session.conversations.get(conversationKey(session)) ?? [];
    } catch {
      /* bridge may be between documents; report what we have */
    }
    return {
      sessionId: session.id,
      documentPath: docKey,
      documents: [...session.knownDocuments],
      layout,
      outline,
      conversation,
    };
  }

  async function readSelection(session: Session): Promise<SelectionInfo> {
    const doc = await session.bridge.document();
    const texts = doc.selection ?? null;
    const text = texts && texts.length > 0 ? texts.join('\n') : null;
    return {
      hasSelection: Boolean(text && text.length > 0),
      text,
      cursorStyle: doc.cursorStyle ?? null,
    };
  }

  return app;
}

// --- action parsing -----------------------------------------------------------

/** Tag grammar: [ACTION: name] or [ACTION: name pN], with a ```writer block. */
export function parseAction(reply: string): ActionOutcome {
  // The agent sometimes echoes tags while explaining; the LAST tag is the
  // operative one (the instructions demand it be the reply's last line).
  const tags = [...reply.matchAll(
    /\[ACTION:\s*(delete-at|rewrite-at|insert-after|insert-top|rewrite|insert|none|continue)(?:\s+p(\d+))?\s*\]/gi,
  )];
  const m = tags[tags.length - 1];
  const action = ((m?.[1] ?? 'none').toLowerCase() as AgentAction);
  const target = m?.[2] ? Number.parseInt(m[2], 10) : null;
  const contentActions: AgentAction[] = ['insert', 'insert-top', 'insert-after', 'rewrite', 'rewrite-at'];
  const needsContent = contentActions.includes(action);
  const rawBlock = needsContent ? extractContentBlock(reply) : null;
  return {
    action,
    target,
    block: needsContent ? (rawBlock !== null ? parseContentBlock(rawBlock) : null) : null,
  };
}

// --- prompt building ------------------------------------------------------------

const CHAT_KNOWLEDGE = [
  'ADDRESSING AND EDITS',
  '- The document context lists paragraphs as [pN] ids with their styles.',
  '- Edits are applied to the LIVE document as tracked changes (the user',
  '  accepts or rejects them in Edit > Track Changes), and each edit is a',
  '  single undo step.',
  '- Pending tracked changes are part of the context: text the user has not',
  '  accepted yet may still appear (deleted text can remain visible in the',
  '  context as struck-through content). Do not re-delete or re-edit text',
  '  that a previous edit already removed; the changes are waiting for the',
  '  user, not lost.',
  '- Content for actions goes in ONE ```writer fenced block (markdown-lite).',
].join('\n');

export function buildAutoPrompt(
  contextText: string,
  adapter: ModuleAdapter,
  selection: SelectionInfo,
  message: string,
  attachments: Attachment[] = [],
  historyPrefix = '',
): string {
  const parts: string[] = [
    'You are assisting an author writing a document in LibreOffice. Your ' +
      'reply is shown in a chat panel, and you can also write content ' +
      'directly into the live LibreOffice document.',
    '',
    adapter.buildActionInstructions(),
    '',
    CHAT_KNOWLEDGE,
    '',
    contextText,
  ];
  const selBlock = adapter.buildSelectionBlock(selection);
  if (selBlock) parts.push(selBlock);
  if (historyPrefix) parts.push(historyPrefix);
  parts.push('', 'User message:', message);
  if (attachments.length > 0) {
    parts.push(
      '',
      'Attached files (reference material the user attached for this ' +
        'message; the ACTIVE document you may edit is only the one ' +
        'described above — never write into the attachments):',
    );
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
  }
  return parts.join('\n');
}

export function buildContinuationPrompt(
  contextText: string,
  adapter: ModuleAdapter,
  selection: SelectionInfo,
  originalMessage: string,
  completed: string[],
): string {
  const parts = [
    'You are continuing the SAME user request after one edit was applied ' +
      'to the live LibreOffice document. The document context below is ' +
      'FRESH: paragraph addresses ([pN]) may have shifted because of the edit.',
    '',
    'Original user request:', originalMessage,
    '',
    'Edits already applied (do not repeat them):',
    ...completed.map((entry) => `- ${entry}`),
    '',
    'If the request needs MORE edits, END your reply with exactly one ' +
      'document action tag from the action list on its own last line, and ' +
      'include the ```writer block when the action needs content.',
    'If the request is now complete, reply in prose only and end with [ACTION: none].',
    'If you are not sure whether more edits remain, ask one short question ' +
      'with [ACTION: none] instead of guessing.',
    `The app enforces a safety limit of ${MAX_ACTIONS_PER_MESSAGE} document ` +
      'edits per user message; if that limit is reached it stops and tells ' +
      'the user, who can ask you to continue in a follow-up message.',
    '',
    adapter.buildActionInstructions(),
    '',
    CHAT_KNOWLEDGE,
    '',
    contextText,
  ];
  const selBlock = adapter.buildSelectionBlock(selection);
  if (selBlock) parts.push(selBlock);
  return parts.join('\n');
}

export function formatHistoryReplay(turns: Turn[], unseen: number): string {
  const count = Math.min(Math.max(0, unseen), turns.length, HISTORY_REPLAY_LIMIT);
  if (count <= 0) return '';
  const lines: string[] = [
    'Conversation so far (earlier turns, replayed because the app was restarted — you have no memory of these):',
    'The user can see this history; treat it as context, not as a request to continue anything.',
  ];
  for (const turn of turns.slice(0, count)) {
    const label = turn.role === 'user' ? 'User' : 'You';
    let text = (turn.content ?? '')
      .replace(/```writer[\s\S]*?```/g, '')
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
        lines.push(`  (applied [ACTION: ${m.action}${m.target ? ` p${m.target}` : ''}] in the document)`);
      } else if (m.result === 'error') {
        lines.push(`  (action ${m.action} FAILED: ${m.error ?? 'unknown error'})`);
      } else if (m.result === 'cancelled') {
        lines.push(`  (action ${m.action} was cancelled before applying)`);
      }
    }
  }
  return '\n' + lines.join('\n');
}

// --- attachments -----------------------------------------------------------------

const ATTACHMENT_TEXT_LIMIT = 40_000;
const TEXTUAL_FILE = /\.(txt|md|markdown|odt|fodt|csv|tsv|json|xml|bib|log|html?|yaml|yml|py|js|ts)$/i;

export async function extractAttachmentText(
  filePath: string,
  name: string,
): Promise<string | null> {
  if (TEXTUAL_FILE.test(name)) {
    try {
      const raw = await fs.readFile(filePath, 'utf8');
      return raw.slice(0, ATTACHMENT_TEXT_LIMIT);
    } catch {
      return null;
    }
  }
  for (const command of markitdownCandidates()) {
    try {
      const quoted = command.includes(' ') ? `"${command.replace(/"/g, '')}"` : command;
      const out = await runCommand(`${quoted} "${filePath}"`, 60_000);
      if (out.trim()) return out.slice(0, ATTACHMENT_TEXT_LIMIT);
    } catch {
      /* try the next converter */
    }
  }
  return null;
}

function markitdownCandidates(): string[] {
  const candidates: string[] = [];
  if (process.env.LO_MARKITDOWN) candidates.push(process.env.LO_MARKITDOWN);
  candidates.push('markitdown', 'uvx markitdown');
  if (process.platform === 'win32') {
    candidates.push(
      path.join(os.homedir(), '.local', 'venvs', 'markitdown-mcp', 'Scripts', 'markitdown.exe'),
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

// --- history persistence ------------------------------------------------------------

export async function listKnownDocuments(historyDir: string): Promise<string[]> {
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
      keys.push(key);
    } catch {
      /* unreadable entry — skip */
    }
  }
  return keys;
}

function historyFile(dir: string, key: string): string {
  const hash = createHash('sha256').update(key).digest('hex').slice(0, 16);
  return path.join(dir, `${hash}.json`);
}

async function loadHistory(dir: string, key: string): Promise<Turn[]> {
  try {
    const raw = await fs.readFile(historyFile(dir, key), 'utf8');
    const data = JSON.parse(raw) as { key?: string; turns: Turn[] };
    if (data.key !== key) return [];
    return Array.isArray(data.turns) ? data.turns : [];
  } catch {
    return [];
  }
}

async function saveHistory(dir: string, key: string, turns: Turn[]): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(historyFile(dir, key), JSON.stringify({ key, turns }, null, 2), 'utf8');
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}