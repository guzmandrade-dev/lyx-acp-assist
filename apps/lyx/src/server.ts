/**
 * Express API + session orchestration for the LyX ACP companion app.
 *
 * One session = one LyX document (via the running LyX instance) + one ACP
 * agent conversation. All document reads go through the pipe + the saved
 * `.lyx` file; all writes go through the pipe (`paste` via the
 * `application/x-lyx` clipboard), so LyX remains the single writer of truth.
 */

import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
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

export interface Session {
  id: string;
  lyx: LyxServerClient;
  clipboard: LyxClipboard;
  agent: AcpClient;
  conversation: { role: 'user' | 'assistant'; content: string; timestamp: string }[];
  documentPath: string | null;
}

export interface ServerOptions {
  publicDir: string;
  clipboard: RawClipboard;
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

  app.get('/api/status', (req, res) => {
    const probe = new LyxServerClient();
    res.json({
      lyxPipeAvailable: probe.isAvailable(),
    });
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
        conversation: [],
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

  // --- selection -------------------------------------------------------

  app.get(
    '/api/session/:id/selection',
    wrap(async (req, res) => {
      const session = getSession(req.params['id']);
      res.json(await readSelection(session));
    }),
  );

  // --- chat ------------------------------------------------------------

  app.post(
    '/api/session/:id/chat',
    wrap(async (req, res) => {
      const session = getSession(req.params['id']);
      const message = (req.body?.message as string | undefined)?.trim();
      if (!message) {
        res.status(400).json({ error: 'message is required' });
        return;
      }

      const contextText = await buildContextBlock(session);
      const content: ContentBlock[] = [];
      if (contextText) content.push({ type: 'text', text: contextText });
      content.push({ type: 'text', text: CHAT_KNOWLEDGE });
      content.push({ type: 'text', text: message });

      const reply = await session.agent.prompt(session.id, content);
      recordTurn(session, message, reply);
      res.json({ reply });
    }),
  );

  async function getValidatedBody(session: Session, prompt: string, purpose: string): Promise<{
    body: string | null;
    reply: string;
  }> {
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

  // --- rewrite selection -----------------------------------------------

  app.post(
    '/api/session/:id/rewrite-selection',
    wrap(async (req, res) => {
      const session = getSession(req.params['id']);
      const instruction = (req.body?.message as string | undefined)?.trim() || 'Improve this text.';

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

      const { body: bodyLayouts, reply } = await getValidatedBody(
        session,
        prompt,
        'rewrite',
      );
      if (!bodyLayouts) {
        recordTurn(session, `Rewrite selection: ${instruction}`, reply);
        res.status(422).json({
          error: 'Agent did not return a ```lyx block. Ask it to retry or paste manually.',
          reply,
        });
        return;
      }

      const header = await currentHeader(session) ?? FALLBACK_HEADER;
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

      const contextText = await buildContextBlock(session);
      const prompt =
        'You are helping an author write in LyX. The content you generate will be ' +
        'pasted at the cursor as rich LyX content (.lyx markup).\n\n' +
        `${LYX_MARKUP_KNOWLEDGE}\n\n` +
        'Rules:\n' +
        '- Reply with the content ONLY inside a single ```lyx fenced block, containing\n' +
        '  just the `\\begin_layout ... \\end_layout` paragraphs (no header).\n' +
        '- Use LyX markup conventions: `\\begin_inset Formula $...$\\end_inset` for math,\n' +
        '  `\\begin_inset Foot` for footnotes, `\\emph on/off` for emphasis\n' +
        '  (token format on their own lines, NOT LaTeX \\emph{...}).\n' +
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
      await session.lyx.undo();
      res.json({ ok: true });
    }),
  );

  // --- helpers -----------------------------------------------------------

  function getSession(id: string | string[] | undefined): Session {
    const key = Array.isArray(id) ? id[0] : id;
    const session = key ? sessions.get(key) : undefined;
    if (!session) throw new Error('Unknown session');
    return session;
  }

  async function sessionInfo(session: Session) {
    const path = await session.lyx.getFilename();
    session.documentPath = path;
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
      documentPath: path,
      layout,
      outline,
      conversation: session.conversation,
    };
  }

  async function readDocumentContext(session: Session) {
    const path = session.documentPath ?? (await session.lyx.getFilename());
    const raw = await fs.readFile(path, 'utf8');
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
        `File: ${session.documentPath ?? (await session.lyx.getFilename())}\n` +
        `Text class: ${ctx.textclass ?? 'unknown'}\n` +
        `LyX format: ${ctx.formatVersion ?? 'unknown'}\n` +
        `Cursor paragraph layout: ${layout}\n\n` +
        `Document outline ([pN] ids address paragraphs):\n${renderOutline(ctx.outline)}\n\n` +
        `Full body (.lyx markup):\n${ctx.body}\n`
      );
    } catch (e) {
      // Unsaved document or read failure: fall back to what we know.
      const filename = await session.lyx.tryRequest('server-get-filename');
      return `Document context\n================\nFile: ${filename ?? '(unsaved document)'}\n` +
        `No .lyx file context available (document unsaved?): ${(e as Error).message}\n`;
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
      await new Promise((r) => setTimeout(r, 150));
      const doc = await session.clipboard.readLyxDocument();
      if (doc) {
        lyxBody = extractBodyLayouts(doc) ?? doc;
        text = await session.clipboard.readText();
      }
      layout = await session.lyx.tryRequest('server-get-layout');
    }
    return { hasSelection, stats, lyxBody, text, layout };
  }

  function recordTurn(session: Session, user: string, assistant: string) {
    session.conversation.push({ role: 'user', content: user, timestamp: new Date().toISOString() });
    session.conversation.push({
      role: 'assistant',
      content: assistant,
      timestamp: new Date().toISOString(),
    });
  }

  return app;
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