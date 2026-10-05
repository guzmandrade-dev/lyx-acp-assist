import { describe, it, expect, afterAll } from 'vitest';
import type { Server } from 'node:http';
import type { Express } from 'express';
import { createServer, parseAction, normalizeForCompare, isLikelyMatch, buildAutoPrompt, extractAttachmentText, findClassLayouts } from '../src/server.js';
import type { RawClipboard } from '../src/clipboard/lyx-clipboard.js';

/** Stub raw clipboard: enough for routes that never touch LyX. */
const stubClipboard: RawClipboard = {
  async hasFormat() {
    return false;
  },
  async readFormat() {
    return null;
  },
  async write() {
    /* no-op */
  },
};

let express: Express;
let server: Server | null = null;
let baseUrl = '';

async function setup(): Promise<void> {
  if (server) return;
  express = createServer({
    publicDir: new URL('../public', import.meta.url).pathname.replace(/^\/(\w:)/, '$1'),
    clipboard: stubClipboard,
  });
  server = await new Promise<Server>((resolve) => {
    const s = express.listen(0, '127.0.0.1', () => resolve(s));
  });
  const address = server.address();
  if (typeof address !== 'object' || address === null) throw new Error('no address');
  baseUrl = `http://127.0.0.1:${address.port}`;
}

afterAll(async () => {
  await new Promise<void>((resolve) => server?.close(() => resolve()));
});

describe('API surface', () => {
  it('reports LyX pipe availability on /api/status', async () => {
    await setup();
    const res = await fetch(`${baseUrl}/api/status`);
    expect(res.status).toBe(200);
    expect(typeof (await res.json()).lyxPipeAvailable).toBe('boolean');
  });

  it('rejects unknown sessions on the unified message stream', async () => {
    await setup();
    const res = await fetch(`${baseUrl}/api/session/nope/message/stream`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'hi' }),
    });
    expect(res.status).toBe(404);
    expect((await res.json()).error).toMatch(/Unknown session/);
  });

  it('rejects unknown sessions on cancel and teardown', async () => {
    await setup();
    const cancel = await fetch(`${baseUrl}/api/session/nope/cancel`, { method: 'POST' });
    expect(cancel.status).toBe(500);
    const del = await fetch(`${baseUrl}/api/session/nope`, { method: 'DELETE' });
    expect(del.status).toBe(500);
  });
});

describe('attachments', () => {
  it('resolves class layout vocabularies including Input chains', async () => {
    // Uses the real LyX 2.5 install (skips where absent); custom user
    // classes in %APPDATA%\LyX2.5\layouts take priority.
    const { existsSync } = await import('node:fs');
    if (!existsSync('C:\\Program Files\\LyX 2.5\\Resources\\layouts\\article.layout')) return;
    const article = await findClassLayouts('article');
    expect(article).toBeTruthy();
    expect(article).toContain('Standard');
    expect(article).toContain('Section'); // via article -> stdclass.inc -> stdsections.inc
    expect(article!.length).toBeGreaterThan(10);
    // Unknown classes resolve to null (no throw).
    expect(await findClassLayouts('no-such-class-xyz')).toBeNull();
  });

  it('includes attachment text and paths in the auto prompt', () => {
    const prompt = buildAutoPrompt(
      'context',
      { hasSelection: false, lyxBody: null, text: null, layout: null },
      'summarize this',
      [
        { id: 'a1', name: 'report.pdf', path: 'C:\\att\\report.pdf', text: 'Extracted PDF text.' },
        { id: 'a2', name: 'img.png', path: 'C:\\att\\img.png', text: null },
      ],
    );
    expect(prompt).toContain('report.pdf');
    expect(prompt).toContain('C:\\att\\report.pdf');
    expect(prompt).toContain('Extracted PDF text.');
    expect(prompt).toContain('[No text could be extracted');
    expect(prompt).toContain('reference material');
    expect(prompt).toContain('never write into the attachments');
  });

  it('extracts text from textual files directly', async () => {
    const dir = await import('node:fs/promises');
    const os = await import('node:os');
    const path = await import('node:path');
    const file = path.join(os.tmpdir(), 'att-notes.md');
    await dir.writeFile(file, '# Notes\n\nplain text content', 'utf8');
    const text = await extractAttachmentText(file, 'notes.md');
    expect(text).toContain('plain text content');
    await dir.unlink(file);
  });

  it('converts a PDF through markitdown when installed', async () => {
    const { existsSync } = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const venv = path.join(
      os.homedir(), '.local', 'venvs', 'markitdown-mcp', 'Scripts', 'markitdown.exe',
    );
    // A real PDF shipped with LyX; skips where LyX or markitdown is absent.
    const fixture = 'C:\\Program Files\\LyX 2.5\\Resources\\doc\\clipart\\Abstract.pdf';
    if (!existsSync(venv) || !existsSync(fixture)) return;
    const text = await extractAttachmentText(fixture, 'Abstract.pdf');
    expect(text).toBeTruthy();
  });
});

