import { describe, it, expect, afterAll } from 'vitest';
import type { Server } from 'node:http';
import type { Express } from 'express';
import { createServer, parseAction, normalizeForCompare, isLikelyMatch, verifyParagraphSelection, buildAutoPrompt, extractAttachmentText, findClassLayouts, listKnownDocuments, formatHistoryReplay } from '../src/server.js';
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

describe('agent settings persistence', () => {
  it('round-trips agent settings through GET/PUT with a settingsDir', async () => {
    const fsp = await import('node:fs/promises');
    const os = await import('node:os');
    const path = await import('node:path');
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'lyx-settings-'));
    const app = createServer({
      publicDir: new URL('../public', import.meta.url).pathname.replace(/^\/(\w:)/, '$1'),
      clipboard: stubClipboard,
      settingsDir: dir,
    });
    const srv = await new Promise<Server>((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    const { port } = srv.address() as { port: number };
    const base = `http://127.0.0.1:${port}`;
    try {
      // No settings yet -> empty object.
      const initial = await (await fetch(`${base}/api/settings/agent`)).json();
      expect(initial).toEqual({});

      // PUT stores command + args (string form split on whitespace).
      const put = await fetch(`${base}/api/settings/agent`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ command: 'copilot', args: '--acp' }),
      });
      expect(put.status).toBe(200);
      expect(await put.json()).toEqual({ command: 'copilot', args: ['--acp'] });

      // GET returns what was stored — this is what survives an app restart
      // (the server port, and therefore the localStorage origin, changes).
      const got = await (await fetch(`${base}/api/settings/agent`)).json();
      expect(got).toEqual({ command: 'copilot', args: ['--acp'] });

      // A partial PUT merges instead of clobbering.
      await fetch(`${base}/api/settings/agent`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ command: 'goose' }),
      });
      const merged = await (await fetch(`${base}/api/settings/agent`)).json();
      expect(merged).toEqual({ command: 'goose', args: ['--acp'] });

      // Garbage bodies are ignored, not 500.
      const bad = await fetch(`${base}/api/settings/agent`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ command: 42, args: 'x y' }),
      });
      expect(bad.status).toBe(200);
      const afterBad = await (await fetch(`${base}/api/settings/agent`)).json();
      expect(afterBad).toEqual({ command: 'goose', args: ['x', 'y'] });
    } finally {
      await new Promise<void>((resolve) => srv.close(() => resolve()));
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });

  it('returns defaults when no settingsDir is configured', async () => {
    await setup(); // shared server has no settingsDir
    const res = await fetch(`${baseUrl}/api/settings/agent`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({});
    const put = await fetch(`${baseUrl}/api/settings/agent`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ command: 'copilot', args: '--acp' }),
    });
    expect(put.status).toBe(200);
    // Nothing stored: a fresh GET still returns defaults.
    const got = await (await fetch(`${baseUrl}/api/settings/agent`)).json();
    expect(got).toEqual({});
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

describe('document selector seeding', () => {
  it('lists persisted history keys that still exist on disk', async () => {
    const fsp = await import('node:fs/promises');
    const os = await import('node:os');
    const path = await import('node:path');
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'lyx-history-'));
    const docA = path.join(dir, 'doc-a.lyx');
    const docB = path.join(dir, 'doc-b.lyx');
    await fsp.writeFile(docA, 'x'); // must exist on disk to be listed
    await fsp.writeFile(
      path.join(dir, 'aaaa.json'),
      JSON.stringify({ key: docA, turns: [{ role: 'user', content: 'hi', timestamp: '' }] }),
    );
    // Missing on disk (deleted since) — must be skipped.
    await fsp.writeFile(
      path.join(dir, 'bbbb.json'),
      JSON.stringify({ key: docB, turns: [] }),
    );
    // The unsaved pseudo-key must be skipped even if present.
    await fsp.writeFile(
      path.join(dir, 'cccc.json'),
      JSON.stringify({ key: '(unsaved)', turns: [] }),
    );
    // Garbage file — must not throw.
    await fsp.writeFile(path.join(dir, 'dddd.json'), 'not json');

    const docs = await listKnownDocuments(dir);
    expect(docs).toEqual([docA]);

    // Missing directory resolves to an empty list.
    expect(await listKnownDocuments(path.join(dir, 'nope'))).toEqual([]);

    await fsp.rm(dir, { recursive: true, force: true });
  });
});

