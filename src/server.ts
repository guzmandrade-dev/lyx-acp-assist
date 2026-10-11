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

import { randomUUID, createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import express from 'express';
import type { ContentBlock } from '@agentclientprotocol/sdk';
import { LyxServerClient, LyxPipeError } from './lyxserver/client.js';
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
} from './lyx/context.js';
import { CHAT_KNOWLEDGE } from './lyx/knowledge.js';
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
  /**
   * Outcome of the action the assistant proposed in this turn, recorded
   * after the action was applied (or failed). Absent on older histories
   * and on turns before this feature existed.
   */
  meta?: TurnMeta;
}

/** How the action a turn proposed was resolved against the document. */
export interface TurnMeta {
  /** The action tag the agent emitted, e.g. "insert", "move", "none". */
  action: string;
  /** Paragraph address for addressed actions ([pN]). */
  target?: number | null;
  /** Destination address for move/merge ([pM]). */
  target2?: number | null;
  /** "applied" when the action landed in LyX, "error" when it failed. */
  result: 'applied' | 'error' | 'cancelled';
  /** The error message when result is "error". */
  error?: string;
}

/** Key for the unsaved-document pseudo conversation. */
const UNSAVED_KEY = '(unsaved)';

/**
 * Conversation-history replay after an app restart: the agent process is
 * new and has no memory, so it must be briefed on the turns it missed.
 * A turn counts as "replayed" once it has been sent in one prompt.
 */
const HISTORY_REPLAY_LIMIT = 20;
/** Per-turn character cap when replaying history into a prompt. */
const HISTORY_REPLAY_CHAR_LIMIT = 500;

/**
 * Documents with a body larger than this attach only their outline to
 * prompts; the agent then reads/searches the saved file with its own
 * tools (lazy fetch, like a coding agent in a repository).
 */
const OUTLINE_ONLY_BODY_LIMIT = 16_000;

export interface Session {
  id: string;
  lyx: LyxServerClient;
  clipboard: LyxClipboard;
  agent: AcpClient;
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
}

/** A file the user attached to the next message. */
export interface Attachment {
  id: string;
  name: string;
  /** Absolute path of the stored file (agents with file tools can read it). */
  path: string;
  /** Extracted markdown/plain text, when conversion succeeded. */
  text: string | null;
}

