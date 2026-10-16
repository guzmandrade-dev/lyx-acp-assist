import { describe, expect, it } from 'vitest';
import { parseAction } from '../src/server.js';
import { calcAdapter, parseCalcAction } from '../src/modules/calc.js';
import { extractContentBlock, parseContentBlock, parseInline, parseTsvBlock } from '../src/modules/markdown.js';
import { writerAdapter } from '../src/modules/writer.js';
import type { BridgeClient, BridgeDocument } from '../src/bridge/client.js';

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
      address: null,
      block: null,
      grid: null,
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

  it('never turns action tags into content (agents put them inside fences)', () => {
    const block = '## Future Work\nA paragraph.\n[ACTION: insert-after p2]';
    expect(parseContentBlock(block)).toEqual([
      { style: 'Heading 2', runs: [{ text: 'Future Work', bold: false, italic: false, code: false }] },
      { style: null, runs: [{ text: 'A paragraph.', bold: false, italic: false, code: false }] },
    ]);
  });

  it('regression: live-agent reply with tag inside the fence, echoed block', () => {
    const reply = [
      '```writer',
      '## Future Work',
      'We plan to extend this.',
      '[ACTION: insert-after p2]',
      '```',
      '```writer',
      '## Future Work',
      'We plan to extend this.',
      '[ACTION: insert-after p2]',
      '```',
    ].join('\n');
    const out = parseAction(reply);
    expect(out.action).toBe('insert-after');
    expect(out.target).toBe(2);
    expect(out.block).toEqual([
      { style: 'Heading 2', runs: [{ text: 'Future Work', bold: false, italic: false, code: false }] },
      { style: null, runs: [{ text: 'We plan to extend this.', bold: false, italic: false, code: false }] },
    ]);
  });
});

describe('extractContentBlock', () => {
  it('extracts the writer fence and ignores others', () => {
    expect(extractContentBlock('```text\nnope\n```\n```writer\nyes\n```')).toBe('yes\n');
    expect(extractContentBlock('no fences')).toBeNull();
  });

  it('takes the LAST writer fence when the block is echoed', () => {
    const reply = '```writer\nfirst\n```\nExplanation.\n```writer\nsecond\n```';
    expect(extractContentBlock(reply)).toBe('second\n');
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
    expect(writerAdapter.buildSelectionBlock({ hasSelection: false, text: null, cursorStyle: 'Standard', calc: null })).toBe('');
    expect(
      writerAdapter.buildSelectionBlock({ hasSelection: true, text: 'sel text', cursorStyle: 'Standard', calc: null }),
    ).toContain('sel text');
  });
});
// --- Calc adapter ---------------------------------------------------------------

import type { CalcInfo, EditPayload } from '../src/bridge/client.js';

const calcInfo = (extra: Partial<CalcInfo> = {}): CalcInfo => ({
  sheets: [{ name: 'Sheet1', usedRange: 'A1:B3', active: true }],
  selection: {
    sheet: 'Sheet1',
    ranges: ['Sheet1!A1:B3'],
    anchor: 'A1',
    rows: 3,
    cols: 2,
    values: [
      ['Name', 'Qty'],
      ['Widget', '5'],
      ['', '10'],
    ],
    formulas: null,
    truncated: false,
  },
  data: {
    sheet: 'Sheet1',
    range: 'A1:B3',
    values: [
      ['Name', 'Qty'],
      ['Widget', '5'],
      ['', '10'],
    ],
    formulas: null,
    truncated: false,
  },
  ...extra,
});

const calcDoc = (extra: Partial<BridgeDocument> = {}): BridgeDocument => ({
  active: true,
  module: 'calc',
  title: 'Budget',
  url: 'file:///C:/docs/budget.ods',
  calc: calcInfo(),
  cursorStyle: null,
  ...extra,
});

const calcSel = (calc: CalcInfo | null = calcInfo()) => ({
  hasSelection: true,
  text: null,
  cursorStyle: null,
  calc,
});

describe('parseCalcAction', () => {
  it('parses a plain prose reply as none', () => {
    expect(parseCalcAction('Just an answer.')).toEqual({
      action: 'none',
      target: null,
      address: null,
      block: null,
      grid: null,
    });
  });

  it('parses write-cells with an A1 anchor and a TSV block', () => {
    const reply = 'Here.\n```calc\nTotal\t=SUM(B2:B3)\n\n```\n[ACTION: write-cells C1]';
    const out = parseCalcAction(reply);
    expect(out.action).toBe('write-cells');
    expect(out.address).toBe('C1');
    expect(out.grid).toEqual([['Total', '=SUM(B2:B3)']]);
  });

  it('defaults the anchor to null (selection) and takes the last tag', () => {
    const out = parseCalcAction('[ACTION: insert-rows]\nmore\n[ACTION: insert-rows A5]');
    expect(out.action).toBe('insert-rows');
    expect(out.address).toBe('A5');
    expect(out.grid).toBeNull();
  });

  it('content action without a block yields null grid (apply refuses)', () => {
    const out = parseCalcAction('I will write cells. [ACTION: write-cells]');
    expect(out.action).toBe('write-cells');
    expect(out.grid).toBeNull();
  });

  it('writer tags do not parse in the calc grammar', () => {
    expect(parseCalcAction('[ACTION: rewrite-at p3]').action).toBe('none');
  });
});

