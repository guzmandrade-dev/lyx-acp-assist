/**
 * Express API + session orchestration for the LibreOffice ACP companion.
 *
 * One session = one bridge (one LibreOffice instance) + one ACP agent.
 * Documents are tracked dynamically: every request re-reads the bridge's
 * active document; conversations are keyed per document URL. All reads
 * and writes go through the in-LibreOffice bridge (extension/) — the
 * bridge is the only thing that touches UNO, and LibreOffice remains the
 * single writer of truth.
 *
 * Phase B2 (audit Track D): the session lifecycle, shared routes, and
 * the multi-action message loop live in core `createCompanionServer`;
 * this file is the app's `CompanionBackend` (bridge + module adapters)
 * plus the LO-only bridge-extension install routes.
 */

import fs from 'node:fs/promises';
import express from 'express';
import {
  BridgeClient,
  BridgeError,
  discoverBridges,
  type BridgeDocument,
} from './bridge/client.js';
import {
  findUnopkg,
  installBridge,
  sofficeRunning,
  type InstallResult,
} from './bridge/install.js';
import { writerAdapter } from './modules/writer.js';
import { TIMINGS } from './timings.js';
import { calcAdapter, parseCalcAction } from './modules/calc.js';
import { impressAdapter, parseImpressAction } from './modules/impress.js';
import { genericAdapter } from './modules/generic.js';
import type { ModuleAdapter, AgentAction, ActionOutcome, SelectionInfo } from './modules/types.js';
import { extractContentBlock, parseContentBlock } from './modules/markdown.js';
import {
  actionTagNote,
  buildAttachmentBlock,
  createAttachmentExtractor,
  createLogError,
  createParseActionTag,
  createWrap,
  createCompanionServer,
  MAX_ACTIONS_PER_MESSAGE,
  pollUntil,
  sleep,
  UNSAVED_KEY,
  formatHistoryReplay as coreFormatHistoryReplay,
  type AppliedResult,
  type CompanionBackend,
  type CompanionSession,
  type ReadStepResult,
  type AgentSettings,
  type AgentRunner,
  type Attachment,
  type Turn,
  type TurnMeta,
} from '@acp-assist/core';
import { panelPublicDir, type PanelConfig } from '@acp-assist/panel';

export type {
  AgentSettings,
  Turn,
  TurnMeta,
  AgentRunner,
  Attachment,
} from '@acp-assist/core';
export { listKnownDocuments } from '@acp-assist/core';

export interface ServerOptions {
  /**
   * The SHARED panel package's public dir (defaults to panelPublicDir()).
   * Track C: one panel, config-injected.
   */
  publicDir?: string;
  /**
   * Per-app asset overrides served BEFORE the shared panel dir (e.g. the
   * app's own logo.svg).
   */
  assetsDir?: string;
  /** Panel config (Track C): injected into the served index.html. */
  panelConfig: PanelConfig;
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
  /**
   * Test hook: how a stale bridge is recovered (default: pickBridge).
   * See createHealingBridge (audit B3).
   */
  recoverBridge?: (failed: BridgeClient) => Promise<BridgeClient>;
  /**
   * API bearer token (audit B1). Generated at boot when absent; exposed as
   * `app.locals.apiToken` for the companion record writers / dev tools.
   */
  apiToken?: string;
  /** Idle-session GC (audit B2); see createCompanionServer. */
  sessionIdleMs?: number;
}

/** The app backend's per-session state (opaque to the core server). */
interface LoState {
  /** The healing proxy (audit B3) around this session's bridge. */
  bridge: BridgeClient;
  /** Active document {url,title,module}; refreshed from the bridge. */
  activeDoc: { url: string; title: string; module: string } | null;
}

/** One step's data: ONE /document read serves the whole step. */
interface LoStepData {
  doc: BridgeDocument;
  adapter: ModuleAdapter;
  contextText: string;
  selection: SelectionInfo;
}

