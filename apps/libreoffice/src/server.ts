/**
 * Express API + session orchestration for the LibreOffice ACP companion.
 *
 * One session = one bridge (one LibreOffice instance) + one ACP agent.
 * Documents are tracked dynamically: every request re-reads the bridge's
 * active document; conversations are keyed per document URL. All reads
 * and writes go through the in-LibreOffice bridge (extension/) — the
 * bridge is the only thing that touches UNO, and LibreOffice remains the
 * single writer of truth.
 */

import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import express from 'express';
import {
  BridgeClient,
  BridgeError,
  discoverBridges,
} from './bridge/client.js';
import {
  findUnopkg,
  installBridge,
  sofficeRunning,
  type InstallResult,
} from './bridge/install.js';
import { writerAdapter } from './modules/writer.js';
import { calcAdapter, parseCalcAction } from './modules/calc.js';
import { impressAdapter, parseImpressAction } from './modules/impress.js';
import { genericAdapter } from './modules/generic.js';
import type { ModuleAdapter, AgentAction, ActionOutcome, SelectionInfo } from './modules/types.js';
import { extractContentBlock, parseContentBlock, ACTION_HEADER, actionTagNote } from './modules/markdown.js';
import {
  AcpClient,
  UNSAVED_KEY,
  createAgentSettings,
  createConversationStore,
  createLogError,
  extractAttachmentText as coreExtractAttachmentText,
  formatHistoryReplay as coreFormatHistoryReplay,
  listKnownDocuments,
  registerAttachmentRoutes,
  registerSessionRoutes,
  startSse,
  sseFail,
  MAX_ACTIONS_PER_MESSAGE,
  sleep,
  type ConversationStore,
} from '@acp-assist/core';
import type {
  AgentRunner,
  AgentSettings,
  Attachment,
  Turn,
  TurnMeta,
} from '@acp-assist/core';