describe('agent action parsing', () => {
  it('parses the action tag and lyx block from a reply', async () => {
    const rewrite = parseAction(
      'Rewritten:\n```lyx\n\\begin_layout Standard\nBetter text\n\\end_layout\n```\n[ACTION: rewrite]',
    );
    expect(rewrite.action).toBe('rewrite');
    expect(rewrite.body).toContain('\\begin_layout Standard');

    const chat = parseAction('Just prose, no tag at all');
    expect(chat.action).toBe('none');
    expect(chat.body).toBeNull();

    const insert = parseAction('```lyx\n\\begin_layout Standard\nX\n\\end_layout\n```\n[ACTION: INSERT]');
    expect(insert.action).toBe('insert');
    expect(insert.body).toBeTruthy();

    const top = parseAction(
      'Here is a title:\n```lyx\n\\begin_layout Title\nApple News\n\\end_layout\n```\n[ACTION: insert-top]',
    );
    expect(top.action).toBe('insert-top');
    expect(top.body).toContain('\\begin_layout Title');

    const at = parseAction(
      'Fixed [p1]:\n```lyx\n\\begin_layout Standard\nNew text\n\\end_layout\n```\n[ACTION: rewrite-at p1]',
    );
    expect(at.action).toBe('rewrite-at');
    expect(at.target).toBe(1);
    expect(at.body).toBeTruthy();

    const noTarget = parseAction('```lyx\n\\begin_layout Standard\nX\n\\end_layout\n```\n[ACTION: rewrite-at]');
    expect(noTarget.action).toBe('rewrite-at');
    expect(noTarget.target).toBeNull();

    const after = parseAction(
      '```lyx\n\\begin_layout Subsubsection\nNew section\n\\end_layout\n```\n[ACTION: insert-after p12]',
    );
    expect(after.action).toBe('insert-after');
    expect(after.target).toBe(12);
    expect(after.body).toBeTruthy();

    const before = parseAction(
      '```lyx\n\\begin_layout Standard\nIntro\n\\end_layout\n```\n[ACTION: insert-before p2]',
    );
    expect(before.action).toBe('insert-before');
    expect(before.target).toBe(2);
    expect(before.body).toBeTruthy();

    const del = parseAction('Removing that paragraph as requested.\n[ACTION: delete-at p3]');
    expect(del.action).toBe('delete-at');
    expect(del.target).toBe(3);
    expect(del.body).toBeNull();

    const move = parseAction('Moving that section up as requested.\n[ACTION: move p3 p1]');
    expect(move.action).toBe('move');
    expect(move.target).toBe(3);
    expect(move.target2).toBe(1);
    expect(move.body).toBeNull();

    const moveTop = parseAction('[ACTION: MOVE p2 to p0]');
    expect(moveTop.action).toBe('move');
    expect(moveTop.target).toBe(2);
    expect(moveTop.target2).toBe(0);

    const moveNoDest = parseAction('[ACTION: move p2]');
    expect(moveNoDest.action).toBe('move');
    expect(moveNoDest.target2).toBeNull();
  });

  it('normalizes typography so file text and clipboard text compare equal', () => {
    // .lyx file stores straight quotes; the clipboard exports curly ones.
    const fromFile = 'Apple has confirmed that a "small number" of users on the AT';
    const fromClipboard = 'Apple has confirmed that a \u201Csmall number\u201D of users on the AT';
    expect(normalizeForCompare(fromFile)).toBe(normalizeForCompare(fromClipboard));
    // Whitespace, dashes and case differences must not matter either.
    expect(normalizeForCompare('well-known  result')).toBe(normalizeForCompare('Well\u2014known result'));
    // But genuinely different text must stay different.
    expect(normalizeForCompare('Apple has confirmed')).not.toBe(normalizeForCompare('Apple News'));
  });

  it('fuzzy match tolerates layout labels and math in the clipboard export', () => {
    // Live failure: expected (parsed file, no inset content) vs actual
    // (LyX export prepends the "Abstract" label and renders $P$ inline).
    const expected = normalizeForCompare(
      'When a probability function assigns a value to an expression we usually ' +
        'assume that we can express it with a language equivalent to propositional logic',
    );
    const actual = normalizeForCompare(
      'Abstract When a probability function P assigns a value to an expression we ' +
        'usually assume that we can express it with a language equivalent to propositional logic',
    );
    expect(isLikelyMatch(expected, actual)).toBe(true);

    // But a genuinely different paragraph must still be rejected.
    expect(
      isLikelyMatch(normalizeForCompare('Apple has confirmed that a small number of users'), normalizeForCompare('Apple News')),
    ).toBe(false);
  });
});