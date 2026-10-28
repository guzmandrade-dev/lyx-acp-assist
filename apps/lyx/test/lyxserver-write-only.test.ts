/**
 * Integration tests for the write-only fallback mode (client.ts) against
 * the DEAF mock transport: .out connections reset at connect with zero
 * bytes (the upstream LyX bug signature), .in commands still dispatch.
 * The read paths must come from the injected fallbacks.
 *
 * Runs on every OS (PowerShell named pipes on Windows, FIFOs elsewhere).
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LyxServerClient, type LyxWriteOnlyFallbacks } from '../src/lyxserver/client.js';
import { MockLyxServer } from './mock-lyx-server.js';

// Integration suites drive dozens of real pipe round-trips (each ends the
// connection and reconnects, like live LyX); under parallel test load the
// default 5s can be too tight.
vi.setConfig({ testTimeout: 20_000 });

const active: Array<{ mock: MockLyxServer; client: LyxServerClient }> = [];

/**
 * Fallbacks wired to the mock's clipboard model plus a scripted window
 * title and document candidates — the test stand-ins for the real
 * PowerShell clipboard adapter and the LyX process title.
 */
function fakeFallbacks(
  mock: MockLyxServer,
  title: string | null,
  candidates: string[],
): LyxWriteOnlyFallbacks {
  return {
    clearClipboard: async () => {
      mock.clipboardText = '';
    },
    readClipboardText: async () => mock.clipboardText,
    hasClipboardLyxPayload: async () => mock.clipboardText.length > 0,
    readLyxWindowTitle: async () => title,
    documentCandidates: () => candidates,
  };
}

async function startDeaf(options: { title?: string | null; candidates?: string[] } = {}) {
  const mock = new MockLyxServer({ deaf: true });
  await mock.start();
  const client = new LyxServerClient({
    pipeBase: mock.pipeBase,
    deafProbeMs: 300,
    writeOnlyGraceMs: 50,
    fallbacks: fakeFallbacks(mock, options.title ?? null, options.candidates ?? []),
  });
  active.push({ mock, client });
  await client.start();
  return { mock, client };
}

afterEach(async () => {
  for (const { mock, client } of active.splice(0)) {
    client.stop();
    await mock.stop();
  }
});

describe('write-only fallback mode', () => {
  it('detects the deaf .out pipe and switches to write-only', async () => {
    const { client } = await startDeaf();
    expect(client.mode).toBe('write-only');
  });

  it('still dispatches commands via .in (no reply ever arrives)', async () => {
    const { mock, client } = await startDeaf();
    await client.insertText('typed'); // must not throw on the missing reply
    await vi.waitFor(() => {
      expect(mock.paragraphs[0].text).toContain('typed');
    });
  });

  it('reports no selection when the copy probe finds an empty clipboard', async () => {
    const { client } = await startDeaf();
    // No selection active: the probe clears the clipboard, `copy` is
    // rejected by the mock, and the clipboard stays empty.
    expect(await client.getSelectionStats()).toEqual([0, 0, 0]);
    expect(await client.copySelection()).toBe(false);
  });

  it('probes an active selection through the clipboard fallback', async () => {
    const { mock, client } = await startDeaf();
    await client.beginOfDocument(); // blind commands still move the cursor
    await client.paragraphSelect(); // selects the mock paragraph
    await vi.waitFor(async () => {
      // 'Hello mock': 2 words, 9 chars without spaces, 10 with spaces.
      expect(await client.getSelectionStats()).toEqual([2, 9, 10]);
    });
    expect(mock.clipboardText).toBe('Hello mock');
    expect(await client.copySelection()).toBe(true);
  });

  it('getLayout is unknown (empty) without replies', async () => {
    const { client } = await startDeaf();
    expect(await client.getLayout()).toBe('');
  });

  it('resolves the active document from the window title and candidates', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lyx-title-test-'));
    const doc = path.join(tmp, 'sample.lyx');
    fs.writeFileSync(doc, '#LyX 2.5 created this file.');
    try {
      const { client } = await startDeaf({
        title: 'sample.lyx - LyX',
        candidates: [doc],
      });
      const expected = process.platform === 'win32' ? doc.replace(/\\/g, '/') : doc;
      expect(await client.getFilename()).toBe(expected);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('resolves the document via the title directory hint when it exists', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lyx-title-test-'));
    const doc = path.join(tmp, 'hinted.lyx');
    fs.writeFileSync(doc, '#LyX 2.5 created this file.');
    try {
      const { client } = await startDeaf({
        title: `hinted.lyx (${tmp}) - LyX`,
        candidates: [],
      });
      const expected = process.platform === 'win32' ? doc.replace(/\\/g, '/') : doc;
      expect(await client.getFilename()).toBe(expected);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('returns an empty path when the title cannot be resolved', async () => {
    const { client } = await startDeaf({
      title: 'ghost.lyx - LyX',
      candidates: [],
    });
    expect(await client.getFilename()).toBe('');
  });

  it('save and undo tolerate the missing replies', async () => {
    const { client } = await startDeaf();
    await client.save(); // buffer-write: blind, must not throw
    await client.undo(); // no reply: must not throw
  });
});