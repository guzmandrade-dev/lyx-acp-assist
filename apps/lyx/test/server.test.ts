import { describe, it, expect, afterAll } from 'vitest';
import type { Server } from 'node:http';
import type { Express } from 'express';
import { createServer, parseAction, normalizeForCompare } from '../src/server.js';
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
});