describe('parseTsvBlock', () => {
  it('splits rows on tabs and drops action tags and trailing empties', () => {
    const block = 'A\tB\n[ACTION: none]\nC\tD\n\n\n';
    expect(parseTsvBlock(block)).toEqual([
      ['A', 'B'],
      ['C', 'D'],
    ]);
  });
});

describe('extractContentBlock (calc)', () => {
  it('extracts the calc fence and ignores the writer fence', () => {
    expect(extractContentBlock('```writer\nnope\n```\n```calc\nyes\n```', 'calc')).toBe('yes\n');
    expect(extractContentBlock('```calc\nyes\n```')).toBeNull();
  });
});

describe('calcAdapter context', () => {
  it('renders sheets, used range, values, and selection anchor', () => {
    const ctx = calcAdapter.buildContextBlock(calcDoc(), 'file:///C:/docs/budget.ods');
    expect(ctx).toContain('Sheets: Sheet1 (used A1:B3) [active]');
    expect(ctx).toContain('```tsv');
    expect(ctx).toContain('Name\tQty');
    expect(ctx).toContain('Widget\t5');
  });

  it('renders formulas only when present', () => {
    const info = calcInfo({
      selection: { ...calcInfo().selection!, formulas: [['Name', 'Qty'], ['Widget', '5'], ['', '=B2*2']] },
      data: { ...calcInfo().data!, formulas: [['Name', 'Qty'], ['Widget', '5'], ['', '=B2*2']] },
    });
    const ctx = calcAdapter.buildContextBlock(calcDoc({ calc: info }), null);
    expect(ctx).toContain('=B2*2');
  });

  it('does not duplicate the selection grid when the data block covers it', () => {
    const sel = calcSel();
    const block = calcAdapter.buildSelectionBlock(sel);
    expect(block).toContain('Current selection: Sheet1!A1:B3 (anchor A1)');
    expect(block).not.toContain('```tsv');
  });

  it('shows the selection grid when it is outside the data block', () => {
    const info = calcInfo({ data: null });
    const block = calcAdapter.buildSelectionBlock(calcSel(info));
    expect(block).toContain('```tsv');
  });
});

describe('calcAdapter applyAction', () => {
  const edits: EditPayload[] = [];
  const bridge = {
    edit: async (payload: EditPayload) => {
      edits.push(payload);
      return {
        applied: true,
        title: 'Budget',
        mode: payload.mode,
        anchor: payload.anchor ?? 'A1',
      };
    },
  } as unknown as BridgeClient;

  it('write-cells sends the TSV rows to the bridge at the anchor', async () => {
    const out = parseCalcAction('```calc\nTotal\t15\n```\n[ACTION: write-cells C1]');
    const r = await calcAdapter.applyAction(bridge, calcDoc(), calcSel(), out);
    expect(edits[edits.length - 1]).toMatchObject({
      mode: 'write-cells',
      anchor: 'C1',
      rows: [['Total', '15']],
      tracked: true,
    });
    expect(r.description).toBe('[ACTION: write-cells at C1]');
  });

  it('write-cells without an anchor uses the selection', async () => {
    const out = parseCalcAction('```calc\nX\n```\n[ACTION: write-cells]');
    await calcAdapter.applyAction(bridge, calcDoc(), calcSel(), out);
    expect(edits[edits.length - 1]).toMatchObject({ anchor: undefined, rows: [['X']] });
  });

  it('insert-rows/insert-cols pass count 1 and the anchor', async () => {
    await calcAdapter.applyAction(bridge, calcDoc(), calcSel(), parseCalcAction('[ACTION: insert-rows A5]'));
    expect(edits[edits.length - 1]).toMatchObject({ mode: 'insert-rows', anchor: 'A5', count: 1 });
    await calcAdapter.applyAction(bridge, calcDoc(), calcSel(), parseCalcAction('[ACTION: insert-cols]'));
    expect(edits[edits.length - 1]).toMatchObject({ mode: 'insert-cols', anchor: undefined, count: 1 });
  });

  it('write-cells without a content block is refused with nothing sent', async () => {
    const out = parseCalcAction('Sure. [ACTION: write-cells]');
    const before = edits.length;
    await expect(calcAdapter.applyAction(bridge, calcDoc(), calcSel(), out)).rejects.toThrow('calc');
    expect(edits.length).toBe(before);
  });

  it('rewrite without a Calc selection is refused', async () => {
    const out = parseCalcAction('```calc\nX\n```\n[ACTION: rewrite]');
    await expect(calcAdapter.applyAction(bridge, calcDoc(), calcSel(null), out)).rejects.toThrow('no selection');
  });
});
