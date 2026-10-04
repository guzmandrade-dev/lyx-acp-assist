/**
 * Integration tests for LyxServerClient against the mock LyXServer: the
 * full LFUN choreography used by the app's paragraph-addressed actions,
 * exercised over real named pipes (with LyX's reply-then-disconnect quirk).
 */
import { describe, it, expect, afterEach } from 'vitest';
import { LyxServerClient } from '../src/lyxserver/client.js';
import { MockLyxServer } from './mock-lyx-server.js';

const activeMocks: Array<{ mock: MockLyxServer; client: LyxServerClient }> = [];

async function startMock(paragraphs?: Array<{ layout: string; text: string }>) {
  const mock = new MockLyxServer({ paragraphs });
  await mock.start();
  const client = new LyxServerClient({ pipeBase: mock.pipeBase });
  activeMocks.push({ mock, client });
  await client.start();
  return { mock, client };
}

afterEach(async () => {
  for (const { mock, client } of activeMocks.splice(0)) {
    client.stop();
    await mock.stop();
  }
});

describe('LyxServerClient against mock LyX', () => {
  it('handshakes and round-trips filename and layout', async () => {
    const { client } = await startMock([{ layout: 'Standard', text: 'Hello mock' }]);
    expect(await client.getFilename()).toBe('C:/mock/doc.lyx');
    expect(await client.getLayout()).toBe('Standard');
  });

  it('reports empty selection stats and tolerates a disabled copy', async () => {
    const { client } = await startMock([{ layout: 'Standard', text: 'Hello mock' }]);
    expect(await client.getSelectionStats()).toEqual([0, 0, 0]);
    // No selection: LyX replies "Command disabled"; copySelection -> false.
    expect(await client.copySelection()).toBe(false);
  });

  it('executes the insert-after pN choreography', async () => {
    const { mock, client } = await startMock([
      { layout: 'Title', text: 'Doc title' },
      { layout: 'Standard', text: 'First body' },
      { layout: 'Standard', text: 'Second body' },
    ]);

    // Walk: buffer-begin -> cursor at p0; paragraph-down -> p1.
    expect(await client.beginOfDocument()).toBe(true);
    expect(await client.paragraphDown()).toBe(true);
    // Select + copy the paragraph for verification.
    expect(await client.paragraphSelect()).toBe(true);
    expect(await client.copySelection()).toBe(true);
    expect(mock.clipboardText).toBe('First body');
    // Collapse to the end of the selection, then break a fresh paragraph.
    expect(await client.collapseSelectionForward()).toBe(true);
    expect(await client.breakParagraph()).toBe(true);
    // Paste lands in the fresh empty paragraph below 'First body'.
    mock.clipboardText = 'NEW SECTION';
    await client.paste();
    expect(mock.paragraphs.map((p) => p.text)).toEqual([
      'Doc title',
      'First body',
      'NEW SECTION',
      'Second body',
    ]);
  });

  it('executes the rewrite choreography: paste replaces the selection', async () => {
    const { mock, client } = await startMock([
      { layout: 'Standard', text: 'old text' },
      { layout: 'Standard', text: 'keep me' },
    ]);
    await client.beginOfDocument();
    await client.paragraphSelect();
    mock.clipboardText = 'new text';
    await client.paste();
    expect(mock.paragraphs.map((p) => p.text)).toEqual(['new text', 'keep me']);
  });

  it('insert-top: break at buffer-begin leaves an empty paragraph above', async () => {
    const { mock, client } = await startMock([{ layout: 'Standard', text: 'body text' }]);
    await client.beginOfDocument();
    await client.breakParagraph();
    mock.clipboardText = 'TITLE';
    await client.paste();
    expect(mock.paragraphs.map((p) => p.text)).toEqual(['TITLE', 'body text']);
  });

  it('paragraph-down at the last paragraph is disabled', async () => {
    const { client } = await startMock([{ layout: 'Standard', text: 'only' }]);
    await client.beginOfDocument();
    expect(await client.paragraphDown()).toBe(false);
  });

  it('undo tolerates "Command disabled" (nothing to undo)', async () => {
    const { mock, client } = await startMock([{ layout: 'Standard', text: 'only' }]);
    mock.nextUndoDisabled = true;
    await client.undo(); // must not throw
    await client.undo(); // normal reply also fine
  });

  it('selection stats reflect the active selection', async () => {
    const { client } = await startMock([{ layout: 'Standard', text: 'one two three' }]);
    await client.beginOfDocument();
    await client.paragraphSelect();
    const [words] = await client.getSelectionStats();
    expect(words).toBe(3);
  });
});