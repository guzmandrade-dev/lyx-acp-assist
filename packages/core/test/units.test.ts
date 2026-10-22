import { describe, it, expect } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  readAgentSettingsBody,
  formatHistoryReplay,
  listKnownDocuments,
  loadHistory,
  saveHistory,
  historyFile,
  extractAttachmentText,
  UNSAVED_KEY,
  type Turn,
  type TurnMeta,
} from '../src/index.js';

// --- settings body validation ---------------------------------------------------

describe('readAgentSettingsBody', () => {
  it('accepts a command string and trims it', () => {
    const out = readAgentSettingsBody({ command: '  vibe-acp ' });
    expect(out).toEqual({ command: 'vibe-acp' });
  });

  it('splits a string args field on whitespace', () => {
    const out = readAgentSettingsBody({ args: 'acp --verbose' });
    expect(out).toEqual({ args: ['acp', '--verbose'] });
  });

  it('keeps only non-empty string entries of an args array', () => {
    const out = readAgentSettingsBody({ args: ['--acp', '  ', 42, 'x'] });
    expect(out).toEqual({ args: ['--acp', 'x'] });
  });

  it('keeps only string-valued env entries', () => {
    const out = readAgentSettingsBody({ env: { A: '1', B: 2, C: 'ok' } });
    expect(out).toEqual({ env: { A: '1', C: 'ok' } });
  });

  it('returns an empty object for garbage input', () => {
    expect(readAgentSettingsBody(null)).toEqual({});
    expect(readAgentSettingsBody('nope')).toEqual({});
    expect(readAgentSettingsBody(7)).toEqual({});
  });
});

// --- history persistence --------------------------------------------------------

describe('history persistence', () => {
  it('round-trips turns through save and load', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'core-hist-'));
    const turns: Turn[] = [
      { role: 'user', content: 'hello', timestamp: new Date().toISOString() },
    ];
    await saveHistory(dir, 'doc-a', turns);
    expect(await loadHistory(dir, 'doc-a')).toEqual(turns);
    expect(await loadHistory(dir, 'doc-b')).toEqual([]);
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('hashes keys into distinct stable filenames', () => {
    const a = historyFile('/tmp/x', 'doc-a');
    const b = historyFile('/tmp/x', 'doc-b');
    expect(a).not.toEqual(b);
    expect(path.basename(a)).toMatch(/^[0-9a-f]{16}\.json$/);
  });

  it('lists known documents, skipping unsaved and missing keys', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'core-hist-'));
    const existing = path.join(dir, 'existing.txt');
    await fs.writeFile(existing, 'x', 'utf8');
    const missing = path.join(dir, 'gone.txt');
    await saveHistory(dir, existing, []);
    await saveHistory(dir, missing, []);
    await saveHistory(dir, UNSAVED_KEY, []);

    const all = await listKnownDocuments(dir);
    expect(all).toContain(existing);
    expect(all).toContain(missing);

    const filtered = await listKnownDocuments(dir, {
      exists: async (key) => key === existing,
    });
    expect(filtered).toEqual([existing]);
    await fs.rm(dir, { recursive: true, force: true });
  });
});

// --- restart replay -------------------------------------------------------------

const meta = (m: Partial<TurnMeta>): TurnMeta => ({
  action: 'none',
  result: 'applied',
  ...m,
});

describe('formatHistoryReplay', () => {
  const turns: Turn[] = [
    { role: 'user', content: 'shorten paragraph 3', timestamp: 't1' },
    {
      role: 'assistant',
      content: '```lyx\n\\begin_layout Standard\nnew text\n\\end_layout\n```\n[ACTION: rewrite-at p3]',
      timestamp: 't2',
      meta: meta({ action: 'rewrite-at', target: 3 }),
    },
    {
      role: 'assistant',
      content: 'tried but failed [ACTION: delete-at p2]',
      timestamp: 't3',
      meta: meta({ action: 'delete-at', result: 'error', error: 'paragraph 2 mismatch' }),
    },
  ];

  it('replays up to the unseen count and strips tags and blocks', () => {
    const out = formatHistoryReplay(turns, 3, {
      blockPattern: /```lyx[\s\S]*?```/g,
      describeTarget: (m) => (m.target ? ` p${m.target}` : ''),
    });
    expect(out).toContain('Conversation so far');
    expect(out).toContain('- User: shorten paragraph 3');
    expect(out).not.toContain('begin_layout');
    // The action TAG is stripped from the replayed text; the meta line
    // below it still reports the applied action on purpose.
    const youLines = out.split('\n').filter((l) => l.startsWith('- You:'));
    expect(youLines.length).toBe(2);
    expect(youLines.some((l) => l.includes('[ACTION:'))).toBe(false);
    expect(out).toContain('(applied [ACTION: rewrite-at p3] in the document)');
    expect(out).toContain('(action delete-at FAILED: paragraph 2 mismatch)');
  });

  it('caps each turn at the character limit', () => {
    const long: Turn[] = [
      { role: 'user', content: 'x'.repeat(2_000), timestamp: 't' },
    ];
    const out = formatHistoryReplay(long, 1, { blockPattern: /```lyx[\s\S]*?```/g });
    const line = out.split('\n').find((l) => l.startsWith('- User:')) ?? '';
    expect(line.length).toBeLessThanOrEqual('- User: '.length + 500 + 1); // + ellipsis
  });

  it('renders the LibreOffice-style address variant', () => {
    const calcTurns: Turn[] = [
      {
        role: 'assistant',
        content: '[ACTION: write-cells]',
        timestamp: 't',
        meta: meta({ action: 'write-cells', address: 'B2' }),
      },
    ];
    const out = formatHistoryReplay(calcTurns, 1, {
      blockPattern: /```(?:writer|calc|impress)[\s\S]*?```/g,
      describeTarget: (m) => (m.target ? ` p${m.target}` : m.address ? ` ${m.address}` : ''),
    });
    expect(out).toContain('(applied [ACTION: write-cells B2] in the document)');
  });

  it('returns empty for zero unseen turns', () => {
    expect(formatHistoryReplay(turns, 0, { blockPattern: /```lyx[\s\S]*?```/g })).toBe('');
  });
});

// --- attachment extraction --------------------------------------------------------

describe('extractAttachmentText', () => {
  it('reads textual extensions directly, capped at the limit', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'core-att-'));
    const file = path.join(dir, 'notes.md');
    await fs.writeFile(file, 'y'.repeat(50_000), 'utf8');
    const text = await extractAttachmentText(file, 'notes.md', {
      textualFile: /\.(txt|md)$/i,
    });
    expect(text).not.toBeNull();
    expect(text?.length).toBe(40_000);
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('returns null for a textual file that cannot be read', async () => {
    const out = await extractAttachmentText(
      'C:/definitely/not/here.md',
      'here.md',
      { textualFile: /\.(md)$/i },
    );
    expect(out).toBeNull();
  });

  it('respects the app-provided textual pattern', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'core-att-'));
    const file = path.join(dir, 'doc.lyx');
    await fs.writeFile(file, '#LyX 2.5', 'utf8');
    // With the LyX app's pattern the file is read directly...
    const direct = await extractAttachmentText(file, 'doc.lyx', {
      textualFile: /\.lyx$/i,
    });
    expect(direct).toBe('#LyX 2.5');
    // ...while a narrow pattern does not match this file.
    expect(/(\.md)$/i.test('doc.lyx')).toBe(false);
    await fs.rm(dir, { recursive: true, force: true });
  });
});