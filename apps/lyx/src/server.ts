/**
 * Express API + session orchestration for the LyX ACP companion app.
 *
 * One session = one running LyX instance + one ACP agent. The LyXServer
 * pipe follows LyX's ACTIVE view, so documents are tracked dynamically:
 * every request re-reads `server-get-filename`, conversations are keyed
 * per document path, and the client can list/switch documents. All
 * document reads go through the pipe + the saved `.lyx` file; all writes
 * go through the pipe (`paste` via the `application/x-lyx` clipboard).
 */

import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import express from 'express';
import { LyxServerClient, LyxPipeError, createWriteOnlyFallbacks } from './lyxserver/client.js';
import type { RawClipboard } from './clipboard/lyx-clipboard.js';
import { LyxClipboard } from './clipboard/lyx-clipboard.js';
import {
  buildDocumentContext,
  renderOutline,
  assemblePasteDocument,
  extractBodyLayouts,
  splitTopLevelLayouts,
  normalizeMarkupBlock,
  findMarkupProblems,
  type DocumentContext,
} from './lyx/context.js';
import { CHAT_KNOWLEDGE } from './lyx/knowledge.js';
import { isVersionControlled } from './vcs.js';
import {
  AcpClient,
  UNSAVED_KEY,
  ACTION_HEADER,
  createAgentSettings,
  createConversationStore,
  createLogError,
  extractAttachmentText as coreExtractAttachmentText,
  formatHistoryReplay as coreFormatHistoryReplay,
  listKnownDocuments as coreListKnownDocuments,
  registerAttachmentRoutes,
  registerSessionRoutes,
  startSse,
  sseFail,
  MAX_ACTIONS_PER_MESSAGE,
  pollUntil,
  sleep,
  createApiAuthGuard,
  createPanelIndexHandler,
  generateApiToken,
  type CompanionRecord,
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




/**
 * Documents with a body larger than this attach only their outline to
 * prompts; the agent then reads/searches the saved file with its own
 * tools (lazy fetch, like a coding agent in a repository).
 */
const OUTLINE_ONLY_BODY_LIMIT = 16_000;

/**
 * Maximum document edits one user message may apply. ACP only signals that
 * a single response finished; continuing with the next edit is an app-level
 * loop, so it needs a hard stop even if the agent keeps proposing actions.
 */


/** Parsed document snapshot (see Session.docSnapshot). */
export interface DocumentSnapshot {
  path: string;
  mtimeMs: number;
  raw: string;
  ctx: DocumentContext;
}

export interface Session {
  id: string;
  lyx: LyxServerClient;
  clipboard: LyxClipboard;
  agent: AgentRunner;
  /** Conversation history per document path. */
  conversations: Map<string, Turn[]>;
  /**
   * Per conversation key: number of leading turns loaded from persisted
   * history (pre-restart) that the current agent process has NOT seen.
   * The next prompt replays them (see buildHistoryPrefix).
   */
  historyHandoff: Map<string, number>;
  /** All document paths seen during this session (for the selector). */
  knownDocuments: Set<string>;
  /** Active document path, refreshed from LyX on every request. */
  documentPath: string | null;
  /** Set when the client asks to stop the current generation. */
  cancelRequested: boolean;
  /**
   * Parsed document snapshot, cached per (path, mtimeMs). One request
   * parses the document ONCE: every save() bumps the file's mtime, so the
   * snapshot invalidates itself whenever the document actually changed
   * (see readDocumentSnapshot). Previously each step parsed the file
   * 3-4 times (context build, paragraph walk, verification, header).
   */
  docSnapshot?: DocumentSnapshot | null;
  /**
   * Document paths whose save conditions the user accepted this session
   * (save-consent gate; only asked for documents outside version control).
   */
  saveConsent: Set<string>;
  /** Files waiting to be included with the next message. */
  attachments: Attachment[];
}

export interface ServerOptions {
  publicDir: string;
  clipboard: RawClipboard;
  /** Directory for persisted chat history (per document). Optional. */
  historyDir?: string;
  /** Directory where uploaded attachments are stored. Optional. */
  attachmentsDir?: string;
  /** Directory for the persistent error log (errors.log). Optional. */
  logDir?: string;
  /**
   * Directory for UI settings persisted across runs (agent-settings.json).
   * Optional; when absent the settings routes return defaults.
   */
  settingsDir?: string;
  /**
   * API bearer token (audit B1). Generated at boot when absent; exposed as
   * `app.locals.apiToken` for the record writers / dev tools.
   */
  apiToken?: string;
}


export function createServer(options: ServerOptions & {
  /** Test hook: inject a fake agent process instead of spawning one. */
  agentFactory?: (settings: AgentSettings) => AgentRunner;
  /** Test hook: inject a fake LyXServerClient instead of the real pipe. */
  lyxFactory?: () => LyxServerClient;
}) {
  const app = express();
  // API auth (audit B1): random bearer token + loopback Host check; the
  // panel gets the token same-origin via the injected index.html. Static
  // assets sit BEFORE the guard (not sensitive), all /api routes after.
  const apiToken = options.apiToken ?? generateApiToken();
  app.locals.apiToken = apiToken;
  app.use(express.json({ limit: '5mb' }));
  app.get('/', createPanelIndexHandler(options.publicDir, apiToken));
  app.use(express.static(options.publicDir, { maxAge: 0, etag: false, lastModified: false }));
  app.use(createApiAuthGuard(apiToken));

  const sessions = new Map<string, Session>();

  const logError = createLogError(options.logDir);

  const wrap = (handler: (req: express.Request, res: express.Response) => Promise<unknown>) =>
    async (req: express.Request, res: express.Response) => {
      try {
        await handler(req, res);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const status = err instanceof LyxPipeError ? 503 : 500;
        logError(`[api] ${req.path}`, err);
        res.status(status).json({ error: message });
      }
    };

  // --- status ----------------------------------------------------------

  app.get('/api/status', (_req, res) => {
    const probe = new LyxServerClient();
    res.json({ lyxPipeAvailable: probe.isAvailable() });
  });

  // --- settings (persisted server-side; the server port is random per
  // launch, so localStorage — origin-scoped — would not survive a restart) ---

  const agentSettings = createAgentSettings(options.settingsDir);
  agentSettings.register(app, wrap);

  // --- session ---------------------------------------------------------

  app.post(
    '/api/session',
    wrap(async (req, res) => {
      // Defaults < persisted settings < explicit request body.
      const persisted = await agentSettings.read();
      const requested = req.body?.agent as Partial<AgentSettings> | undefined;
      // Hoisted so the write-only fallback's filename resolution can see it
      // grow over the session's lifetime (it is the same set as
      // session.knownDocuments below).
      const knownDocuments = new Set<string>();
      // Tests may inject a fake LyX pipe client and a fake agent runner so
      // the whole multi-action loop can be exercised without live processes.
      const lyx = options.lyxFactory
        ? options.lyxFactory()
        : new LyxServerClient({
            fallbacks: createWriteOnlyFallbacks(options.clipboard, () => knownDocuments),
          });
      await lyx.start();
      if (lyx.mode === 'write-only') {
        console.warn(
          'LyXServer pipe is deaf (LyX resets every .out connection; see ' +
            'AGENTS.md "Live-test debugging trail"). Running in write-only ' +
            'fallback mode: commands work, replies are substituted from ' +
            'the window title, session file, and clipboard.',
        );
      }

      const agent: AgentRunner = options.agentFactory
        ? options.agentFactory({
            command: requested?.command ?? persisted.command ?? 'vibe-acp',
            args: requested?.args ?? persisted.args ?? [],
            env: requested?.env ?? persisted.env ?? {},
          })
        : new AcpClient({
            appName: 'lyx-acp-assist',
            writerName: 'LyX',
            command: requested?.command ?? persisted.command ?? 'vibe-acp',
            args: requested?.args ?? persisted.args ?? [],
            env: requested?.env ?? persisted.env ?? {},
          });
      await agent.start();

      const id = randomUUID();
      const session: Session = {
        id,
        lyx,
        clipboard: new LyxClipboard(options.clipboard),
        agent,
        conversations: new Map(),
        historyHandoff: new Map(),
        knownDocuments,
        documentPath: null,
        cancelRequested: false,
        saveConsent: new Set(),
        attachments: [],
      };
      sessions.set(id, session);
      await agent.createSession(id);

      // Seed the document selector with paths from previous sessions. The
      // pipe has no "list open buffers" LFUN, so without this the selector
      // only shows the active tab after an app restart (the in-memory
      // knownDocuments set starts empty).
      if (options.historyDir) {
        for (const docPath of await listKnownDocuments(options.historyDir)) {
          session.knownDocuments.add(docPath);
        }
      }

      // First connect: the panel shows an outline-aware welcome message.
      res.json(await sessionInfo(session, { outline: true }));
    }),
  );

  // --- context ---------------------------------------------------------

  registerSessionRoutes(app, wrap, {
    getSession,
    sessions,
    sessionInfo,
    teardown: (s) => s.lyx.stop(),
  });

  // --- attachments -------------------------------------------------------

  /** Store an uploaded file for the next message (base64 JSON body). */
  registerAttachmentRoutes(app, wrap, {
    attachmentsDir: options.attachmentsDir,
    getSession,
    extractText: extractAttachmentText,
  });

  // --- documents ---------------------------------------------------------

  /** List known documents and which one is active right now. */
  app.get(
    '/api/session/:id/documents',
    wrap(async (req, res) => {
      const session = getSession(req.params['id']);
      const active = await refreshActiveDocument(session);
      res.json({
        active,
        versionControlled: active ? await isVersionControlled(active) : null,
        documents: [...session.knownDocuments],
      });
    }),
  );

  /**
   * Switch LyX's active tab/window to the given document (it must be
   * already open). The pipe has no "list buffers" LFUN, so switching is
   * done via file-open, which activates an already-open buffer.
   */
  app.post(
    '/api/session/:id/documents/switch',
    wrap(async (req, res) => {
      const session = getSession(req.params['id']);
      const target = req.body?.path as string | undefined;
      if (!target) {
        res.status(400).json({ error: 'path is required' });
        return;
      }
      await session.lyx.request('file-open', target);
      // Wait until LyX actually switched (bounded poll instead of a fixed
      // sleep); on timeout we fall through and report whatever is active.
      await pollUntil(async () => (await session.lyx.getFilename()) === target, {
        timeoutMs: 2000,
        intervalMs: 50,
      });
      const active = await refreshActiveDocument(session);
      res.json({
        active,
        versionControlled: active ? await isVersionControlled(active) : null,
        documents: [...session.knownDocuments],
      });
    }),
  );

  // --- save consent --------------------------------------------------------

  /**
   * Record that the user accepted the conditions for saving a document
   * that lives outside version control (asked once per document path,
   * per session; see the gate in the message stream handler). The disk
   * save itself is only performed by the message flow, so consent is
   * purely a session-state flag.
   */
  app.post(
    '/api/session/:id/save-consent',
    wrap(async (req, res) => {
      const session = getSession(req.params['id']);
      const docPath = (req.body?.path as string | undefined)?.trim();
      if (!docPath) {
        res.status(400).json({ error: 'path is required' });
        return;
      }
      session.saveConsent.add(docPath);
      res.json({ ok: true, path: docPath });
    }),
  );

  // --- selection ---------------------------------------------------------

  app.get(
    '/api/session/:id/selection',
    wrap(async (req, res) => {
      const session = getSession(req.params['id']);
      res.json(await readSelection(session));
    }),
  );

  // --- message (unified; the agent infers the action) --------------------

  /**
   * Streaming message: one input for everything. The agent decides the
   * intent and ends its reply with an action tag:
   *   [ACTION: none]    - conversational reply; the document is untouched
   *   [ACTION: insert]  - paste the ```lyx block at the cursor
   *   [ACTION: rewrite] - replace the current selection with the block
   *
   * After a document action is applied, the app re-reads the saved document
   * and prompts the agent again for the next edit, so one request can apply
   * several edits. The run stops when the agent replies [ACTION: none],
   * when an action fails, when the user cancels, or after
   * MAX_ACTIONS_PER_MESSAGE edits.
   *
   * SSE frames: {"text": ...} chunks, {"tool": {title, status}} for
   * agent tool activity, then {"applied": "insert"|"rewrite"} per edit,
   * {"appliedStep": n} between edits, {"stopped": reason}, then
   * {"done": true}. Errors/cancellation are sent as {"error": ...} /
   * {"cancelled": true} frames.
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

    // Tracked across the handler so the catch block can persist the error
    // as turn metadata when the failure happens after the turn was recorded.
    let turnRecorded = false;
    let lastAction: AgentAction = 'none';
    let lastTarget: number | null = null;
    let lastTarget2: number | null = null;

    type Send = (obj: unknown) => void;

    interface ApplyResult {
      ok: boolean;
      cancelled: boolean;
      error: string | null;
      appliedAction: AgentAction | null;
      appliedTarget: number | null;
      appliedTarget2: number | null;
      /** Number of edits applied so far in this multi-action run. */
      appliedCount: number;
    }

    /**
     * Prompt the agent once and, when it proposes a document action, apply
     * exactly that action. `step` is 1 for the first edit of a run and >1
     * for continuations; each applied edit is recorded as its own turn so
     * undo-per-edit and restart-visible outcomes keep working.
     */
    async function promptAndApply(
      prompt: string,
      step: number,
      selection: Awaited<ReturnType<typeof readSelection>>,
      send: Send,
      originalMessage: string,
    ): Promise<{ reply: string; outcome: ActionOutcome; result: ApplyResult }> {
      const zero: ApplyResult = {
        ok: false,
        cancelled: false,
        error: null,
        appliedAction: null,
        appliedTarget: null,
        appliedTarget2: null,
        appliedCount: 0,
      };
      let reply = await session.agent.prompt(session.id, [{ type: 'text', text: prompt }], {
        onChunk: (chunk) => send({ text: chunk, ...(step > 1 ? { step } : {}) }),
        onToolCall: (tool) => send({ tool }),
        timeoutMs: 240_000,
      });
      let outcome = parseAction(reply);

      // If the agent wants to write into the document, validate the markup
      // and retry once with a corrective prompt (VRP pattern).
      if (!session.cancelRequested && outcome.action !== 'none' && outcome.action !== 'continue' && outcome.body) {
        const problems = findMarkupProblems(outcome.body);
        if (problems.length > 0) {
          const retry = buildMarkupRetryPrompt(outcome.action, problems);
          reply = await session.agent.prompt(session.id, [{ type: 'text', text: retry }], {
            onChunk: (chunk) => send({ text: `\n${chunk}`, ...(step > 1 ? { step } : {}) }),
            onToolCall: (tool) => send({ tool }),
          });
          outcome = parseAction(reply);
        }
      }

      if (step === 1) {
        await recordTurn(session, originalMessage, reply);
      } else {
        await recordActionStep(session, reply, step);
      }
      lastAction = outcome.action;
      lastTarget = outcome.target;
      lastTarget2 = outcome.target2;

      // Near-miss action tags (typos like "[AACTION:") are auto-corrected
      // by the tolerant parser; tell the panel so the user sees it.
      if (outcome.tagNote) send({ tagNote: outcome.tagNote, ...(step > 1 ? { step } : {}) });

      const noteMeta = async (result: 'applied' | 'error' | 'cancelled', error?: string) => {
        await recordTurnMeta(session, {
          action: outcome.action,
          target: outcome.target,
          target2: outcome.target2,
          result,
          ...(error ? { error } : {}),
          ...(step > 1 ? { step } : {}),
        });
      };

      if (session.cancelRequested) {
        send({ cancelled: true, ...(step > 1 ? { step } : {}) });
        await noteMeta('cancelled');
        return { reply, outcome, result: { ...zero, cancelled: true } };
      }
      if (outcome.action === 'none') {
        send({ action: 'none', ...(step > 1 ? { step } : {}) });
        await noteMeta('applied');
        return { reply, outcome, result: { ...zero, ok: true, appliedAction: 'none' } };
      }
      if (outcome.action === 'continue') {
        // Accepted for forward-compatibility; the server's multi-action loop
        // drives continuations itself, so this tag means "nothing to do".
        send({ action: 'none', ...(step > 1 ? { step } : {}) });
        await noteMeta('applied');
        return { reply, outcome, result: { ...zero, ok: true, appliedAction: 'none' } };
      }

      let appliedTarget: number | null = null;
      let error: string | null = null;
      let applied = false;

      if (outcome.action === 'delete-at') {
        // Delete needs no ```lyx block: walk, verify, select, delete the
        // text, then merge the leftover empty paragraph away.
        const gotoResult = await gotoParagraph(session, outcome.target, 'rewrite');
        if (gotoResult.error) {
          error = gotoResult.error;
        } else {
          const deleted = await session.lyx.deleteSelection();
          if (deleted) {
            await session.lyx.mergeAwayParagraph();
            send({ applied: 'delete-at', target: outcome.target, ...(step > 1 ? { step } : {}) });
            applied = true;
          } else {
            error = `LyX could not delete paragraph [p${outcome.target}].`;
          }
        }
      } else if (outcome.action === 'merge') {
        // Merge needs no ```lyx block: walk + verify + collapse to the end
        // of [pN], then delete-forward merges [p(N+1)] into it.
        const result = await mergeParagraph(session, outcome.target, outcome.target2);
        if (result.error) {
          error = result.error;
        } else {
          send({ applied: 'merge', target: outcome.target, target2: outcome.target2, ...(step > 1 ? { step } : {}) });
          applied = true;
        }
      } else if (outcome.action === 'move') {
        // Move needs no ```lyx block: capture the paragraph via the
        // clipboard, delete it, then re-paste at the adjusted destination.
        const result = await moveParagraph(session, outcome.target, outcome.target2);
        if (result.error) {
          error = result.error;
        } else {
          send({ applied: 'move', target: outcome.target, target2: outcome.target2, ...(step > 1 ? { step } : {}) });
          applied = true;
        }
      } else {
        // A write action: position the cursor, then paste.
        if (!outcome.body) {
          error = `Agent chose [ACTION: ${outcome.action}] but returned no \`\`\`lyx block.`;
        } else {
          let positionError: string | null = null;
          let target = outcome.target;
          if (outcome.action === 'rewrite' && !selection.hasSelection) {
            positionError = 'Agent chose [ACTION: rewrite] but LyX has no active selection.';
          } else if (outcome.action === 'insert' && selection.hasSelection) {
            // A selection is active: paste would REPLACE it. The agent chose
            // plain insert, not rewrite — collapse the selection so the
            // user's text survives and the paste lands at the cursor.
            await session.lyx.collapseSelection();
          } else if (outcome.action === 'insert-top') {
            const moved = await session.lyx.beginOfDocument();
            if (!moved) {
              positionError = 'Could not move the cursor to the start of the document (buffer-begin failed).';
            } else {
              // buffer-begin lands INSIDE the first paragraph: a paste there
              // would merge into it and drop the pasted layout. Break the
              // paragraph first so the paste lands in a fresh empty paragraph.
              await session.lyx.breakParagraph();
            }
          } else if (outcome.action === 'rewrite-at') {
            const gotoResult = await gotoParagraph(session, outcome.target, 'rewrite');
            target = gotoResult.target;
            positionError = gotoResult.error;
          } else if (outcome.action === 'insert-after') {
            const gotoResult = await gotoParagraph(session, outcome.target, 'insert-after');
            target = gotoResult.target;
            positionError = gotoResult.error;
          } else if (outcome.action === 'insert-before') {
            // Insert-before pN = insert-after p(N-1), reusing the fully
            // verified insert-after choreography (walk, verify, collapse,
            // break a fresh paragraph). For p1 it degenerates to the
            // insert-top choreography; the reported target stays pN.
            if (outcome.target === 1) {
              const moved = await session.lyx.beginOfDocument();
              if (!moved) {
                positionError = 'Could not move the cursor to the start of the document (buffer-begin failed).';
              } else {
                await session.lyx.breakParagraph();
              }
            } else {
              const gotoResult = await gotoParagraph(session, (outcome.target ?? 0) - 1, 'insert-after');
              positionError = gotoResult.error;
            }
          }
          if (positionError) {
            error = positionError;
          } else {
            const header = (await currentHeader(session)) ?? FALLBACK_HEADER;
            const doc = assemblePasteDocument(header, outcome.body);
            const written = await session.clipboard.writeLyxDocumentVerified(doc, outcome.body);
            if (!written) {
              error =
                'The .lyx payload could not be written to the clipboard; ' +
                'nothing was pasted. Please try again.';
            } else {
              await session.lyx.paste(); // replaces the active selection if any
              send({ applied: outcome.action, target, ...(step > 1 ? { step } : {}) });
              applied = true;
              appliedTarget = target;
            }
          }
        }
      }

      if (error) {
        send({ error, ...(step > 1 ? { step } : {}) });
        await noteMeta('error', error);
        return { reply, outcome, result: { ...zero, error } };
      }
      if (!applied) {
        // Addressed actions without a successful paste still count as the
        // turn's outcome; treat a missing application as an error so the
        // loop does not silently spin.
        const fallback = 'The document action could not be applied.';
        send({ error: fallback, ...(step > 1 ? { step } : {}) });
        await noteMeta('error', fallback);
        return { reply, outcome, result: { ...zero, error: fallback } };
      }
      await noteMeta('applied');
      return {
        reply,
        outcome,
        result: {
          ok: true,
          cancelled: false,
          error: null,
          appliedAction: outcome.action,
          appliedTarget: appliedTarget ?? outcome.target,
          appliedTarget2: outcome.target2,
          appliedCount: step,
        },
      };
    }

    try {
      await refreshActiveDocument(session);
      // Save-consent gate: the save below overwrites the file on disk with
      // the assistant's edits. In a VCS working tree the previous state is
      // recoverable; outside one it is not, so the user must have accepted
      // that condition for THIS document path first (modal in the panel UI;
      // the client retries after POSTing /save-consent).
      if (
        session.documentPath &&
        !(await isVersionControlled(session.documentPath)) &&
        !session.saveConsent.has(session.documentPath)
      ) {
        res.status(409).json({
          error: 'This document is not under version control. Accept that the assistant saves changes to the file before sending a message.',
          code: 'save-consent-required',
          documentPath: session.documentPath,
        });
        return;
      }
      // Read path per architecture: save the buffer first so the outline
      // and body parsed from disk match the live document. Only for saved
      // buffers — buffer-write on an untitled buffer opens a Save As dialog.
      if (session.documentPath) await saveDocument(session);
      const contextText = await buildContextBlock(session);
      const selection = await readSelection(session);
      const send = startSse(res);
      session.cancelRequested = false;

      // Attachments are consumed by this message (chat-app semantics).
      const attachments = session.attachments;
      session.attachments = [];

      const historyPrefix = buildHistoryPrefix(session, conversationKey(session));
      const initialPrompt = buildAutoPrompt(contextText, selection, message, attachments, historyPrefix);
      // The replayed (pre-restart) turns are in this prompt now, so the
      // agent knows them; only turns recorded from here on are new to it.
      // Without clearing, a second message after a restart would replay
      // the same history again.
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
        // The first step uses the normal prompt; continuations get fresh
        // document context because paragraph addresses shift after edits.
        let prompt: string;
        let stepSelection = selection;
        if (step === 1) {
          prompt = initialPrompt;
        } else {
          await refreshActiveDocument(session);
          if (session.documentPath) await saveDocument(session);
          const freshContext = await buildContextBlock(session);
          stepSelection = await readSelection(session);
          prompt = buildContinuationPrompt(freshContext, stepSelection, message, completed);
        }
        const { outcome, result } = await promptAndApply(prompt, step, stepSelection, send, message);
        turnRecorded = true;

        if (result.cancelled) {
          stoppedReason = 'cancelled';
          break;
        }
        if (result.error) {
          stoppedReason = 'error';
          break;
        }
        if (outcome.action === 'none' || outcome.action === 'continue') {
          stoppedReason = 'none';
          break;
        }
        // A document edit landed: record what was done and continue.
        completed.push(describeAction(outcome));
        send({ appliedStep: result.appliedCount, action: outcome.action, target: result.appliedTarget, target2: result.appliedTarget2 });
      }

      if (step >= MAX_ACTIONS_PER_MESSAGE && stoppedReason === 'done') {
        stoppedReason = 'limit';
        send({ text: `\nStopped after ${MAX_ACTIONS_PER_MESSAGE} document edits (safety limit). Send "continue" to apply more edits.` });
      }
      send({ stopped: stoppedReason, appliedCount: completed.length });
      send({ done: true });
      // History writes are debounced in the shared store; flush before the
      // stream closes so a completed run is always on disk when the UI
      // sees `done`.
      await storeFor(session).flush().catch(() => { /* never break the stream */ });
      res.end();
    } catch (err) {
      const message2 = err instanceof Error ? err.message : String(err);
      logError('[api] message/stream', err);
      if (!res.headersSent) {
        res.status(err instanceof LyxPipeError ? 503 : 500).json({ error: message2 });
      } else {
        sseFail(res, err);
      }
      // Persist the failure on the recorded turn so it survives a restart.
      if (turnRecorded) {
        await recordTurnMeta(session, {
          action: lastAction, target: lastTarget, target2: lastTarget2,
          result: lastAction === 'none' ? 'applied' : 'error',
          error: message2,
        }).catch(() => { /* logging must never break the request path */ });
        await storeFor(session).flush().catch(() => { /* logging must never break the request path */ });
      }
    }
  });

  // --- undo ------------------------------------------------------------

  app.post(
    '/api/session/:id/undo',
    wrap(async (req, res) => {
      const session = getSession(req.params['id']);
      await refreshActiveDocument(session);
      await session.lyx.undo();
      res.json({ ok: true });
    }),
  );

  // --- helpers -----------------------------------------------------------

  function param(id: string | string[] | undefined): string {
    return Array.isArray(id) ? (id[0] ?? '') : (id ?? '');
  }

  function getSession(id: string | string[] | undefined): Session {
    const session = sessions.get(param(id));
    if (!session) throw new Error('Unknown session');
    return session;
  }

  /** Re-read the active document path from LyX and track it. */
  async function refreshActiveDocument(session: Session): Promise<string | null> {
    const path = await session.lyx.getFilename();
    session.documentPath = path;
    if (path) {
      session.knownDocuments.add(path);
      await ensureConversation(session, path);
    } else {
      await ensureConversation(session, UNSAVED_KEY);
    }
    return path;
  }

  function conversationKey(session: Session): string {
    return session.documentPath ?? UNSAVED_KEY;
  }

  /**
   * Get (creating if needed) the conversation for a key and remember how many
   * of its turns came from persisted history on disk. The in-memory list is
   * what the agent is told about (see buildHistoryPrefix): the agent keeps
   * its own context within a session, so replaying history it already saw
   * would only eat context — but after an app restart (or a reconnect) the
   * agent is a fresh process with NO memory, and it must be briefed on the
   * turns it missed. Awaits the persisted history load so callers
   * (sessionInfo) never observe a half-loaded turn list — the
   * fire-and-forget version raced and returned empty history.
   */
  const storeBySession = new WeakMap<Session, ConversationStore>();
  function storeFor(session: Session): ConversationStore {
    let store = storeBySession.get(session);
    if (!store) {
      store = createConversationStore({
        historyDir: options.historyDir,
        logError,
        conversations: session.conversations,
        historyHandoff: session.historyHandoff,
        keyOf: () => session.documentPath ?? UNSAVED_KEY,
        replayOptions: LYX_REPLAY_OPTIONS,
      });
      storeBySession.set(session, store);
    }
    return store;
  }

  async function ensureConversation(session: Session, key: string): Promise<Turn[]> {
    return storeFor(session).ensure(key);
  }

  /**
   * Render the turns the agent has not seen (pre-restart history) as a
   * compact context block. Empty string when the agent already knows the
   * whole conversation.
   */
  function buildHistoryPrefix(session: Session, key: string): string {
    return storeFor(session).buildHistoryPrefix(key);
  }

  async function recordTurn(session: Session, user: string, assistant: string) {
    return storeFor(session).recordTurn(user, assistant);
  }

  /**
   * Record one step of a multi-action run WITHOUT a matching user turn: the
   * user asked once, the app applied several edits to the document. UI and
   * history see each outcome, but the conversation log keeps the original
   * request as the user turn.
   */
  async function recordActionStep(session: Session, assistant: string, step: number) {
    return storeFor(session).recordActionStep(assistant, step);
  }

  /**
   * Record the outcome of the action the assistant proposed in the LAST
   * turn of the conversation (the one just recorded by recordTurn), so a
   * failed or successful document action survives an app restart and is
   * visible when the history is reloaded.
   */
  async function recordTurnMeta(session: Session, meta: TurnMeta): Promise<void> {
    return storeFor(session).recordTurnMeta(meta);
  }

  /**
   * GET response body. By default the expensive parts are skipped: the
   * panel's refresh chain calls this on every post-send / focus /
   * keystroke burst and never displays the outline. `outline: true`
   * (session creation, `?outline=1`) reads and parses the document.
   */
  async function sessionInfo(session: Session, opts: { outline?: boolean } = {}) {
    const docPath = await refreshActiveDocument(session);
    let outline = '';
    let layout = '';
    try {
      layout = await session.lyx.getLayout();
      if (opts.outline) {
        const ctx = await readDocumentContext(session);
        outline = renderOutline(ctx.outline);
      }
    } catch {
      /* document may be unsaved; outline unavailable */
    }
    return {
      sessionId: session.id,
      documentPath: docPath,
      documents: [...session.knownDocuments],
      versionControlled: docPath ? await isVersionControlled(docPath) : null,
      layout,
      outline,
      lyxMode: session.lyx.mode,
      conversation: session.conversations.get(conversationKey(session)) ?? [],
    };
  }

  /**
   * Save the buffer AND invalidate the document snapshot: the file is
   * about to change on disk, and filesystem timestamps can be too coarse
   * (same-tick writes) to detect rapid successive saves via mtime alone.
   */
  async function saveDocument(session: Session): Promise<void> {
    session.docSnapshot = null;
    await session.lyx.save();
  }

  /**
   * Read + parse the active document ONCE per (path, mtime): the snapshot
   * is cached on the session and re-read only when the file changed on
   * disk. Every app-driven save invalidates it explicitly (see
   * saveDocument); mtime covers external changes. stat() is cheap; the
   * full read + parse is what we avoid repeating 3-4 times per step.
   */
  async function readDocumentSnapshot(session: Session): Promise<DocumentSnapshot> {
    const filePath = session.documentPath;
    if (!filePath) throw new Error('Document is not saved on disk.');
    let mtimeMs: number;
    try {
      mtimeMs = (await fs.stat(filePath)).mtimeMs;
    } catch {
      throw new Error(`Cannot read ${filePath}`);
    }
    const cached = session.docSnapshot;
    if (cached && cached.path === filePath && cached.mtimeMs === mtimeMs) {
      return cached;
    }
    const raw = await fs.readFile(filePath, 'utf8');
    const snapshot: DocumentSnapshot = {
      path: filePath,
      mtimeMs,
      raw,
      ctx: buildDocumentContext(raw),
    };
    session.docSnapshot = snapshot;
    return snapshot;
  }

  async function readDocumentContext(session: Session) {
    return (await readDocumentSnapshot(session)).ctx;
  }

  async function currentHeader(session: Session): Promise<string | null> {
    try {
      // Reuses the session's document snapshot (see readDocumentSnapshot).
      const ctx = await readDocumentContext(session);
      return ctx.header || null;
    } catch {
      return null;
    }
  }

  async function buildContextBlock(session: Session): Promise<string> {
    try {
      const [ctx, layout] = await Promise.all([
        readDocumentContext(session),
        session.lyx.getLayout(),
      ]);
      const head =
        `Document context\n` +
        `================\n` +
        `File: ${session.documentPath}\n` +
        `Text class: ${ctx.textclass ?? 'unknown'}\n` +
        `LyX format: ${ctx.formatVersion ?? 'unknown'}\n` +
        `Cursor paragraph layout: ${layout || 'unknown'}\n\n` +
        `Document outline ([pN] ids address paragraphs):\n${renderOutline(ctx.outline)}\n\n`;
      let contextText = head;
      const classLayouts = ctx.textclass ? await findClassLayouts(ctx.textclass) : null;
      if (classLayouts) {
        contextText +=
          `Layouts defined by the document class "${ctx.textclass}" ` +
          `(use these names, or ones already in the outline, for new content):\n` +
          classLayouts.join(', ') + '\n\n';
      }
      if (ctx.body.length <= OUTLINE_ONLY_BODY_LIMIT) {
        // Small document: attach the full body for maximum fidelity.
        return contextText + `Full body (.lyx markup):\n${ctx.body}\n`;
      }
      // Large document: outline only. The agent reads/searches the saved
      // file itself with its own tools (like a coding agent in a repo).
      return (
        contextText +
        `The document is LARGE (${ctx.body.length} chars), so only the outline above is\n` +
        `attached. To see the exact text of any paragraph, read or search the saved\n` +
        `file "${session.documentPath}" with your file tools — it is the exact live\n` +
        `document, and it was saved moments ago. The [pN] ids correspond to the\n` +
        `\\begin_layout blocks of the body in document order (inset inner layouts count\n` +
        `too), so you can locate paragraph [pN] by counting \\begin_layout occurrences.\n`
      );
    } catch (e) {
      return (
        `Document context\n================\nFile: ${session.documentPath ?? UNSAVED_KEY}\n` +
        `No .lyx file context available (document unsaved?): ${(e as Error).message}\n`
      );
    }
  }

  async function readSelection(session: Session) {
    const stats = await session.lyx.getSelectionStats();
    let hasSelection = stats[0] > 0;
    let lyxBody: string | null = null;
    let text: string | null = null;
    let layout: string | null = null;
    if (hasSelection) {
      const copied = await session.lyx.copySelection();
      if (copied) {
        // Wait until the x-lyx payload lands on the clipboard (the copy
        // LFUN is dispatched asynchronously in LyX's event loop).
        const doc = await pollUntil(() => session.clipboard.readLyxDocument(), {
          timeoutMs: 500,
          intervalMs: 25,
        });
        if (doc) {
          lyxBody = extractBodyLayouts(doc) ?? doc;
          text = await session.clipboard.readText();
        }
      } else {
        // Stats claimed a selection but LyX refused to copy (stale/weird
        // state); report no selection instead of trusting a stale clipboard.
        hasSelection = false;
      }
      layout = await session.lyx.tryRequest('server-get-layout');
    }
    return { hasSelection, stats, lyxBody, text, layout };
  }

  /**
   * Position the cursor for a paragraph-addressed action, with target
   * verification (copy + normalized comparison against the outline
   * preview — a mis-targeted paste never happens; on mismatch we return
   * an error and nothing is pasted):
   * - mode 'rewrite': the whole paragraph [pN] stays SELECTED, so the
   *   subsequent paste replaces it.
   * - mode 'insert-after': the selection is collapsed to the paragraph's
   *   end and a fresh empty paragraph is created BELOW [pN], so the paste
   *   lands in it with its own layout (never merges into [pN]).
   */
  async function gotoParagraph(
    session: Session,
    target: number | null,
    mode: 'rewrite' | 'insert-after',
  ): Promise<{ target: number | null; error: string | null; payload: string | null }> {
    if (!target || target < 1) {
      return {
        target,
        error: `Agent chose an addressed action without a valid paragraph number.`,
        payload: null,
      };
    }
    const fail = async (error: string): Promise<{ target: number | null; error: string; payload: null }> => {
      // Our paragraph-select may have selected the wrong paragraph; a
      // selection persists in LyX and would pollute later commands.
      await session.lyx.clearSelection();
      return { target, error, payload: null };
    };
    let ctx;
    let raw: string;
    try {
      // One parse per step: the snapshot cache means the context build and
      // the header read of the same step reuse this parse.
      const snap = await readDocumentSnapshot(session);
      raw = snap.raw;
      ctx = snap.ctx;
    } catch (e) {
      return fail(`Cannot address paragraphs: ${(e as Error).message}`);
    }
    const entry = ctx.outline[target - 1];
    if (!entry) {
      return fail(`Paragraph [p${target}] does not exist (document has ${ctx.outline.length}).`);
    }
    const moved = await session.lyx.beginOfDocument();
    if (!moved) return fail('buffer-begin failed.');
    let ok = true;
    for (let i = 1; i < target && ok; i++) ok = await session.lyx.paragraphDown();
    if (!ok) {
      return fail(`Could not reach paragraph [p${target}] (paragraph-down failed).`);
    }
    const selected = await session.lyx.paragraphSelect();
    if (!selected) return fail('paragraph-select failed.');
    // Verify the target against the SAVED file: copy the selection and
    // compare its raw .lyx markup with the file's paragraph (see
    // verifyParagraphSelection — a mis-targeted paste never happens).
    const copied = await session.lyx.copySelection();
    if (!copied) {
      return fail('Could not copy the selected paragraph for verification.');
    }
    const payload = await pollUntil(() => session.clipboard.readLyxDocument(), {
      timeoutMs: 500,
      intervalMs: 25,
    });
    const clipboardText = payload === null ? await session.clipboard.readText() : null;
    const verify = verifyParagraphSelection({
      payload,
      clipboardText,
      diskRaw: raw,
      index: target - 1,
      expectedPreview: entry.preview,
    });
    if (!verify.ok) {
      return fail(
        `Paragraph targeting failed: [p${target}] should start with ` +
          `"${normalizeForCompare(entry.preview).slice(0, 60)}\u2026" but the cursor landed on ` +
          `"${verify.actual.slice(0, 60)}\u2026". Nothing was pasted.`,
      );
    }
    if (mode === 'insert-after') {
      // Collapse the selection to the end of [pN] and break a fresh empty
      // paragraph below it; the paste then merges into that empty
      // paragraph and keeps its own layout.
      const collapsed = await session.lyx.collapseSelectionForward();
      if (!collapsed) {
        return fail(`Could not move the cursor to the end of [p${target}].`);
      }
      const broke = await session.lyx.breakParagraph();
      if (!broke) {
        return fail(`Could not create a new paragraph below [p${target}].`);
      }
    }
    return { target, error: null, payload };
  }

  /**
   * Merge paragraph [pN] with [p(N+1)] into one paragraph (the user-quoted
   * M must equal N+1 — only adjacent paragraphs can merge). Choreography:
   * gotoParagraph(pN) selects and verifies it, the selection is collapsed
   * to the paragraph's end, then `char-delete-forward` deletes the
   * paragraph break so [p(N+1)]'s text is appended into [pN]. The merged
   * paragraph keeps [pN]'s layout; one undo reverts the merge.
   */
  async function mergeParagraph(
    session: Session,
    n: number | null,
    m: number | null,
  ): Promise<{ target2: number | null; error: string | null }> {
    const fail = (error: string): { target2: number | null; error: string } => ({
      target2: m,
      error,
    });
    if (!n || n < 1) {
      return fail('Agent chose [ACTION: merge] without a valid first paragraph number.');
    }
    if (m === null || m !== n + 1) {
      return fail(
        '[ACTION: merge pN pM] requires two ADJACENT paragraphs (M = N+1). ' +
          'Merge the pair one at a time.',
      );
    }
    let ctx;
    try {
      ctx = await readDocumentContext(session);
    } catch (e) {
      return fail(`Cannot address paragraphs: ${(e as Error).message}`);
    }
    if (n >= ctx.outline.length) {
      return fail(
        `Paragraph [p${n + 1}] does not exist (document has ${ctx.outline.length}).`,
      );
    }
    const gotoResult = await gotoParagraph(session, n, 'rewrite');
    if (gotoResult.error) return fail(gotoResult.error);
    const collapsed = await session.lyx.collapseSelectionForward();
    if (!collapsed) {
      return fail(`Could not move the cursor to the end of paragraph [p${n}].`);
    }
    const merged = await session.lyx.mergeWithNextParagraph();
    if (!merged) {
      return fail(`LyX could not merge paragraph [p${n}] with [p${m}].`);
    }
    return { target2: m, error: null };
  }

  /**
   * Move paragraph [pN] to the position right after paragraph [pM]
   * (pM = 0 -> the very top). Verified choreography:
   * 1. gotoParagraph(pN) selects and verifies it; the verification copy
   *    leaves its x-lyx payload on the clipboard, which we capture.
   * 2. Delete [pN] with the delete-at choreography.
   * 3. Re-save the buffer so the .lyx file on disk matches the shrunken
   *    document — gotoParagraph verifies destinations against the FILE,
   *    and a stale file would mis-target the paste.
   * 4. Walk to the adjusted destination (M >= N -> M-1 after removal)
   *    and paste the captured paragraph there (insert-after / insert-top
   *    choreographies keep its layout).
   */
  async function moveParagraph(
    session: Session,
    from: number | null,
    to: number | null,
  ): Promise<{ target2: number | null; error: string | null }> {
    const fail = (error: string): { target2: number | null; error: string } => ({
      target2: to,
      error,
    });
    if (!from || from < 1) {
      return fail('Agent chose [ACTION: move] without a valid source paragraph number.');
    }
    if (to === null || to < 0) {
      return fail('Agent chose [ACTION: move] without a valid destination paragraph number (p0 = top).');
    }
    let ctx;
    try {
      ctx = await readDocumentContext(session);
    } catch (e) {
      return fail(`Cannot address paragraphs: ${(e as Error).message}`);
    }
    const count = ctx.outline.length;
    if (from > count) {
      return fail(`Paragraph [p${from}] does not exist (document has ${count}).`);
    }
    if (to > count) {
      return fail(`Destination [p${to}] does not exist (document has ${count}).`);
    }
    // Already in place: moving pN after itself or after its predecessor
    // is a no-op — report success without touching the document.
    if (to === from || to === from - 1) return { target2: to, error: null };

    // 1. Select + verify [pN]; the verification copy leaves its x-lyx on
    //    the clipboard (gotoParagraph captured the payload).
    const gotoResult = await gotoParagraph(session, from, 'rewrite');
    if (gotoResult.error) return fail(gotoResult.error);
    const copied = gotoResult.payload ?? (await session.clipboard.readLyxDocument());
    const body = copied ? extractBodyLayouts(copied) : null;
    if (!body) {
      await session.lyx.clearSelection();
      return fail(`Could not read paragraph [p${from}] from the clipboard; nothing was moved.`);
    }

    // 2. Delete [pN].
    const deleted = await session.lyx.deleteSelection();
    if (!deleted) {
      await session.lyx.clearSelection();
      return fail(`LyX could not delete paragraph [p${from}]; nothing was moved.`);
    }
    await session.lyx.mergeAwayParagraph();

    // 3. Keep the file on disk in sync (see the doc comment).
    await saveDocument(session);

    // 4. Position at the adjusted destination, then paste.
    const dest = to === 0 ? 0 : to < from ? to : to - 1;
    if (dest === 0) {
      const moved = await session.lyx.beginOfDocument();
      if (!moved) return fail('Could not move the cursor to the start of the document (buffer-begin failed).');
      // buffer-begin lands INSIDE the first paragraph; break first so the
      // paste lands in a fresh empty paragraph and keeps its layout.
      const broke = await session.lyx.breakParagraph();
      if (!broke) return fail('Could not create a paragraph at the top of the document.');
    } else {
      const gotoDest = await gotoParagraph(session, dest, 'insert-after');
      if (gotoDest.error) return fail(gotoDest.error);
    }
    if (session.cancelRequested) {
      return fail('Cancelled before the paste; the paragraph was deleted — undo in LyX to restore it.');
    }
    const header = (await currentHeader(session)) ?? FALLBACK_HEADER;
    const doc = assemblePasteDocument(header, body);
    const written = await session.clipboard.writeLyxDocumentVerified(doc, body);
    if (!written) {
      return fail(
        'The .lyx payload could not be written to the clipboard; the paragraph ' +
          'was deleted but not re-inserted. Undo in LyX to restore it.',
      );
    }
    // The clipboard write above is verified by read-back, so the payload is
    // already globally visible — no settle wait is needed before the paste.
    await session.lyx.paste();
    return { target2: to, error: null };
  }
  return app;
}