describe('history replay after restart', () => {
  const ts = '2026-10-10T00:00:00.000Z';

  it('is empty when the agent already saw every turn', () => {
    const turns = [
      { role: 'user' as const, content: 'hi', timestamp: ts },
      { role: 'assistant' as const, content: 'hello', timestamp: ts },
    ];
    expect(formatHistoryReplay(turns, 0)).toBe('');
  });

  it('replays only the unseen leading turns with action outcomes', () => {
    const turns = [
      // Pre-restart turns (the agent has not seen these).
      { role: 'user' as const, content: 'add a title', timestamp: ts },
      {
        role: 'assistant' as const,
        content: 'Done.\n[ACTION: insert-top]',
        timestamp: ts,
        meta: { action: 'insert-top', target: null, target2: null, result: 'applied' as const },
      },
      { role: 'user' as const, content: 'now bold it', timestamp: ts },
      {
        role: 'assistant' as const,
        content: 'Could not find it.',
        timestamp: ts,
        meta: { action: 'rewrite', target: null, target2: null, result: 'error' as const, error: 'no selection' },
      },
      // A turn produced live by the current agent process (already seen).
      { role: 'user' as const, content: 'ok', timestamp: ts },
      { role: 'assistant' as const, content: 'Sure.', timestamp: ts },
    ];
    const out = formatHistoryReplay(turns, 4);
    expect(out).toContain('replayed because the app was restarted');
    expect(out).toContain('- User: add a title');
    expect(out).toContain('- You: Done.');
    expect(out).toContain('applied [ACTION: insert-top] in the document');
    expect(out).toContain('action rewrite FAILED: no selection');
    // Live turns of this process must NOT be replayed.
    expect(out).not.toContain('- User: ok');
    expect(out).not.toContain('- You: Sure.');
    // The action tag must not leak from the turn content (the meta line
    // below reports the outcome separately).
    expect(out).toContain('- You: Done.\n');
  });

  it('caps the replay at the turn and character limits', () => {
    const many = Array.from({ length: 30 }, (_, i) => ({
      role: 'user' as const,
      content: `turn ${i} ` + 'x'.repeat(1000),
      timestamp: ts,
    }));
    const out = formatHistoryReplay(many, 30);
    // At most HISTORY_REPLAY_LIMIT (20) turns are replayed.
    expect(out.match(/^- User: /gm)?.length).toBe(20);
    expect(out).not.toContain('turn 20');
    // Each turn is truncated to HISTORY_REPLAY_CHAR_LIMIT + ellipsis.
    expect(out).toContain('…');
    expect(out).not.toContain('x'.repeat(501));
  });

  it('collapses whitespace and reports cancellation', () => {
    const turns = [
      {
        role: 'assistant' as const,
        content: 'Working\n\non it',
        timestamp: ts,
        meta: { action: 'rewrite', target: null, target2: null, result: 'cancelled' as const },
      },
    ];
    const out = formatHistoryReplay(turns, 1);
    expect(out).toContain('- You: Working on it');
    expect(out).toContain('cancelled before applying');
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

    const merge = parseAction('Joining those two paragraphs.\n[ACTION: merge p2 p3]');
    expect(merge.action).toBe('merge');
    expect(merge.target).toBe(2);
    expect(merge.target2).toBe(3);
    expect(merge.body).toBeNull();

    const mergeAdjacentCase = parseAction('[ACTION: MERGE p5 P6]');
    expect(mergeAdjacentCase.action).toBe('merge');
    expect(mergeAdjacentCase.target).toBe(5);
    expect(mergeAdjacentCase.target2).toBe(6);
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
const VH = [
  '#LyX 2.5 created this file. For more info see https://www.lyx.org/',
  '\\lyxformat 643',
  '\\begin_document',
  '\\begin_header',
  '\\textclass article',
  '\\end_header',
].join('\n');

describe('verifyParagraphSelection', () => {
  // The live 2026-10-10 failure: a formula-heavy paragraph ("Let [Formula]
  // be the polynomial justification for [ref eq:LotJ]…") failed the old
  // UnicodeText comparison even though the cursor was on the RIGHT
  // paragraph. Structure-vs-structure verifies it exactly.
  const formulaPara = [
    '\\begin_layout Standard',
    'Let ',
    '\\begin_inset Formula $S=\\big(a\\cdot t\\cdot\\underbrace{a\\cdot a\\cdot\\dots\\cdot a}_{n-1}\\cdot l(1)\\big)$',
    '\\end_inset',
    '',
    ' be the polynomial justification for ',
    '\\begin_inset CommandInset ref',
    'LatexCommand ref',
    'reference "eq:LotJ"',
    'plural "false"',
    'caps "false"',
    'noprefix "false"',
    'nolink "false"',
    '',
    '\\end_inset',
    '',
    ', the statement ',
    '\\begin_inset Formula $S:\\varphi$',
    '\\end_inset',
    '',
    ' is derivable.',
    '\\end_layout',
  ].join('\n');

  const doc = `${VH}\n\n\\begin_body\n\n${formulaPara}\n\n\\begin_layout Standard\nSecond paragraph.\n\\end_layout\n\n\\end_body\n\\end_document\n`;

  function payloadDoc(body: string): string {
    return `${VH}\n\n\\begin_body\n\n${body}\n\n\\end_body\n\\end_document\n`;
  }

  it('verifies a formula-heavy paragraph exactly via raw markup', () => {
    const v = verifyParagraphSelection({
      payload: payloadDoc(formulaPara),
      clipboardText: 'rendered text',
      diskRaw: doc,
      index: 0,
      expectedPreview: 'Let  be the polynomial justification for , the statement  is derivable.',
    });
    expect(v.ok).toBe(true);
    expect(v.via).toBe('markup');
  });

  it('tolerates whitespace/CRLF differences between payload and disk file', () => {
    const payload = payloadDoc(formulaPara).replace(/\n/g, '\r\n') + '   \n\n';
    const v = verifyParagraphSelection({
      payload,
      clipboardText: null,
      diskRaw: doc,
      index: 0,
      expectedPreview: 'Let  be the polynomial justification for , the statement  is derivable.',
    });
    expect(v.ok).toBe(true);
    expect(v.via).toBe('markup');
  });

  it('falls back to the same-parser preview on cosmetic re-serialization', () => {
    // LyX re-serialized the copy: an extra inset line changes the raw
    // markup but the visible paragraph text is unchanged.
    const reserialized = formulaPara.replace(' is derivable.', ' is derivable. \n\\begin_inset Formula $x$\n\\end_inset\n');
    const v = verifyParagraphSelection({
      payload: payloadDoc(reserialized),
      clipboardText: null,
      diskRaw: doc,
      index: 0,
      expectedPreview: 'Let  be the polynomial justification for , the statement  is derivable.',
    });
    expect(v.ok).toBe(true);
    expect(v.via).toBe('preview');
  });

  it('rejects a genuinely different paragraph', () => {
    const other = '\\begin_layout Standard\nCompletely different text about apples and oranges.\n\\end_layout';
    const v = verifyParagraphSelection({
      payload: payloadDoc(other),
      clipboardText: null,
      diskRaw: doc,
      index: 0,
      expectedPreview: 'Let  be the polynomial justification for , the statement  is derivable.',
    });
    expect(v.ok).toBe(false);
    expect(v.via).toBe('none');
  });

  it('rejects when the disk file is stale (payload differs from file)', () => {
    const staleDisk = `${VH}\n\n\\begin_body\n\n\\begin_layout Standard\nOld first paragraph, edited since.\n\\end_layout\n\n\\end_body\n\\end_document\n`;
    const v = verifyParagraphSelection({
      payload: payloadDoc(formulaPara),
      clipboardText: null,
      diskRaw: staleDisk,
      index: 0,
      expectedPreview: 'Old first paragraph, edited since.',
    });
    expect(v.ok).toBe(false);
  });

  it('falls back to the legacy UnicodeText match when no payload exists', () => {
    // Prose-only paragraph: the legacy path never saw formulas (that is
    // the bug this refactor fixes) — verify it still works for its case.
    const proseDoc =
      VH +
      '\n\n\\begin_body\n\n\\begin_layout Standard\nThe quick brown fox jumps over the lazy dog near the river bank.\n\\end_layout\n\n\\end_body\n\\end_document\n';
    const v = verifyParagraphSelection({
      payload: null,
      clipboardText: 'Standard The quick brown fox jumps over the lazy dog near the river bank.',
      diskRaw: proseDoc,
      index: 0,
      expectedPreview: 'The quick brown fox jumps over the lazy dog near the river bank.',
    });
    expect(v.ok).toBe(true);
    expect(v.via).toBe('text');
  });

  it('rejects a different paragraph via the legacy path too', () => {
    const v = verifyParagraphSelection({
      payload: null,
      clipboardText: 'Bananas are yellow fruit.',
      diskRaw: doc,
      index: 0,
      expectedPreview: 'Let  be the polynomial justification for , the statement  is derivable.',
    });
    expect(v.ok).toBe(false);
    expect(v.via).toBe('none');
  });
});
