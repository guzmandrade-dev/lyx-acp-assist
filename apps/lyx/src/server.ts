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
}

/** Key for the unsaved-document pseudo conversation. */
const UNSAVED_KEY = '(unsaved)';

export interface Session {
  id: string;
  lyx: LyxServerClient;
  clipboard: LyxClipboard;
  agent: AcpClient;
  /** Conversation history per document path. */
  conversations: Map<string, Turn[]>;
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

  const wrap = (handler: (req: express.Request, res: express.Response) => Promise<unknown>) =>
    async (req: express.Request, res: express.Response) => {
      try {
        await handler(req, res);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const status = err instanceof LyxPipeError ? 503 : 500;
        console.error(`[api] ${req.path}: ${message}`);
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

  // --- status ----------------------------------------------------------

  app.get('/api/status', (_req, res) => {
    const probe = new LyxServerClient();
    res.json({ lyxPipeAvailable: probe.isAvailable() });
  });

  // --- session ---------------------------------------------------------

  app.post(
    '/api/session',
    wrap(async (req, res) => {
      const agentSettings = req.body?.agent as AgentSettings | undefined;
      const lyx = new LyxServerClient();
      await lyx.start();

      const agent = new AcpClient({
        command: agentSettings?.command ?? 'opencode',
        args: agentSettings?.args ?? ['acp'],
        env: agentSettings?.env ?? {},
      });
      await agent.start();

      const id = randomUUID();
      const session: Session = {
        id,
        lyx,
        clipboard: new LyxClipboard(options.clipboard),
        agent,
        conversations: new Map(),
        knownDocuments: new Set(),
        documentPath: null,
        cancelRequested: false,
        attachments: [],
      };
      sessions.set(id, session);
      await agent.createSession(id);

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
   * SSE frames: {"text": ...} chunks, then {"applied": "insert"|"rewrite"}
   * or {"action": "none"}, then {"done": true}. Errors/cancellation are
   * sent as {"error": ...} / {"cancelled": true} frames.
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

      const prompt = buildAutoPrompt(contextText, selection, message, attachments);
      let reply = await session.agent.prompt(session.id, [{ type: 'text', text: prompt }], {
        onChunk: (chunk) => send({ text: chunk }),
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
          });
          outcome = parseAction(reply);
        }
      }

      recordTurn(session, message, reply);

      if (session.cancelRequested) {
        send({ cancelled: true });
      } else if (outcome.action === 'none') {
        send({ action: 'none' });
      } else {
        // A write action: position the cursor, then paste.
        if (!outcome.body) {
          send({ error: `Agent chose [ACTION: ${outcome.action}] but returned no \`\`\`lyx block.` });
          send({ done: true });
          res.end();
          return;
        }
        let positionError: string | null = null;
        let target = outcome.target;
        if (outcome.action === 'rewrite' && !selection.hasSelection) {
          positionError = 'Agent chose [ACTION: rewrite] but LyX has no active selection.';
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
          const gotoResult = await gotoParagraph(session, outcome.target);
          target = gotoResult.target;
          positionError = gotoResult.error;
        }
        if (positionError) {
          send({ error: positionError });
        } else {
          const header = (await currentHeader(session)) ?? FALLBACK_HEADER;
          const doc = assemblePasteDocument(header, outcome.body);
          await session.clipboard.writeLyxDocument(doc, outcome.body);
          await session.lyx.paste(); // replaces the active selection if any
          send({ applied: outcome.action, target });
        }
      }
      send({ done: true });
      res.end();
    } catch (err) {
      const message2 = err instanceof Error ? err.message : String(err);
      console.error(`[api] message/stream: ${message2}`);
      if (!res.headersSent) {
        res.status(err instanceof LyxPipeError ? 503 : 500).json({ error: message2 });
      } else {
        sseFail(res, err);
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
      ensureConversation(session, path);
    } else {
      ensureConversation(session, UNSAVED_KEY);
    }
    return path;
  }

  function conversationKey(session: Session): string {
    return session.documentPath ?? UNSAVED_KEY;
  }

  function ensureConversation(session: Session, key: string): Turn[] {
    let turns = session.conversations.get(key);
    if (!turns) {
      turns = [];
      session.conversations.set(key, turns);
      // Load persisted history if available.
      if (options.historyDir) {
        loadHistory(options.historyDir, key).then(
          (saved) => turns!.push(...saved),
          () => undefined,
        );
      }
    }
    return turns;
  }

  async function recordTurn(session: Session, user: string, assistant: string) {
    const key = conversationKey(session);
    const turns = ensureConversation(session, key);
    turns.push(
      { role: 'user', content: user, timestamp: new Date().toISOString() },
      { role: 'assistant', content: assistant, timestamp: new Date().toISOString() },
    );
    if (options.historyDir) {
      saveHistory(options.historyDir, key, turns).catch((e) =>
        console.error(`[history] save failed: ${e}`),
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
    const filePath = session.documentPath;
    if (!filePath) throw new Error('Document is not saved on disk.');
    const raw = await fs.readFile(filePath, 'utf8');
    return buildDocumentContext(raw);
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
      return (
        `Document context\n` +
        `================\n` +
        `File: ${session.documentPath}\n` +
        `Text class: ${ctx.textclass ?? 'unknown'}\n` +
        `LyX format: ${ctx.formatVersion ?? 'unknown'}\n` +
        `Cursor paragraph layout: ${layout}\n\n` +
        `Document outline ([pN] ids address paragraphs):\n${renderOutline(ctx.outline)}\n\n` +
        `Full body (.lyx markup):\n${ctx.body}\n`
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
   * Move the cursor onto paragraph [pN] and select the whole paragraph.
   * Verifies the target by copying the selection and comparing its text
   * with the outline preview — a mis-targeted paste never happens; on
   * mismatch we return an error and nothing is pasted.
   */
  async function gotoParagraph(
    session: Session,
    target: number | null,
  ): Promise<{ target: number | null; error: string | null }> {
    if (!target || target < 1) {
      return {
        target,
        error: 'Agent chose [ACTION: rewrite-at] without a valid paragraph number.',
      };
    }
    const fail = async (error: string): Promise<{ target: number | null; error: string }> => {
      // Our paragraph-select may have selected the wrong paragraph; a
      // selection persists in LyX and would pollute later commands.
      await session.lyx.clearSelection();
      return { target, error };
    };
    let ctx;
    try {
      ctx = await readDocumentContext(session);
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
    // Verify the target by copying and comparing with the outline preview.
    const copied = await session.lyx.copySelection();
    if (!copied) {
      return fail('Could not copy the selected paragraph for verification.');
    }
    await sleep(150);
    const text = await session.clipboard.readText();
    const actual = normalizeForCompare(text ?? '');
    const expected = normalizeForCompare(entry.preview);
    const cmpLen = Math.min(actual.length, expected.length, 60);
    const isMatch =
      expected === '' ? actual === '' : cmpLen > 0 && actual.slice(0, cmpLen) === expected.slice(0, cmpLen);
    if (!isMatch) {
      return fail(
        `Paragraph targeting failed: [p${target}] should start with ` +
          `"${expected.slice(0, 60)}\u2026" but the cursor landed on ` +
          `"${actual.slice(0, 60)}\u2026". Nothing was pasted.`,
      );
    }
    return { target, error: null };
  }
  return app;
}

// --- agent action parsing / prompt building -------------------------------

type AgentAction = 'none' | 'insert' | 'insert-top' | 'rewrite' | 'rewrite-at';

interface ActionOutcome {
  action: AgentAction;
  body: string | null;
  /** Paragraph address [pN] for rewrite-at. */
  target: number | null;
}

/** Extract the trailing [ACTION: ...] tag and the ```lyx block from a reply. */
export function parseAction(reply: string): ActionOutcome {
  const m = reply.match(/\[ACTION:\s*(rewrite-at|insert-top|rewrite|insert|none)(?:\s+p(\d+))?\s*\]/i);
  const action = ((m?.[1] ?? 'none').toLowerCase() as AgentAction);
  const target = m?.[2] ? Number.parseInt(m[2], 10) : null;
  const body = action === 'none' ? null : extractBodyLayouts(reply);
  return { action, body, target };
}

/** Build the unified "agent decides" prompt for a user message. */
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
      'position, which you do not control): include a ```lyx fenced block.',
    '- [ACTION: insert-top] to insert NEW content at the VERY BEGINNING of ' +
      'the document (titles, abstracts, anything that belongs above the ' +
      'first paragraph): include a ```lyx fenced block.',
    '- [ACTION: rewrite] to REPLACE the currently selected text (given ' +
      'below): include a ```lyx fenced block with the complete replacement.',
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

// --- history persistence ---------------------------------------------------

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