// --- agent action parsing / prompt building -------------------------------

type AgentAction =
  | 'none'
  | 'continue'
  | 'insert'
  | 'insert-top'
  | 'insert-after'
  | 'insert-before'
  | 'rewrite'
  | 'rewrite-at'
  | 'delete-at'
  | 'merge'
  | 'move';

interface ActionOutcome {
  action: AgentAction;
  body: string | null;
  /** Paragraph address [pN] for rewrite-at / insert-after. */
  target: number | null;
  /** Destination address [pM] for move (0 = top of the document). */
  target2: number | null;
  /** Raw tag text when a near-miss tag (typo, missing colon) was
   *  auto-corrected by the tolerant parser; null when the tag was
   *  canonical or no tag matched. */
  tagNote?: string | null;
}

/**
 * Extract the trailing [ACTION: ...] tag and the ```lyx block from a reply.
 * The header tolerates tag typos ("[AACTION:", doubled letters) and a
 * missing colon — tagNote reports the auto-correction.
 */
const ACTION_TAG_RE = new RegExp(
  `${ACTION_HEADER}\\s*(continue|merge|move|delete-at|rewrite-at|insert-before|insert-after|insert-top|rewrite|insert|none)(?:\\s+p(\\d+))?(?:\\s+(?:to\\s+)?p(\\d+))?\\s*\\]`,
  'i',
);

