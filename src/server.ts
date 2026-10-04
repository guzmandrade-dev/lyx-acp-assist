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
import { LYX_MARKUP_KNOWLEDGE, CHAT_KNOWLEDGE } from './lyx/knowledge.js';
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
}

export interface ServerOptions {
  publicDir: string;
  clipboard: RawClipboard;
  /** Directory for persisted chat history (per document). Optional. */
  historyDir?: string;
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

  // --- chat (streaming) ----------------------------------------------------

  /**
   * Streaming chat: responds with `text/event-stream`, one `data:` line
   * per chunk (`{"text": "..."}`), ending with `data: {"done": true}`.
   */
  app.post('/api/session/:id/chat/stream', async (req, res) => {
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

    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    const send = (obj: unknown) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
    const fail = (err: unknown) => {
      send({ error: err instanceof Error ? err.message : String(err) });
      send({ done: true });
      res.end();
    };

    try {
      await refreshActiveDocument(session);
      const contextText = await buildContextBlock(session);
      const content: ContentBlock[] = [];
      if (contextText) content.push({ type: 'text', text: contextText });
      content.push({ type: 'text', text: CHAT_KNOWLEDGE });
      content.push({ type: 'text', text: message });

      const reply = await session.agent.prompt(session.id, content, {
        onChunk: (chunk) => send({ text: chunk }),
        timeoutMs: 240_000,
      });
      recordTurn(session, message, reply);
      send({ done: true });
      res.end();
    } catch (err) {
      console.error(`[api] chat/stream: ${err instanceof Error ? err.message : err}`);
      fail(err);
    }
  });

  // --- rewrite selection -----------------------------------------------

  app.post(
    '/api/session/:id/rewrite-selection',
    wrap(async (req, res) => {
      const session = getSession(req.params['id']);
      const instruction = (req.body?.message as string | undefined)?.trim() || 'Improve this text.';

      await refreshActiveDocument(session);
      const selection = await readSelection(session);
      if (!selection.hasSelection) {
        res.status(400).json({ error: 'No selection in LyX. Select text and try again.' });
        return;
      }

      const prompt =
        'You are helping an author revise a document in LyX. Below is the selected ' +
        'content in the LyX internal format (.lyx markup; `\\begin_layout` blocks; ' +
        'insets like `\\begin_inset Formula` hold LaTeX). ' +
        (selection.layout ? `The cursor paragraph layout is: ${selection.layout}. ` : '') +
        'Rewrite the selection according to this instruction: ' +
        `"${instruction}"\n\n` +
        `${LYX_MARKUP_KNOWLEDGE}\n\n` +
        'Rules:\n' +
        '- Preserve the meaning; keep references, labels and citations intact.\n' +
        '- Keep the .lyx markup valid and minimal.\n' +
        '- Emphasis uses LyX token format, NOT LaTeX: "\\emph on\\nyour text\\n\\emph default".\n' +
        '- Math uses \\begin_inset Formula $...$\\end_inset.\n' +
        '- Reply with the rewritten content ONLY inside a single ```lyx fenced block,\n' +
        '  containing just the `\\begin_layout ... \\end_layout` paragraphs (no header).\n' +
        '- After the fenced block, optionally add one short sentence explaining changes.\n\n' +
        `Selected content:\n\`\`\`lyx\n${selection.lyxBody ?? selection.text}\n\`\`\``;

      const { body: bodyLayouts, reply } = await getValidatedBody(session, prompt, 'rewrite');
      if (!bodyLayouts) {
        recordTurn(session, `Rewrite selection: ${instruction}`, reply);
        res.status(422).json({
          error: 'Agent did not return a ```lyx block. Ask it to retry or paste manually.',
          reply,
        });
        return;
      }

      const header = (await currentHeader(session)) ?? FALLBACK_HEADER;
      const doc = assemblePasteDocument(header, bodyLayouts);
      await session.clipboard.writeLyxDocument(doc, bodyLayouts);
      await session.lyx.paste(); // replaces the still-active selection

      recordTurn(session, `Rewrite selection: ${instruction}`, reply);
      res.json({ reply, pasted: true });
    }),
  );