export function createServer(options: ServerOptions) {
  const app = express();
  app.use(express.json({ limit: '50mb' }));
  app.use(express.static(options.publicDir, { maxAge: 0, etag: false, lastModified: false }));

  const sessions = new Map<string, Session>();

  /** Append a timestamped line to the persistent error log (best-effort). */
  function logError(scope: string, err: unknown): void {
    const message = err instanceof Error ? err.message : String(err);
    const line = `[${new Date().toISOString()}] ${scope}: ${message}\n`;
    console.error(line.trim());
    if (options.logDir) {
      fs.appendFile(path.join(options.logDir, 'errors.log'), line, 'utf8').catch(() => {
        /* logging must never break the request path */
      });
    }
  }

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

  /** Start an SSE response; returns the frame sender. */
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

  /** End an already-started SSE response with an error frame. */
  const sseFail = (res: express.Response, err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    res.write(`data: ${JSON.stringify({ error: message })}\n\n`);
    res.write('data: {"done":true}\n\n');
    res.end();
  };

  /**
   * Record the outcome of the action the assistant proposed in the LAST
   * turn of the conversation (the one just recorded by recordTurn), so a
   * failed or successful document action survives an app restart and is
   * visible when the history is reloaded.
   */
  async function recordTurnMeta(session: Session, meta: TurnMeta): Promise<void> {
    const key = conversationKey(session);
    const turns = await ensureConversation(session, key);
    const last = turns[turns.length - 1];
    if (!last || last.role !== 'assistant') return;
    last.meta = meta;
    if (options.historyDir) {
      saveHistory(options.historyDir, key, turns).catch((e) =>
        logError('[history] save failed', e),
      );
    }
  }

  // --- status ----------------------------------------------------------

  app.get('/api/status', (_req, res) => {
    const probe = new LyxServerClient();
    res.json({ lyxPipeAvailable: probe.isAvailable() });
  });

  // --- settings (persisted server-side; the server port is random per
  // launch, so localStorage — origin-scoped — would not survive a restart) ---

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
        // No persistence configured (tests): echo back, nothing is stored.
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

  /** Validate and normalize the JSON body of PUT /api/settings/agent. */
  function readAgentSettingsBody(body: unknown): Partial<AgentSettings> {
    const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
    const out: Partial<AgentSettings> = {};
    if (typeof b.command === 'string') out.command = b.command.trim();
    if (typeof b.args === 'string') out.args = b.args.trim().split(/\s+/).filter(Boolean);
    else if (Array.isArray(b.args)) {
      const args = b.args.filter((a): a is string => typeof a === 'string' && a.trim().length > 0);
      if (args.length > 0) out.args = args;
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

  // --- session ---------------------------------------------------------

  app.post(
    '/api/session',
    wrap(async (req, res) => {
      // Defaults < persisted settings < explicit request body.
      const persisted = await readAgentSettingsFile();
      const requested = req.body?.agent as Partial<AgentSettings> | undefined;
      const lyx = new LyxServerClient();
      await lyx.start();

      const agent = new AcpClient({
        command: requested?.command ?? persisted.command ?? 'opencode',
        args: requested?.args ?? persisted.args ?? ['acp'],
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
        knownDocuments: new Set(),
        documentPath: null,
        cancelRequested: false,
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

      res.json(await sessionInfo(session));
    }),
  );

  // --- context ---------------------------------------------------------

  app.get(
    '/api/session/:id',
    wrap(async (req, res) => {
      const session = getSession(req.params['id']);
      res.json(await sessionInfo(session));
    }),
  );

  /** Tear down a session: stop the agent process and pipe client. */
  app.delete(
    '/api/session/:id',
    wrap(async (req, res) => {
      const session = getSession(req.params['id']);
      sessions.delete(session.id);
      session.agent.stop();
      session.lyx.stop();
      res.json({ ok: true });
    }),
  );

  /** Stop the current generation without tearing the session down. */
  app.post(
    '/api/session/:id/cancel',
    wrap(async (req, res) => {
      const session = getSession(req.params['id']);
      session.cancelRequested = true;
      session.agent.cancel(session.id);
      res.json({ ok: true });
    }),
  );

  // --- attachments -------------------------------------------------------

  /** Store an uploaded file for the next message (base64 JSON body). */
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

  /** Drop a pending attachment before it is sent. */
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

  // --- documents ---------------------------------------------------------

  /** List known documents and which one is active right now. */
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
      await sleep(200); // let the view settle
      const active = await refreshActiveDocument(session);
      res.json({ active, documents: [...session.knownDocuments] });
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
   * SSE frames: {"text": ...} chunks, {"tool": {title, status}} for
   * agent tool activity, then {"applied": "insert"|"rewrite"}
   * or {"action": "none"}, then {"done": true}. Errors/cancellation
   * are sent as {"error": ...} / {"cancelled": true} frames.
   */
  app.post('/api/session/:id/message/stream', async (req, res) => {
    const session = sessions.get(param(req.params['id']));
    if (!session) {
      res.status(404).json({ error: 'Unknown session' });
      return;
    }
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

    try {
      await refreshActiveDocument(session);
      // Read path per architecture: save the buffer first so the outline
      // and body parsed from disk match the live document. Only for saved
      // buffers — buffer-write on an untitled buffer opens a Save As dialog.
      if (session.documentPath) await session.lyx.save();
      const contextText = await buildContextBlock(session);
      const selection = await readSelection(session);
      const send = startSse(res);
      session.cancelRequested = false;

      // Attachments are consumed by this message (chat-app semantics).
      const attachments = session.attachments;
      session.attachments = [];

      const historyPrefix = buildHistoryPrefix(session, conversationKey(session));
      const prompt = buildAutoPrompt(contextText, selection, message, attachments, historyPrefix);
      // The replayed (pre-restart) turns are in this prompt now, so the
      // agent knows them; only turns recorded from here on are new to it.
      // Without clearing, a second message after a restart would replay
      // the same history again.
      if (historyPrefix) {
        session.historyHandoff.delete(conversationKey(session));
      }
      let reply = await session.agent.prompt(session.id, [{ type: 'text', text: prompt }], {
        onChunk: (chunk) => send({ text: chunk }),
        onToolCall: (tool) => send({ tool }),
        timeoutMs: 240_000,
      });
      let outcome = parseAction(reply);

      // If the agent wants to write into the document, validate the markup
      // and retry once with a corrective prompt (VRP pattern).
      if (!session.cancelRequested && outcome.action !== 'none' && outcome.body) {
        const problems = findMarkupProblems(outcome.body);
        if (problems.length > 0) {
          const retry = buildMarkupRetryPrompt(outcome.action, problems);
          reply = await session.agent.prompt(session.id, [{ type: 'text', text: retry }], {
            onChunk: (chunk) => send({ text: `\n${chunk}` }),
            onToolCall: (tool) => send({ tool }),
          });
          outcome = parseAction(reply);
        }
      }

      recordTurn(session, message, reply);
      turnRecorded = true;
      lastAction = outcome.action;
      lastTarget = outcome.target;
      lastTarget2 = outcome.target2;

      if (session.cancelRequested) {
        send({ cancelled: true });
        await recordTurnMeta(session, {
          action: outcome.action, target: outcome.target, target2: outcome.target2,
          result: 'cancelled',
        });
      } else if (outcome.action === 'none') {
        send({ action: 'none' });
        await recordTurnMeta(session, {
          action: 'none', target: null, target2: null, result: 'applied',
        });
      } else if (outcome.action === 'delete-at') {
        // Delete needs no ```lyx block: walk, verify, select, delete the
        // text, then merge the leftover empty paragraph away.
        const gotoResult = await gotoParagraph(session, outcome.target, 'rewrite');
        if (gotoResult.error) {
          send({ error: gotoResult.error });
          await recordTurnMeta(session, {
            action: 'delete-at', target: outcome.target, target2: null,
            result: 'error', error: gotoResult.error,
          });
        } else {
          const deleted = await session.lyx.deleteSelection();
          if (deleted) {
            await session.lyx.mergeAwayParagraph();
            send({ applied: 'delete-at', target: outcome.target });
            await recordTurnMeta(session, {
              action: 'delete-at', target: outcome.target, target2: null, result: 'applied',
            });
          } else {
            const err = `LyX could not delete paragraph [p${outcome.target}].`;
            send({ error: err });
            await recordTurnMeta(session, {
              action: 'delete-at', target: outcome.target, target2: null,
              result: 'error', error: err,
            });
          }
        }
      } else if (outcome.action === 'merge') {
        // Merge needs no ```lyx block: walk + verify + collapse to the end
        // of [pN], then delete-forward merges [p(N+1)] into it.
        const result = await mergeParagraph(session, outcome.target, outcome.target2);
        if (result.error) {
          send({ error: result.error });
          await recordTurnMeta(session, {
            action: 'merge', target: outcome.target, target2: outcome.target2,
            result: 'error', error: result.error,
          });
        } else {
          send({ applied: 'merge', target: outcome.target, target2: outcome.target2 });
          await recordTurnMeta(session, {
            action: 'merge', target: outcome.target, target2: outcome.target2, result: 'applied',
          });
        }
      } else if (outcome.action === 'move') {
        // Move needs no ```lyx block: capture the paragraph via the
        // clipboard, delete it, then re-paste at the adjusted destination.
        const result = await moveParagraph(session, outcome.target, outcome.target2);
        if (result.error) {
          send({ error: result.error });
          await recordTurnMeta(session, {
            action: 'move', target: outcome.target, target2: outcome.target2,
            result: 'error', error: result.error,
          });
        } else {
          send({ applied: 'move', target: outcome.target, target2: outcome.target2 });
          await recordTurnMeta(session, {
            action: 'move', target: outcome.target, target2: outcome.target2, result: 'applied',
          });
        }
      } else {
        // A write action: position the cursor, then paste.
        if (!outcome.body) {
          const err = `Agent chose [ACTION: ${outcome.action}] but returned no \`\`\`lyx block.`;
          send({ error: err });
          await recordTurnMeta(session, {
            action: outcome.action, target: outcome.target, target2: outcome.target2,
            result: 'error', error: err,
          });
          send({ done: true });
          res.end();
          return;
        }
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
          send({ error: positionError });
          await recordTurnMeta(session, {
            action: outcome.action, target: outcome.target, target2: outcome.target2,
            result: 'error', error: positionError,
          });
        } else {
          const header = (await currentHeader(session)) ?? FALLBACK_HEADER;
          const doc = assemblePasteDocument(header, outcome.body);
          const written = await session.clipboard.writeLyxDocumentVerified(doc, outcome.body);
          if (!written) {
            const err =
              'The .lyx payload could not be written to the clipboard; ' +
              'nothing was pasted. Please try again.';
            send({ error: err });
            await recordTurnMeta(session, {
              action: outcome.action, target: outcome.target, target2: outcome.target2,
              result: 'error', error: err,
            });
          } else {
            await sleep(100); // let the OS clipboard settle before paste
            await session.lyx.paste(); // replaces the active selection if any
            send({ applied: outcome.action, target });
            await recordTurnMeta(session, {
              action: outcome.action, target, target2: outcome.target2, result: 'applied',
            });
          }
        }
      }
      send({ done: true });
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
  async function ensureConversation(session: Session, key: string): Promise<Turn[]> {
      let turns = session.conversations.get(key);
      if (!turns) {
        turns = [];
        session.conversations.set(key, turns);
        // Load persisted history if available.
        if (options.historyDir) {
          try {
            const loaded = await loadHistory(options.historyDir, key);
            turns.push(...loaded);
            // These turns predate this process: the agent cannot see them
            // unless we replay them (it has no memory across restarts).
            session.historyHandoff.set(key, loaded.length);
          } catch {
            /* unreadable history — start empty */
          }
        }
      }
      return turns;
    }

    /**
     * Number of LEADING turns in the conversation the current agent process
     * has NOT seen: they were loaded from the persisted history file (app
     * restart / reconnect) and must be replayed into the next prompt.
     * Zero once replayed or when every turn was produced live by this agent.
     */
    function unseenCount(session: Session, key: string): number {
      return session.historyHandoff.get(key) ?? 0;
    }

    /**
     * Render the turns the agent has not seen (pre-restart history) as a
     * compact context block. Empty string when the agent already knows the
     * whole conversation.
     */
    function buildHistoryPrefix(session: Session, key: string): string {
      const turns = session.conversations.get(key) ?? [];
      return formatHistoryReplay(turns, unseenCount(session, key));
    }

  async function recordTurn(session: Session, user: string, assistant: string) {
    const key = conversationKey(session);
    const turns = await ensureConversation(session, key);
    turns.push(
      { role: 'user', content: user, timestamp: new Date().toISOString() },
      { role: 'assistant', content: assistant, timestamp: new Date().toISOString() },
    );
    if (options.historyDir) {
      saveHistory(options.historyDir, key, turns).catch((e) =>
        logError('[history] save failed', e),
      );
    }
  }

  async function sessionInfo(session: Session) {
    const docPath = await refreshActiveDocument(session);
    let outline = '';
    let layout = '';
    try {
      layout = await session.lyx.getLayout();
      const ctx = await readDocumentContext(session);
      outline = renderOutline(ctx.outline);
    } catch {
      /* document may be unsaved; outline unavailable */
    }
    return {
      sessionId: session.id,
      documentPath: docPath,
      documents: [...session.knownDocuments],
      layout,
      outline,
      conversation: session.conversations.get(conversationKey(session)) ?? [],
    };
  }

  async function readDocumentContext(session: Session) {
    return buildDocumentContext(await readDocumentRaw(session));
  }

  async function readDocumentRaw(session: Session): Promise<string> {
    const filePath = session.documentPath;
    if (!filePath) throw new Error('Document is not saved on disk.');
    return fs.readFile(filePath, 'utf8');
  }

  async function currentHeader(session: Session): Promise<string | null> {
    try {
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
        `Cursor paragraph layout: ${layout}\n\n` +
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
        // Give LyX a moment to put the payload on the clipboard.
        await sleep(150);
        const doc = await session.clipboard.readLyxDocument();
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
      raw = await readDocumentRaw(session);
      ctx = buildDocumentContext(raw);
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
    await sleep(150);
    const payload = await session.clipboard.readLyxDocument();
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
    await session.lyx.save();

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
    await sleep(100); // let the OS clipboard settle before paste
    await session.lyx.paste();
    return { target2: to, error: null };
  }
  return app;
}

// --- agent action parsing / prompt building -------------------------------

type AgentAction =
  | 'none'
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
}

/** Extract the trailing [ACTION: ...] tag and the ```lyx block from a reply. */
export function parseAction(reply: string): ActionOutcome {
  const m = reply.match(
    /\[ACTION:\s*(merge|move|delete-at|rewrite-at|insert-before|insert-after|insert-top|rewrite|insert|none)(?:\s+p(\d+))?(?:\s+(?:to\s+)?p(\d+))?\s*\]/i,
  );
  const action = ((m?.[1] ?? 'none').toLowerCase() as AgentAction);
  const target = m?.[2] ? Number.parseInt(m[2], 10) : null;
  const target2 = m?.[3] ? Number.parseInt(m[3], 10) : null;
  const body = action === 'none' ? null : extractBodyLayouts(reply);
  return { action, body, target, target2 };
}

/** Build the unified "agent decides" prompt for a user message. */
/**
 * Format the leading `unseen` turns of a conversation for replay into an
 * agent prompt: one compact line per turn (roles swapped to User/You),
 * action outcomes as short parenthetical notes, whitespace collapsed and
 * each turn truncated to HISTORY_REPLAY_CHAR_LIMIT. Pure and exported for
 * tests. `unseen` is the number of leading turns the agent has not seen
 * (restored from persisted history after an app restart); later turns
 * were produced live by this same agent process and are skipped.
 */
export function formatHistoryReplay(turns: Turn[], unseen: number): string {
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
      // tag and any ```lyx block (the meta line below reports the outcome).
      .replace(/```lyx[\s\S]*?```/g, '')
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
        lines.push(`  (applied [ACTION: ${m.action}${m.target ? ` p${m.target}` : ''}${m.target2 ? ` p${m.target2}` : ''}] in the document)`);
      } else if (m.result === 'error') {
        lines.push(`  (action ${m.action} FAILED: ${m.error ?? 'unknown error'})`);
      } else if (m.result === 'cancelled') {
        lines.push(`  (action ${m.action} was cancelled before applying)`);
      }
    }
  }
  return '\n' + lines.join('\n');
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
      '```lyx fenced block with the complete replacement paragraph(s).',
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
const ATTACHMENT_TEXT_LIMIT = 40_000;

/** Extensions the app can read as text directly (no converter needed). */
const TEXTUAL_FILE = /\.(txt|md|markdown|tex|lyx|csv|tsv|json|xml|bib|sty|cls|log|html?|yaml|yml|py|js|ts)$/i;

/**
 * Best-effort text/markdown extraction for an uploaded attachment:
 * text formats are read directly; binary formats (PDF, DOCX, XLSX, ...)
 * go through the markitdown CLI when it is installed.
 */
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

/**
 * Converter candidates, most preferred first: LYX_MARKITDOWN env override,
 * then `markitdown` on PATH, then `uvx markitdown`, then the markitdown-mcp
 * venv (the same install the markitdown MCP server uses on this machine).
 */
function markitdownCandidates(): string[] {
  const candidates: string[] = [];
  if (process.env.LYX_MARKITDOWN) candidates.push(process.env.LYX_MARKITDOWN);
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
 */
export async function findClassLayouts(textclass: string): Promise<string[] | null> {
  const safeClass = textclass.replace(/[^\w.-]+/g, '');
  if (!safeClass) return null;
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
    if (names) return names;
  }
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
  let entries: string[];
  try {
    entries = await fs.readdir(historyDir);
  } catch {
    return [];
  }
  const paths: string[] = [];
  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue;
    try {
      const raw = await fs.readFile(path.join(historyDir, entry), 'utf8');
      const data = JSON.parse(raw) as { key?: string };
      const key = data.key;
      if (typeof key !== 'string' || key === UNSAVED_KEY) continue;
      await fs.access(key);
      paths.push(key);
    } catch {
      /* unreadable entry or missing document — skip */
    }
  }
  return paths;
}

function historyFile(dir: string, conversationKey: string): string {
  const hash = createHash('sha256').update(conversationKey).digest('hex').slice(0, 16);
  return path.join(dir, `${hash}.json`);
}

async function loadHistory(dir: string, conversationKey: string): Promise<Turn[]> {
  try {
    const raw = await fs.readFile(historyFile(dir, conversationKey), 'utf8');
    const data = JSON.parse(raw) as { key?: string; turns: Turn[] };
    if (data.key !== conversationKey) return []; // hash collision guard
    return Array.isArray(data.turns) ? data.turns : [];
  } catch {
    return [];
  }
}

async function saveHistory(dir: string, conversationKey: string, turns: Turn[]): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
  const payload = JSON.stringify({ key: conversationKey, turns }, null, 2);
  await fs.writeFile(historyFile(dir, conversationKey), payload, 'utf8');
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
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