export function parseAction(reply: string): ActionOutcome {
  const m = reply.match(ACTION_TAG_RE);
  const action = ((m?.[1] ?? 'none').toLowerCase() as AgentAction);
  const target = m?.[2] ? Number.parseInt(m[2], 10) : null;
  const target2 = m?.[3] ? Number.parseInt(m[3], 10) : null;
  // `continue` is accepted for forward-compatibility but is not a document
  // edit: the server's multi-action loop drives continuations itself.
  const body = action === 'none' || action === 'continue' ? null : extractBodyLayouts(reply);
  const canonical =
    `[ACTION: ${action}${target !== null ? ` p${target}` : ''}${target2 !== null ? ` p${target2}` : ''}]`;
  // "move p3 to p5" is accepted grammar, not a typo: compare with the
  // optional "to" stripped so it is not reported as an auto-correction.
  const rawTag = m?.[0]?.trim();
  const tagNote = rawTag !== undefined && rawTag.replace(/\s+to\s+/i, ' ') !== canonical ? rawTag : null;
  return { action, body, target, target2, tagNote };
}

/** Describe one applied step compactly for the next continuation prompt. */
export function describeAction(outcome: ActionOutcome): string {
  const parts: string[] = [outcome.action];
  if (outcome.target !== null) parts.push(`p${outcome.target}`);
  if (outcome.target2 !== null) parts.push(`p${outcome.target2}`);
  return `[ACTION: ${parts.join(' ')}]`;
}

