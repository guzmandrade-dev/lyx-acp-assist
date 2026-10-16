import { describe, expect, it } from 'vitest';
import { parseAction } from '../src/server.js';
import { extractContentBlock, parseContentBlock, parseInline } from '../src/modules/markdown.js';
import { writerAdapter } from '../src/modules/writer.js';
import type { BridgeDocument } from '../src/bridge/client.js';

const writerDoc = (paragraphs: Array<[string, string]>, extra: Partial<BridgeDocument> = {}): BridgeDocument => ({
  active: true,
  module: 'writer',
  title: 'Test Document',
  url: 'file:///C:/docs/test.odt',
  paragraphs: paragraphs.map(([text, style], i) => ({ i, text, style })),
  selection: null,
  cursorStyle: 'Standard',
  ...extra,
});

describe('parseAction', () => {
  it('parses a plain prose reply as none', () => {
    expect(parseAction('Just an answer.')).toEqual({
      action: 'none',
      target: null,
      block: null,
    });
  });

  it('parses insert with a content block', () => {
    const reply = 'Here you go.\n```writer\n# Title\nBody line.\n```\n[ACTION: insert]';
    const out = parseAction(reply);
    expect(out.action).toBe('insert');
    expect(out.target).toBeNull();
    expect(out.block).toEqual([
      { style: 'Heading 1', runs: [{ text: 'Title', bold: false, italic: false, code: false }] },
      { style: null, runs: [{ text: 'Body line.', bold: false, italic: false, code: false }] },
    ]);
  });

  it('parses addressed actions with target numbers', () => {
    expect(parseAction('[ACTION: insert-after p3]').target).toBe(3);
    expect(parseAction('[ACTION: rewrite-at p12]').action).toBe('rewrite-at');
    expect(parseAction('[ACTION: delete-at p2]').action).toBe('delete-at');
    expect(parseAction('[ACTION: delete-at p2]').block).toBeNull();
  });

  it('takes the last tag when several appear', () => {
    expect(parseAction('[ACTION: insert]\nmore text\n[ACTION: none]').action).toBe('none');
  });

  it('content action without a block yields null block (apply refuses)', () => {
    const out = parseAction('I will insert something. [ACTION: insert]');
    expect(out.action).toBe('insert');
    expect(out.block).toBeNull();
  });
});

describe('parseInline', () => {
  it('splits bold and italic runs', () => {
    expect(parseInline('a **b** c')).toEqual([
      { text: 'a ', bold: false, italic: false, code: false },
      { text: 'b', bold: true, italic: false, code: false },
      { text: ' c', bold: false, italic: false, code: false },
    ]);
  });

  it('code spans win over emphasis markers inside them', () => {
    const runs = parseInline('use `x * y` here');
    expect(runs).toEqual([
      { text: 'use ', bold: false, italic: false, code: false },
      { text: 'x * y', bold: false, italic: false, code: true },
      { text: ' here', bold: false, italic: false, code: false },
    ]);
  });

  it('unclosed markers stay literal', () => {
    expect(parseInline('a * b')).toEqual([
      { text: 'a * b', bold: false, italic: false, code: false },
    ]);
  });
});

describe('parseContentBlock', () => {
  it('maps heading, bullet, quote and code fence lines', () => {
    const block = [
      '## Section',
      'normal line',
      '- item one',
      '> quoted',
      '```',
      'let x = 1;',
      '```',
    ].join('\n');
    const paras = parseContentBlock(block);
    expect(paras.map((p) => p.style)).toEqual([
      'Heading 2',
      null,
      null,
      'Quotations',
      'Preformatted Text',
    ]);
    expect(paras[2].runs[0].text).toBe('• item one');
    expect(paras[4].runs[0].text).toBe('let x = 1;');
  });

  it('joins consecutive plain lines into one paragraph', () => {
    expect(parseContentBlock('one\ntwo').length).toBe(1);
    expect(parseContentBlock('one\n\ntwo').length).toBe(2);
  });
});

describe('extractContentBlock', () => {
  it('extracts the writer fence and ignores others', () => {
    expect(extractContentBlock('```text\nnope\n```\n```writer\nyes\n```')).toBe('yes\n');
    expect(extractContentBlock('no fences')).toBeNull();
  });
});

describe('writerAdapter context', () => {
  it('renders [pN] outline with styles and previews', () => {
    const doc = writerDoc([
      ['My Title', 'Heading 1'],
      ['First body paragraph', 'Standard'],
    ]);
    const ctx = writerAdapter.buildContextBlock(doc, doc.url);
    expect(ctx).toContain('[p1] (Heading 1) My Title');
    expect(ctx).toContain('[p2] First body paragraph');
    expect(ctx).toContain('file:///C:/docs/test.odt');
  });

  it('lists the style vocabulary without Standard', () => {
    const doc = writerDoc([
      ['T', 'Heading 1'],
      ['b', 'Standard'],
      ['q', 'Quotations'],
    ]);
    const ctx = writerAdapter.buildContextBlock(doc, null);
    expect(ctx).toContain('Heading 1, Quotations');
  });

  it('renders the selection block only when a selection exists', () => {
    expect(writerAdapter.buildSelectionBlock({ hasSelection: false, text: null, cursorStyle: 'Standard' })).toBe('');
    expect(
      writerAdapter.buildSelectionBlock({ hasSelection: true, text: 'sel text', cursorStyle: 'Standard' }),
    ).toContain('sel text');
  });
});