export function createServer(options: ServerOptions & {
  /** Test hook: inject a fake agent process instead of spawning one. */
  agentFactory?: (settings: AgentSettings) => AgentRunner;
  /** Test hook: inject a fake bridge client instead of discovery. */
  bridgeFactory?: () => BridgeClient;
}) {
  const app = createCompanionServer({
    panelConfig: options.panelConfig,
    publicDir: options.publicDir ?? panelPublicDir(),
    assetsDir: options.assetsDir,
    historyDir: options.historyDir,
    attachmentsDir: options.attachmentsDir,
    logDir: options.logDir,
    settingsDir: options.settingsDir,
    apiToken: options.apiToken,
    sessionIdleMs: options.sessionIdleMs,
    extractText: extractAttachmentText,
    backend: createLoBackend(options),
    agentFactory: options.agentFactory,
  });
  registerInstallRoutes(app, options);
  return app;
}

/** The LibreOffice backend: bridge + module adapters behind the contract. */
function createLoBackend(
  options: ServerOptions & {
    agentFactory?: (settings: AgentSettings) => AgentRunner;
    bridgeFactory?: () => BridgeClient;
  },
): CompanionBackend<LoState, ActionOutcome> {
  const logError = createLogError(options.logDir);

  // --- bridge discovery / healing (audit B3) ------------------------------

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

  /**
   * Audit B3: a session pinned its bridge record forever — restarting the
   * bridge from the LO sidebar (new port + token) broke the session until
   * a manual reconnect. This proxy wraps EVERY bridge call: on a
   * BridgeError it re-discovers once (default pickBridge), swaps the
   * target, and retries once. Non-bridge errors pass straight through,
   * and the fake-bridge tests are unaffected (their errors are not
   * BridgeErrors).
   */
  function createHealingBridge(initial: BridgeClient): BridgeClient {
    let target = initial;
    const recover = options.recoverBridge ?? pickBridge;
    return new Proxy(initial, {
      get(_t, prop) {
        const value = Reflect.get(target, prop, target);
        if (typeof value !== 'function') return value;
        return async (...args: unknown[]) => {
          try {
            return await (value as (...a: unknown[]) => unknown).apply(target, args);
          } catch (e) {
            if (!(e instanceof BridgeError)) throw e;
            target = await recover(target);
            const fresh = Reflect.get(target, prop, target);
            return (fresh as (...a: unknown[]) => unknown).apply(target, args);
          }
        };
      },
    }) as BridgeClient;
  }

  // --- document bookkeeping ------------------------------------------------

  /** Re-read the active document from the bridge and track it. */
  async function refreshActiveDocument(session: CompanionSession<LoState>): Promise<string | null> {
    const st = await session.state.bridge.status();
    return refreshFromStatus(session, st.active, st.url ?? '', st.title ?? '', st.module ?? 'unknown');
  }

  /**
   * Same bookkeeping as refreshActiveDocument, but from an already-fetched
   * `/document` payload (it carries active/module/title/url too) — avoids
   * the extra `/status` round-trip in the message loop.
   */
  async function refreshFromDocument(session: CompanionSession<LoState>, doc: BridgeDocument): Promise<string | null> {
    return refreshFromStatus(session, doc.active, doc.url ?? '', doc.title ?? '', doc.module ?? 'unknown');
  }

  async function refreshFromStatus(
    session: CompanionSession<LoState>,
    active: boolean,
    url: string,
    title: string,
    module: string,
  ): Promise<string | null> {
    if (!active) {
      session.state.activeDoc = null;
      await session.ensureConversation(UNSAVED_KEY);
      return null;
    }
    session.state.activeDoc = { url, title, module };
    const key = url || title || UNSAVED_KEY;
    if (key !== UNSAVED_KEY) session.knownDocuments.add(key);
    await session.ensureConversation(key);
    return key;
  }

  return {
    acp: { appName: 'libreoffice-acp-assist', writerName: 'LibreOffice' },
    mapStatus: (err) => (err instanceof BridgeError ? 503 : 500),
    promptTimeoutMs: TIMINGS.promptTimeoutMs,
    replayOptions: LO_REPLAY_OPTIONS,

    async createSessionState() {
      return {
        bridge: options.bridgeFactory
          ? createHealingBridge(options.bridgeFactory())
          : createHealingBridge(await pickBridge()),
        activeDoc: null,
      };
    },

    conversationKey(session) {
      return conversationKeyOf(session);
    },

    async statusSummary() {
      if (options.bridgeFactory) {
        // Test hook: a fake bridge is injected; discovery is bypassed.
        return { bridgeAvailable: true };
      }
      try {
        return { bridgeAvailable: (await discoverBridges()).length > 0 };
      } catch (e) {
        logError('[api] status', e);
        return { bridgeAvailable: false };
      }
    },

    async documents(session) {
      const active = await refreshActiveDocument(session);
      return { active, documents: [...session.knownDocuments] };
    },

    async switchDocument(session, target) {
      await session.state.bridge.activate(target);
      // Wait until the switch actually landed (bounded poll instead of a
      // fixed sleep); on timeout fall through and report what is active.
      await pollUntil(
        async () => {
          const st = await session.state.bridge.status();
          return st.active && (st.url === target || st.title === target);
        },
        { timeoutMs: TIMINGS.documentSwitchPollMs, intervalMs: TIMINGS.pollIntervalMs },
      );
      const active = await refreshActiveDocument(session);
      return { active, documents: [...session.knownDocuments] };
    },

    async selection(session) {
      const sel = readSelection(await session.state.bridge.document());
      const words = sel.text ? sel.text.trim().split(/\s+/).length : 0;
      return { ...sel, stats: [words] };
    },

    async undo(session) {
      const r = await session.state.bridge.undo();
      return { ok: r.undone, ...(r.undone ? {} : { reason: r.reason ?? 'nothing to undo' }) };
    },

    async sessionInfo(session, opts) {
      const docKey = await refreshActiveDocument(session);
      let outline = '';
      let layout: string | null = null;
      let conversation: Turn[] = session.conversations.get(conversationKeyOf(session)) ?? [];
      if (opts.outline) {
        try {
          const doc = await session.state.bridge.document();
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
    },

    async readStep(session): Promise<ReadStepResult<LoStepData>> {
      // ONE /document read serves the whole step: session bookkeeping
      // (active/module/url — /document carries everything /status does),
      // context building, and the selection.
      const doc = await session.state.bridge.document();
      await refreshFromDocument(session, doc);
      const adapter = adapterFor(doc.module);
      return {
        data: {
          doc,
          adapter,
          contextText: adapter.buildContextBlock(doc, doc.url || null),
          selection: readSelection(doc),
        },
      };
    },

    async buildAutoPrompt(_session, stepData, message, attachments, historyPrefix) {
      const s = stepData as LoStepData;
      return buildAutoPrompt(s.contextText, s.adapter, s.selection, message, attachments, historyPrefix);
    },

    async buildContinuationPrompt(_session, stepData, originalMessage, completed) {
      const s = stepData as LoStepData;
      return buildContinuationPrompt(s.contextText, s.adapter, s.selection, originalMessage, completed);
    },

    parseAction(_session, reply, stepData) {
      return parseOutcome((stepData as LoStepData).adapter, reply);
    },

    async applyAction(session, outcome, stepData): Promise<AppliedResult> {
      const s = stepData as LoStepData;
      const applied = await s.adapter.applyAction(session.state.bridge, s.doc, s.selection, outcome);
      return { ok: true, description: applied.description, target: outcome.target };
    },

    frame(_session, ctx) {
      const outcome = ctx.outcome;
      const step = ctx.step;
      const stepField = step > 1 ? { step } : {};
      switch (ctx.kind) {
        case 'none':
          return {
            action: 'none',
            ...(outcome.tagNote ? { tagNote: outcome.tagNote } : {}),
            ...stepField,
          };
        case 'applied': {
          const s = ctx.stepData as LoStepData;
          return {
            applied: outcome.action,
            target: outcome.target,
            address: outcome.address,
            module: s.adapter.id === 'generic' ? 'other' : s.adapter.id,
            ...(outcome.tagNote ? { tagNote: outcome.tagNote } : {}),
            ...stepField,
          };
        }
        case 'appliedStep':
          return {
            appliedStep: step,
            action: outcome.action,
            target: ctx.applied?.target ?? outcome.target,
          };
        default:
          return null;
      }
    },

    metaExtras(_session, outcome, stepData) {
      if (stepData === undefined) return { address: outcome.address };
      const s = stepData as LoStepData;
      return {
        address: outcome.address,
        module: s.adapter.id === 'generic' ? 'other' : s.adapter.id,
      };
    },

    /**
     * Audit Track D: the bridge's /events long-poll was BUILT BUT UNUSED
     * by the product — the panel refreshed on composer/focus heuristics
     * instead. ONE long-poll per session now consumes the feed
     * (selection-changed, document-edited) and pushes {refresh} frames to
     * the panel's SSE channel. When the bridge dies the poll fails and
     * retries (see TIMINGS.eventRetryMs) — after a bridge restart (audit
     * B3) events flow again and the panel refreshes itself.
     */
    watchEvents(session, push) {
      let stopped = false;
      let since = 0;
      (async () => {
        while (!stopped) {
          try {
            const r = await session.state.bridge.events(since);
            since = r.last ?? since;
            if (!stopped && (r.events?.length ?? 0) > 0) {
              push({ refresh: true });
            }
          } catch {
            if (stopped) return;
            // Bridge down or between restarts: retry shortly.
            await sleep(TIMINGS.eventRetryMs);
          }
        }
      })();
      return () => {
        stopped = true;
      };
    },
  };
}

/** The conversation key for a session's active document. */
function conversationKeyOf(session: CompanionSession<LoState>): string {
  const doc = session.state.activeDoc;
  if (!doc) return UNSAVED_KEY;
  return doc.url || doc.title || UNSAVED_KEY;
}

// --- adapter selection -----------------------------------------------------------

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

// --- bridge extension install (one-click; touches the REAL profile) ---------------

function registerInstallRoutes(
  app: express.Express,
  options: ServerOptions,
): void {
  const wrap = createWrap({
    logError: createLogError(options.logDir),
    mapStatus: (err) => (err instanceof BridgeError ? 503 : 500),
  });

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
}

// --- selection -----------------------------------------------------------------------

/**
 * Extract the SelectionInfo from an already-fetched `/document` payload
 * (pure — no extra bridge round-trip; the document was read once per
 * step by the caller).
 */
function readSelection(doc: BridgeDocument): SelectionInfo {
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

// --- action parsing -----------------------------------------------------------

/** Grammar: [ACTION: name] or [ACTION: name pN], with a ```writer block.
 * The header tolerates tag typos ("[AACTION:", doubled letters) and a
 * missing colon — tagNote reports the auto-correction. The B5 layered
 * resolution and capture extraction live in the core factory. */
const parseTag = createParseActionTag({
  actions: 'delete-at|rewrite-at|insert-after|insert-top|rewrite|insert|none|continue',
  targetPattern: '(?:\\s+p(\\d+))?',
});

export function parseAction(reply: string): ActionOutcome {
  const tag = parseTag(reply);
  const action = tag.action as AgentAction;
  const target = tag.target !== null ? Number.parseInt(tag.target, 10) : null;
  const contentActions: AgentAction[] = ['insert', 'insert-top', 'insert-after', 'rewrite', 'rewrite-at'];
  const needsContent = contentActions.includes(action);
  const rawBlock = needsContent ? extractContentBlock(reply) : null;
  return {
    action,
    target,
    address: null,
    block: needsContent ? (rawBlock !== null ? parseContentBlock(rawBlock) : null) : null,
    grid: null,
    tagNote: actionTagNote(tag.rawTag ?? undefined, `[ACTION: ${action}${target !== null ? ` p${target}` : ''}]`),
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
  parts.push(...buildAttachmentBlock(attachments));
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
const extractAttachmentText = createAttachmentExtractor({
  extensions: [
    'txt', 'md', 'markdown', 'odt', 'fodt', 'csv', 'tsv', 'json', 'xml',
    'bib', 'log', 'htm', 'html', 'yaml', 'yml', 'py', 'js', 'ts',
  ],
  envVar: 'LO_MARKITDOWN',
});