/**
 * Continuation prompt after a successfully applied edit. The document was
 * just edited, so the fresh context below has the NEW paragraph numbering;
 * the agent must not reuse addresses from before the edit.
 */
export function buildContinuationPrompt(
  contextText: string,
  selection: { hasSelection: boolean; lyxBody: string | null; text: string | null; layout: string | null },
  originalMessage: string,
  completed: string[],
): string {
  const parts = [
    'You are continuing the SAME user request after one edit was applied ' +
      'to the live LyX document. The document context below is FRESH: ' +
      'paragraph addresses ([pN]) may have shifted because of the edit.',
    '',
    'Original user request:', originalMessage,
    '',
    'Edits already applied (do not repeat them):',
    ...completed.map((entry) => `- ${entry}`),
    '',
    'If the request needs MORE edits, END your reply with exactly one ' +
      'document action tag from the action list (rewrite-at, insert-after, ' +
      'insert-before, insert-top, insert, rewrite, delete-at, merge, move) ' +
      'on its own last line, and include the ```lyx block when the action ' +
      'needs content.',
    `If the request is now complete, or you need the user to answer a ` +
      `question, reply in prose only and end with [ACTION: none].`,
    `If you are not sure whether more edits remain, ask one short question ` +
      `with [ACTION: none] instead of guessing.`,
    `The app enforces a safety limit of ${MAX_ACTIONS_PER_MESSAGE} document ` +
      `edits per user message; if that limit is reached it stops and tells ` +
      `the user, who can ask you to continue in a follow-up message.`,
    '',
    CHAT_KNOWLEDGE,
    '',
    contextText,
  ];
  if (selection.hasSelection) {
    parts.push(
      '',
      `Current LyX selection (cursor paragraph layout: ${selection.layout ?? 'unknown'}):`,
      '```lyx',
      selection.lyxBody ?? selection.text ?? '',
      '```',
    );
  }
  return parts.join('\n');
}