export type {
  AgentSettings,
  Turn,
  TurnMeta,
  AgentRunner,
  Attachment,
} from '@acp-assist/core';
export { listKnownDocuments } from '@acp-assist/core';

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
  /** Bridge .oxt for one-click install (absent = the flow is disabled). */
  oxtPath?: string;
  /** Test hook: override the unopkg probe (null = not found). */
  unopkgPath?: string | null;
  /** Test hook: override the running-LibreOffice probe. */
  sofficeProbe?: () => Promise<boolean>;
  /** Test hook: replace the real unopkg run. */
  installBridge?: (unopkgPath: string, oxtPath: string) => Promise<InstallResult>;
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

  const logError = createLogError(options.logDir);

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

  // --- adapter selection ---------------------------------------------------

  function adapterFor(module: string): ModuleAdapter {
    if (module === 'writer') return writerAdapter;
    if (module === 'calc') return calcAdapter;
    if (module === 'impress' || module === 'draw') return impressAdapter;
    return genericAdapter;
  }

  /** Parse one agent reply with the active adapter's action grammar. */
  function parseOutcome(adapter: ModuleAdapter, reply: string): ActionOutcome {
    if (adapter.id === 'calc') return parseCalcAction(reply);
    if (adapter.id === 'impress') return parseImpressAction(reply);
    return parseAction(reply);
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

  // --- bridge extension install (one-click; touches the REAL profile) ----

  app.get(
    '/api/bridge/install/preflight',
    wrap(async (_req, res) => {
      if (!options.oxtPath) {
        res.json({ canInstall: false, reason: 'extension package not configured' });
        return;
      }
      let oxtFound = false;
      try {
        await fs.access(options.oxtPath);
        oxtFound = true;
      } catch {
        oxtFound = false;
      }
      if (!oxtFound) {
        res.json({ canInstall: false, reason: `extension package not found at ${options.oxtPath}` });
        return;
      }
      const unopkg = options.unopkgPath !== undefined ? options.unopkgPath : findUnopkg();
      if (!unopkg) {
        res.json({ canInstall: false, reason: 'unopkg not found — is LibreOffice installed?' });
        return;
      }
      res.json({
        canInstall: true,
        unopkg,
        sofficeRunning: options.sofficeProbe ? await options.sofficeProbe() : await sofficeRunning(),
      });
    }),
  );

  app.post(
    '/api/bridge/install',
    wrap(async (_req, res) => {
      if (!options.oxtPath) throw new Error('Extension install is not configured (missing oxt path).');
      const unopkg = options.unopkgPath !== undefined ? options.unopkgPath : findUnopkg();
      if (!unopkg) throw new Error('unopkg not found — install LibreOffice first.');
      const running = options.sofficeProbe ? await options.sofficeProbe() : await sofficeRunning();
      if (running) {
        res.status(409).json({ error: 'LibreOffice is running. Close it first, then retry.' });
        return;
      }
      const run = options.installBridge ?? installBridge;
      const result = await run(unopkg, options.oxtPath);
      if (!result.ok) {
        res.status(500).json({ error: result.message, steps: result.steps });
        return;
      }
      res.json(result);
    }),
  );

  const agentSettings = createAgentSettings(options.settingsDir);
  agentSettings.register(app, wrap);

  // --- session ---------------------------------------------------------------

  app.post(
    '/api/session',
    wrap(async (req, res) => {
      const persisted = await agentSettings.read();
      const requested = req.body?.agent as Partial<AgentSettings> | undefined;
      const settings: AgentSettings = {
        command: requested?.command ?? persisted.command ?? 'vibe-acp',
        args: requested?.args ?? persisted.args ?? [],
        env: requested?.env ?? persisted.env ?? {},
      };

      const bridge = options.bridgeFactory
        ? options.bridgeFactory()
        : await pickBridge();
      const agent: AgentRunner = options.agentFactory
        ? options.agentFactory(settings)
        : new AcpClient({
            ...settings,
            appName: 'libreoffice-acp-assist',
            writerName: 'LibreOffice',
          });
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

      // First connect: the panel shows an outline-aware welcome message.
      res.json(await sessionInfo(session, { outline: true }));
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

  registerSessionRoutes(app, wrap, {
    getSession,
    sessions,
    sessionInfo,
  });

  // --- attachments -----------------------------------------------------------

  registerAttachmentRoutes(app, wrap, {
    attachmentsDir: options.attachmentsDir,
    getSession,
    extractText: extractAttachmentText,
  });

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
    let lastAddress: string | null = null;

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
        const outcome = parseOutcome(adapter, reply);

        if (step === 1) {
          await recordTurn(session, message, reply);
        } else {
          await recordActionStep(session, reply, step);
        }
        turnRecorded = true;
        lastAction = outcome.action;
        lastTarget = outcome.target;
        lastAddress = outcome.address;

        const noteMeta = async (result: 'applied' | 'error' | 'cancelled', error?: string) => {
          await recordTurnMeta(session, {
            action: outcome.action,
            target: outcome.target,
            address: outcome.address,
            module: adapter.id === 'generic' ? 'other' : adapter.id,
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
          send({ action: 'none', ...(outcome.tagNote ? { tagNote: outcome.tagNote } : {}), ...(step > 1 ? { step } : {}) });
          await noteMeta('applied');
          stoppedReason = 'none';
          break;
        }

        try {
          const freshDoc = step === 1 ? doc : await session.bridge.document();
          const applied = await adapter.applyAction(session.bridge, freshDoc, await readSelection(session), outcome);
          send({
            applied: outcome.action,
            target: outcome.target,
            address: outcome.address,
            module: adapter.id === 'generic' ? 'other' : adapter.id,
            ...(outcome.tagNote ? { tagNote: outcome.tagNote } : {}),
            ...(step > 1 ? { step } : {}),
          });
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
      // History writes are debounced in the shared store; flush before the
      // stream closes so a completed run is always on disk when the UI
      // sees `done`.
      await storeFor(session).flush().catch(() => undefined);
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
          address: lastAddress,
          result: lastAction === 'none' ? 'applied' : 'error',
          error: message2,
        }).catch(() => undefined);
        await storeFor(session).flush().catch(() => undefined);
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

  const storeBySession = new WeakMap<Session, ConversationStore>();
  function storeFor(session: Session): ConversationStore {
    let store = storeBySession.get(session);
    if (!store) {
      store = createConversationStore({
        historyDir: options.historyDir,
        logError,
        conversations: session.conversations,
        historyHandoff: session.historyHandoff,
        keyOf: () => conversationKey(session),
        replayOptions: LO_REPLAY_OPTIONS,
      });
      storeBySession.set(session, store);
    }
    return store;
  }

  async function ensureConversation(session: Session, key: string): Promise<Turn[]> {
    return storeFor(session).ensure(key);
  }

  function buildHistoryPrefix(session: Session, key: string): string {
    return storeFor(session).buildHistoryPrefix(key);
  }

  async function recordTurn(session: Session, user: string, assistant: string) {
    return storeFor(session).recordTurn(user, assistant);
  }

  async function recordActionStep(session: Session, assistant: string, _step: number) {
    return storeFor(session).recordActionStep(assistant, _step);
  }

  /**
   * Record the outcome of the action the assistant proposed in the LAST
   * turn, so a failed or successful document action survives a restart.
   */
  async function recordTurnMeta(session: Session, meta: TurnMeta): Promise<void> {
    return storeFor(session).recordTurnMeta(meta);
  }

  /**
   * GET response body. By default the expensive full `/document` read is
   * skipped: the panel's refresh chain calls this after every message and
   * never displays the outline. `outline: true` (session creation,
   * `?outline=1`) fetches it.
   */
  async function sessionInfo(session: Session, opts: { outline?: boolean } = {}) {
    const docKey = await refreshActiveDocument(session);
    let outline = '';
    let layout: string | null = null;
    let conversation: Turn[] = session.conversations.get(conversationKey(session)) ?? [];
    if (opts.outline) {
      try {
        const doc = await session.bridge.document();
        const adapter = adapterFor(doc.module);
        outline = adapter.renderOutline?.(doc) ?? '';
        layout = doc.cursorStyle ?? null;
      } catch {
        /* bridge may be between documents; report what we have */
      }
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
    const text = texts && texts.length > 0 && typeof texts[0] === 'string'
      ? (texts as string[]).join('\n')
      : null;
    // Impress/Draw reuse the bridge's "selection" key with a different
    // payload shape: selected frames as {slide, shape, kind, text}.
    const slidesSelection =
      doc.module === 'impress' || doc.module === 'draw'
        ? ((doc.selection ?? null) as SelectionInfo['slidesSelection'])
        : null;
    return {
      hasSelection: Boolean(doc.calc?.selection || slidesSelection?.length || (text && text.length > 0)),
      text,
      cursorStyle: doc.cursorStyle ?? null,
      calc: doc.calc ?? null,
      slidesSelection,
    };
  }

  return app;
}

// --- action parsing -----------------------------------------------------------

/** Tag grammar: [ACTION: name] or [ACTION: name pN], with a ```writer block.
 * The header tolerates tag typos ("[AACTION:", doubled letters) and a
 * missing colon — tagNote reports the auto-correction. */
const ACTION_TAG_RE = new RegExp(
  `${ACTION_HEADER}\\s*(delete-at|rewrite-at|insert-after|insert-top|rewrite|insert|none|continue)(?:\\s+p(\\d+))?\\s*\\]`,
  'gi',
);

export function parseAction(reply: string): ActionOutcome {
  // The agent sometimes echoes tags while explaining; the LAST tag is the
  // operative one (the instructions demand it be the reply's last line).
  const tags = [...reply.matchAll(ACTION_TAG_RE)];
  const m = tags[tags.length - 1];
  const action = ((m?.[1] ?? 'none').toLowerCase() as AgentAction);
  const target = m?.[2] ? Number.parseInt(m[2], 10) : null;
  const contentActions: AgentAction[] = ['insert', 'insert-top', 'insert-after', 'rewrite', 'rewrite-at'];
  const needsContent = contentActions.includes(action);
  const rawBlock = needsContent ? extractContentBlock(reply) : null;
  return {
    action,
    target,
    address: null,
    block: needsContent ? (rawBlock !== null ? parseContentBlock(rawBlock) : null) : null,
    grid: null,
    tagNote: actionTagNote(m?.[0], `[ACTION: ${action}${target !== null ? ` p${target}` : ''}]`),
  };
}

// --- prompt building ------------------------------------------------------------

const CHAT_KNOWLEDGE = [
  'ADDRESSING AND EDITS',
  '- Edits are applied to the LIVE document as tracked changes (the user',
  '  accepts or rejects them in Edit > Track Changes), and each edit is a',
  '  single undo step.',
  '- Pending tracked changes are part of the context: content the user has',
  '  not accepted yet may still appear there. Do not re-delete or re-edit',
  '  content a previous edit already removed; the changes are waiting for',
  '  the user, not lost.',
  '- Content for actions goes in ONE fenced content block; the action',
  '  instructions above name its language (```writer or ```calc).',
].join('\n');

/** Impress/Draw have no change tracking: edits are undo-only. */
const SLIDES_CHAT_KNOWLEDGE = [
  'ADDRESSING AND EDITS',
  '- Edits are applied to the LIVE document. These modules have no change',
  '  tracking: each edit is a single undo step the user can revert with the',
  '  app\u2019s Undo button.',
  '- Content for actions goes in ONE fenced content block; the action',
  '  instructions above name its language (```impress).',
].join('\n');

function chatKnowledge(adapter: ModuleAdapter): string {
  return adapter.id === 'impress' ? SLIDES_CHAT_KNOWLEDGE : CHAT_KNOWLEDGE;
}

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
    chatKnowledge(adapter),
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
      'include the content block when the action needs content.',
    'If the request is now complete, reply in prose only and end with [ACTION: none].',
    'If you are not sure whether more edits remain, ask one short question ' +
      'with [ACTION: none] instead of guessing.',
    `The app enforces a safety limit of ${MAX_ACTIONS_PER_MESSAGE} document ` +
      'edits per user message; if that limit is reached it stops and tells ' +
      'the user, who can ask you to continue in a follow-up message.',
    '',
    adapter.buildActionInstructions(),
    '',
    chatKnowledge(adapter),
    '',
    contextText,
  ];
  const selBlock = adapter.buildSelectionBlock(selection);
  if (selBlock) parts.push(selBlock);
  return parts.join('\n');
}

/** Replay rendering shared by the history wrapper and the conversation store. */
const LO_REPLAY_OPTIONS = {
  blockPattern: /```(?:writer|calc|impress)[\s\S]*?```/g,
  describeTarget: (m: TurnMeta) =>
    m.target ? ` p${m.target}` : m.address ? ` ${m.address}` : '',
};

export function formatHistoryReplay(turns: Turn[], unseen: number): string {
  return coreFormatHistoryReplay(turns, unseen, LO_REPLAY_OPTIONS);
}

// --- attachments -----------------------------------------------------------------

/** Extensions the app can read as text directly (no converter needed). */
const TEXTUAL_FILE = /\.(txt|md|markdown|odt|fodt|csv|tsv|json|xml|bib|log|html?|yaml|yml|py|js|ts)$/i;

export async function extractAttachmentText(
  filePath: string,
  name: string,
): Promise<string | null> {
  return coreExtractAttachmentText(filePath, name, {
    textualFile: TEXTUAL_FILE,
    markitdownEnv: process.env.LO_MARKITDOWN,
  });
}