  // --- insert at cursor --------------------------------------------------

  app.post(
    '/api/session/:id/insert',
    wrap(async (req, res) => {
      const session = getSession(req.params['id']);
      const instruction = (req.body?.message as string | undefined)?.trim();
      if (!instruction) {
        res.status(400).json({ error: 'message is required' });
        return;
      }

      await refreshActiveDocument(session);
      const contextText = await buildContextBlock(session);
      const prompt =
        'You are helping an author write in LyX. The content you generate will be ' +
        'pasted at the cursor as rich LyX content (.lyx markup).\n\n' +
        `${LYX_MARKUP_KNOWLEDGE}\n\n` +
        'Rules:\n' +
        '- Reply with the content ONLY inside a single ```lyx fenced block, containing\n' +
        '  just the `\\begin_layout ... \\end_layout` paragraphs (no header).\n' +
        '- Use LyX markup conventions from the cheat-sheet above.\n' +
        '- Match the surrounding document style.\n\n' +
        (contextText ? `Document context:\n${contextText}\n\n` : '') +
        `Write (at the cursor): ${instruction}`;

      const { body: bodyLayouts, reply } = await getValidatedBody(session, prompt, 'insert');
      if (!bodyLayouts) {
        recordTurn(session, `Insert: ${instruction}`, reply);
        res.status(422).json({
          error: 'Agent did not return a ```lyx block. Ask it to retry.',
          reply,
        });
        return;
      }

      const header = (await currentHeader(session)) ?? FALLBACK_HEADER;
      const doc = assemblePasteDocument(header, bodyLayouts);
      await session.clipboard.writeLyxDocument(doc, bodyLayouts);
      await session.lyx.paste();

      recordTurn(session, `Insert: ${instruction}`, reply);
      res.json({ reply, pasted: true });
    }),
  );

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
    const hasSelection = stats[0] > 0;
    let lyxBody: string | null = null;
    let text: string | null = null;
    let layout: string | null = null;
    if (hasSelection) {
      await session.lyx.copySelection();
      // Give LyX a moment to put the payload on the clipboard.
      await sleep(150);
      const doc = await session.clipboard.readLyxDocument();
      if (doc) {
        lyxBody = extractBodyLayouts(doc) ?? doc;
        text = await session.clipboard.readText();
      }
      layout = await session.lyx.tryRequest('server-get-layout');
    }
    return { hasSelection, stats, lyxBody, text, layout };
  }

  async function getValidatedBody(
    session: Session,
    prompt: string,
    purpose: string,
  ): Promise<{ body: string | null; reply: string }> {
    let reply = await session.agent.prompt(session.id, [{ type: 'text', text: prompt }]);
    let body = extractBodyLayouts(reply);
    const problems = body ? findMarkupProblems(body) : ['No ```lyx fenced block found.'];

    if (problems.length > 0) {
      // One retry, showing the agent exactly what was wrong (VRP pattern).
      const retry =
        `Your ${purpose} content had problems and must be re-written in valid LyX ` +
        'internal format (.lyx):\n' +
        problems.map((p) => `- ${p}`).join('\n') +
        '\n\nReference example of valid .lyx body markup with emphasis:\n' +
        '```lyx\n\\begin_layout Standard\n\\emph on\nFuture work\n\\emph default\n' +
        ' will explore larger datasets.\n\\end_layout\n```\n' +
        'Math uses \\begin_inset Formula $x^2$\\end_inset. ' +
        'Do NOT use LaTeX inline commands like \\emph{...}.\n' +
        'Reply again with ONLY the corrected ```lyx fenced block ' +
        '(just \\begin_layout...\\end_layout paragraphs, no header).';
      reply = await session.agent.prompt(session.id, [{ type: 'text', text: retry }]);
      body = extractBodyLayouts(reply);
    }
    return { body, reply };
  }

  return app;
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