/**
 * Format the leading `unseen` turns of a conversation for replay into an
 * agent prompt: one compact line per turn (roles swapped to User/You),
 * action outcomes as short parenthetical notes, whitespace collapsed and
 * each turn truncated to HISTORY_REPLAY_CHAR_LIMIT. Pure and exported for
 * tests. `unseen` is the number of leading turns the agent has not seen
 * (restored from persisted history after an app restart); later turns
 * were produced live by this same agent process and are skipped.
 */
/** Replay rendering shared by the history wrapper and the conversation store. */
const LYX_REPLAY_OPTIONS = {
  blockPattern: /```lyx[\s\S]*?```/g,
  describeTarget: (m: TurnMeta) =>
    `${m.target ? ` p${m.target}` : ''}${m.target2 ? ` p${m.target2}` : ''}`,
};

export function formatHistoryReplay(turns: Turn[], unseen: number): string {
  return coreFormatHistoryReplay(turns, unseen, LYX_REPLAY_OPTIONS);
}

export function buildAutoPrompt(
  contextText: string,
  selection: {
    hasSelection: boolean;
    lyxBody: string | null;
    text: string | null;
    layout: string | null;
  },
  message: string,
  attachments: Attachment[] = [],
  historyPrefix = '',
): string {
  const parts: string[] = [
    'You are assisting an author writing a document in LyX. Your reply is shown ' +
      'in a chat panel, and you can also write content directly into the live ' +
      'LyX document.',
    '',
    'Decide yourself what the user wants, and END your reply with exactly one ' +
      'of these action tags on its own last line:',
    '- [ACTION: none] to reply in prose only (questions, explanations, ' +
      'discussion, outlines, planning).',
    '- [ACTION: insert] to insert NEW content at the CURSOR (its current ' +
      'position, which you do not control): include a ```lyx fenced block. ' +
      'CAREFUL: the paste happens INSIDE the cursor\'s paragraph, so the ' +
      'first pasted paragraph merges into it and takes that paragraph\'s ' +
      'layout — only use this when the user clearly wants the content at ' +
      'the cursor.',
    '- [ACTION: insert-top] to insert NEW content at the VERY BEGINNING of ' +
      'the document (titles, abstracts, anything that belongs above the ' +
      'first paragraph): include a ```lyx fenced block.',
    '- [ACTION: insert-after pN] to insert NEW content as its own ' +
      'paragraph(s) right AFTER paragraph [pN] from the outline (use this ' +
      'when the user asks to add a section/paragraph to the document and ' +
      'the position follows from the outline): include a ```lyx fenced block.',
    '- [ACTION: insert-before pN] to insert NEW content as its own ' +
      'paragraph(s) right BEFORE paragraph [pN] from the outline (e.g. an ' +
      'intro paragraph in front of [pN], or a heading above [pN]; use ' +
      'insert-top for the very beginning of the document): include a ```lyx ' +
      'fenced block.',
    '- [ACTION: rewrite] to REPLACE the currently selected text (given ' +
      'below): include a ```lyx fenced block with the complete replacement.',
    '- [ACTION: delete-at pN] to DELETE the entire paragraph [pN] from the ' +
      'outline (use when the user asks to remove a specific paragraph): ' +
      'NO fenced block, just the tag.',
    '- [ACTION: merge pN pM] to merge two ADJACENT paragraphs [pN] and ' +
      '[pM] into ONE paragraph (M must be N+1; the merged paragraph keeps ' +
      '[pN]\'s layout): NO fenced block, just the tag. To SPLIT one ' +
      'paragraph instead, use [ACTION: rewrite-at pN] with two (or more) ' +
      '```lyx paragraphs in the fenced block — the paragraph is replaced ' +
      'by them, splitting it at the point you choose.',
    '- [ACTION: move pN pM] to MOVE the entire paragraph [pN] so it ends ' +
      'up right AFTER paragraph [pM] (p0 = the very top of the document; ' +
      'use when the user asks to reorder or move a paragraph): NO fenced ' +
      'block, just the tag. N and M are original outline numbers; the app ' +
      'adjusts for the removal. Moving pN after p(N-1) changes nothing, ' +
      'so never emit that.',
    '- [ACTION: rewrite-at pN] to REPLACE the entire paragraph [pN] from ' +
      'the outline (use this when the user asks to modify, fix or remove ' +
      'content in a specific paragraph and nothing is selected): include a ' +
      '```lyx fenced block with the complete replacement paragraph(s).', +
      ' When one request needs SEVERAL edits, apply the FIRST edit now and ' +
      'let the app ask you again with fresh paragraph numbers for the next ' +
      'one — do not try to plan later edits against the current outline.',
    '',
    'Rules for document actions:',
    '- The ```lyx block must contain just the \\begin_layout ... \\end_layout ' +
      'paragraphs (no document header).',
    '- Follow the .lyx cheat-sheet below (token-format emphasis, Formula ' +
      'insets, ...).',
    '- Match the document\'s own conventions: prefer layouts that appear in ' +
      'the outline or in the class layout list of the document context, ' +
      'never invent layout names.',
    '- For a document title or similar front matter use the Title layout ' +
      'and [ACTION: insert-top], NOT insert (insert would land wherever ' +
      'the cursor happens to be).',
    '- For rewrite: output the complete replacement, preserving references, ' +
      'labels and citations unless asked otherwise.',
    '- If nothing is selected you cannot rewrite; choose insert, ' +
      'insert-top, or none.',
    '- The action tag must be the very last line of your reply.',
    '',
    CHAT_KNOWLEDGE,
    '',
    contextText,
  ];
  if (selection.hasSelection) {
    parts.push(
      '',
      `Current LyX selection (cursor paragraph layout: ${selection.layout ?? 'unknown'}). ` +
        'The user may ask you to rewrite it:',
      '```lyx',
      selection.lyxBody ?? selection.text ?? '',
      '```',
    );
  }
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

/** How many characters of an attachment's extracted text go into the prompt. */
/** Extensions the app can read as text directly (no converter needed). */
const TEXTUAL_FILE = /\.(txt|md|markdown|tex|lyx|csv|tsv|json|xml|bib|sty|cls|log|html?|yaml|yml|py|js|ts)$/i;

/**
 * Best-effort text/markdown extraction for an uploaded attachment:
 * text formats are read directly; binary formats (PDF, DOCX, XLSX, ...)
 * go through the markitdown CLI when it is installed (see
 * @acp-assist/core for the converter chain).
 */
export async function extractAttachmentText(
  filePath: string,
  name: string,
): Promise<string | null> {
  return coreExtractAttachmentText(filePath, name, {
    textualFile: TEXTUAL_FILE,
    markitdownEnv: process.env.LYX_MARKITDOWN,
  });
}

/** Corrective retry prompt when the ```lyx block has markup problems. */
function buildMarkupRetryPrompt(action: AgentAction, problems: string[]): string {
  return (
    `Your [ACTION: ${action}] content had problems and must be re-written in ` +
    'valid LyX internal format (.lyx):\n' +
    problems.map((p) => `- ${p}`).join('\n') +
    '\n\nReference example of valid .lyx body markup with emphasis:\n' +
    '```lyx\n\\begin_layout Standard\n\\emph on\nFuture work\n\\emph default\n' +
    ' will explore larger datasets.\n\\end_layout\n```\n' +
    'Math uses \\begin_inset Formula $x^2$\\end_inset. ' +
    'Do NOT use LaTeX inline commands like \\emph{...}.\n' +
    'Reply again with ONLY the corrected ```lyx fenced block ' +
    '(just \\begin_layout...\\end_layout paragraphs, no header), followed by ' +
    `the same action tag [ACTION: ${action}] on its own last line.`
  );
}

/**
 * Normalize text for the paragraph-targeting comparison. Only letters and
 * digits survive (case-insensitive): the .lyx file stores straight quotes
 * and ASCII dashes, while LyX's clipboard text export uses typographic
 * ones, so any punctuation- or whitespace-sensitive comparison would
 * spuriously fail on the same paragraph.
 */
export function normalizeForCompare(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Fuzzy paragraph-targeting match. LyX's UnicodeText export differs from
 * the file's text in ways we cannot normalize away: layout environment
 * labels are prepended ("Abstract", "Summary"), and math insets render
 * inline ($P$ -> "P") while the parser preview has no inset content. So
 * instead of a strict prefix compare, we slide overlapping windows over
 * the expected text and require most of them to appear in the actual
 * text. A genuinely different paragraph (disjoint text) still fails.
 */
export function isLikelyMatch(expected: string, actual: string): boolean {
  if (expected === '') return actual === '';
  const e = expected.slice(0, 160);
  const a = actual.slice(0, 400);
  const WIN = 16;
  const STRIDE = 12;
  let total = 0;
  let hits = 0;
  for (let i = 0; i + WIN <= e.length; i += STRIDE) {
    total++;
    if (a.includes(e.slice(i, i + WIN))) hits++;
  }
  if (total === 0) return a.startsWith(e);
  return hits / total >= 0.6;
}

/**
 * Structure-vs-structure paragraph verification (2026-10-10 refactor).
 *
 * The old check compared our parsed preview against LyX's RENDERED
 * UnicodeText clipboard export — two representations that can never fully
 * agree (math renders differently, typographic quotes, layout-label
 * prefixes, invisible inset properties), so formula-heavy paragraphs
 * failed targeting on the RIGHT paragraph. Now `copy` puts the raw
 * `application/x-lyx` payload of the selection on the clipboard, and we
 * compare markup against markup:
 *
 * 1. 'markup' — exact (whitespace-insensitive) comparison of the
 *    payload's first top-level layout block against the saved file's
 *    block at `index`. Lossless: formulas, notes, refs compare exactly.
 * 2. 'preview' — if LyX re-serialized the copy cosmetically, parse the
 *    payload with OUR parser and fuzzy-match its preview against the
 *    outline preview (both sides from the same parser — the rendered-
 *    text quirks are gone from the comparison).
 * 3. 'text' — legacy last resort when the clipboard holds no x-lyx
 *    payload: the old UnicodeText fuzzy match.
 */
export interface ParagraphSelectionInput {
  /** Raw .lyx clipboard payload of the copied selection, or null. */
  payload: string | null;
  /** UnicodeText clipboard flavor, used only when payload is null. */
  clipboardText: string | null;
  /** The SAVED .lyx file content (the walk addresses against the file). */
  diskRaw: string;
  /** 0-based index of the target paragraph. */
  index: number;
  /** Outline preview of the target paragraph (expected text). */
  expectedPreview: string;
}

export interface ParagraphVerification {
  ok: boolean;
  /** How the match succeeded: 'markup' | 'preview' | 'text' | 'none'. */
  via: 'markup' | 'preview' | 'text' | 'none';
  /** Normalized text of what was actually found (for the error message). */
  actual: string;
}

export function verifyParagraphSelection(
  input: ParagraphSelectionInput,
): ParagraphVerification {
  const expected = normalizeForCompare(input.expectedPreview);

  if (input.payload) {
    const diskBlocks = splitTopLevelLayouts(extractBodyLayouts(input.diskRaw) ?? '');
    const payloadBlocks = splitTopLevelLayouts(extractBodyLayouts(input.payload) ?? '');
    const diskBlock = diskBlocks[input.index] ?? null;
    const payloadBlock = payloadBlocks[0] ?? null;
    if (diskBlock && payloadBlock) {
      if (normalizeMarkupBlock(payloadBlock) === normalizeMarkupBlock(diskBlock)) {
        return { ok: true, via: 'markup', actual: expected };
      }
    }
    // Same-parser fuzzy fallback: tolerates cosmetic re-serialization by
    // LyX, still rejects a genuinely different paragraph.
    let payloadPreview = '';
    try {
      const payloadCtx = buildDocumentContext(input.payload);
      payloadPreview = payloadCtx.outline[0]?.preview ?? '';
    } catch {
      payloadPreview = '';
    }
    const actual = normalizeForCompare(payloadPreview);
    if (payloadPreview && isLikelyMatch(expected, actual)) {
      return { ok: true, via: 'preview', actual };
    }
    return {
      ok: false,
      via: 'none',
      actual: actual || normalizeForCompare(input.payload),
    };
  }

  const actual = normalizeForCompare(input.clipboardText ?? '');
  if (isLikelyMatch(expected, actual)) {
    return { ok: true, via: 'text', actual };
  }
  return { ok: false, via: 'none', actual };
}

/**
 * Layout names defined by a LyX textclass, parsed from its .layout file.
 * Search order: the user's LyX layouts dir (custom/journal classes), then
 * the installation's Resources (article, beamer, ...), then common Linux
 * paths. Returns null when the class file cannot be found.
 *
 * Results are memoized per class: layout files never change mid-session,
 * and the read chain (up to 4-deep Input includes) ran on every prompt
 * build and every continuation step.
 */
const classLayoutsCache = new Map<string, string[] | null>();

export async function findClassLayouts(textclass: string): Promise<string[] | null> {
  const safeClass = textclass.replace(/[^\w.-]+/g, '');
  if (!safeClass) return null;
  if (classLayoutsCache.has(safeClass)) return classLayoutsCache.get(safeClass) ?? null;
  const home = os.homedir();
  const candidates = [
    process.env.LYX_LAYOUTS_DIR,
    process.platform === 'win32'
      ? path.join(process.env.APPDATA ?? home, 'LyX2.5', 'layouts')
      : path.join(home, '.lyx', 'layouts'),
    'C:\\Program Files\\LyX 2.5\\Resources\\layouts',
    '/usr/share/lyx/layouts',
    '/usr/local/share/lyx/layouts',
  ].filter((d): d is string => Boolean(d));
  for (const dir of candidates) {
    const names = await collectStyles(path.join(dir, `${safeClass}.layout`), dir, 0);
    if (names) {
      classLayoutsCache.set(safeClass, names);
      return names;
    }
  }
  classLayoutsCache.set(safeClass, null);
  return null;
}

/**
 * Parse Style names out of a .layout/.inc file, following `Input <file>`
 * includes (e.g. article.layout Inputs stdsections.inc for Section etc.).
 * Returns null if the file itself cannot be read.
 */
async function collectStyles(file: string, dir: string, depth: number): Promise<string[] | null> {
  let raw: string;
  try {
    raw = await fs.readFile(file, 'utf8');
  } catch {
    return null;
  }
  const names = new Set<string>();
  const includes: string[] = [];
  for (const m of raw.matchAll(/^(Input|Include)\s+(\S+)[^\r\n]*$/gm)) {
    if (m[2]) includes.push(m[2]);
  }
  for (const m of raw.matchAll(/^Style\s+(\S[^\r\n]*?)\s*$/gm)) {
    if (m[1]) names.add(m[1].trim());
  }
  if (depth < 4) {
    for (const inc of includes) {
      // Input targets usually already carry the extension (stdclass.inc);
      // some don't. Try as-is, then with the common extensions.
      for (const candidate of [inc, `${inc}.inc`, `${inc}.layout`]) {
        const sub = await collectStyles(path.join(dir, candidate), dir, depth + 1);
        if (sub) {
          for (const n of sub) names.add(n);
          break;
        }
      }
    }
  }
  return [...names];
}

// --- history persistence ---------------------------------------------------

/**
 * Document paths that have persisted chat history, for seeding the document
 * selector on a fresh session. The LyXServer pipe has no "list open
 * buffers" LFUN, so this is the only way to show other tabs after an app
 * restart. Skips the unsaved pseudo-key and paths that no longer exist on
 * disk (file-open on a stale path would reopen or fail in LyX).
 */
export async function listKnownDocuments(historyDir: string): Promise<string[]> {
  return coreListKnownDocuments(historyDir, {
    exists: async (key) => {
      try {
        await fs.access(key);
        return true;
      } catch {
        return false;
      }
    },
  });
}

/** Minimal header used when the document has never been saved. */
const FALLBACK_HEADER = [
  '#LyX 2.5 created this file. For more info see https://www.lyx.org/',
  '\\lyxformat 643',
  '\\begin_document',
  '\\begin_header',
  '\\textclass article',
  '\\use_default_options true',
  '\\language american',
  '\\end_header',
].join('\n');
