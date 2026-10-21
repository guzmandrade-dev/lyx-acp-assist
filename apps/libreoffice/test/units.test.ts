import { describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
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

describe('companion discovery record', () => {
  it('writes and removes companion.json in the assist dir', async () => {
    const { writeCompanionRecord, removeCompanionRecord, assistDir } = await import('../src/bridge/client.js');
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'lo-acp-record-'));
    const prev = process.env.APPDATA;
    process.env.APPDATA = tmp;
    try {
      const file = path.join(assistDir(), 'companion.json');
      await writeCompanionRecord({ pid: 1234, port: 9999, url: 'http://127.0.0.1:9999', exe: null });
      const saved = JSON.parse(await fs.readFile(file, 'utf8'));
      expect(saved).toEqual({ pid: 1234, port: 9999, url: 'http://127.0.0.1:9999', exe: null });
      await removeCompanionRecord();
      await expect(fs.access(file)).rejects.toThrow();
    } finally {
      process.env.APPDATA = prev;
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });
});

describe('bridge install: package cache clearing', () => {
  it('clearPackageCache removes uno_packages/cache from a profile', async () => {
    const { clearPackageCache } = await import('../src/bridge/install.js');
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'lo-acp-profile-'));
    try {
      const cacheDir = path.join(tmp, 'uno_packages', 'cache', 'registry');
      await fs.mkdir(cacheDir, { recursive: true });
      await fs.writeFile(path.join(cacheDir, 'backenddb.xml'), '<xml/>');
      await fs.access(path.join(tmp, 'uno_packages', 'cache')); // exists before
      expect(clearPackageCache(tmp)).toBe(true);
      await expect(fs.access(path.join(tmp, 'uno_packages', 'cache'))).rejects.toThrow();
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it('clearPackageCache is a no-op when the cache does not exist', async () => {
    const { clearPackageCache } = await import('../src/bridge/install.js');
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'lo-acp-profile-'));
    try {
      expect(clearPackageCache(tmp)).toBe(true);
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it('findLoUserProfile follows LO_USER_PROFILE override', async () => {
    const { findLoUserProfile } = await import('../src/bridge/install.js');
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'lo-acp-profile-'));
    const prev = process.env.LO_USER_PROFILE;
    process.env.LO_USER_PROFILE = tmp;
    try {
      expect(findLoUserProfile()).toBe(tmp);
    } finally {
      process.env.LO_USER_PROFILE = prev;
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it('installBridge clears the package cache after a successful add', async () => {
    const install = await import('../src/bridge/install.js');
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'lo-acp-install-'));
    const oxtPath = path.join(tmp, 'bridge.oxt');
    await fs.writeFile(oxtPath, 'fake');
    // Fake profile with a stale cache.
    const profile = path.join(tmp, 'profile');
    await fs.mkdir(path.join(profile, 'uno_packages', 'cache'), { recursive: true });
    const calls: string[][] = [];
    install.setRunUnopkgForTesting(async (cmd) => {
      calls.push(cmd);
      return { ok: true, code: 0, output: 'ok' };
    });
    install.setLoUserProfileForTesting(profile);
    try {
      const result = await install.installBridge('fake-unopkg', oxtPath);
      expect(result.ok).toBe(true);
      expect(calls.map((c) => c.slice(1))).toEqual([['remove', 'org.libreofficeacp.bridge'], ['add', oxtPath]]);
      expect(result.message).toContain('Package cache cleared');
      await expect(fs.access(path.join(profile, 'uno_packages', 'cache'))).rejects.toThrow();
      const cacheStep = result.steps.find((s) => s.command.includes('clear package cache'));
      expect(cacheStep?.ok).toBe(true);
    } finally {
      install.setRunUnopkgForTesting(null);
      install.setLoUserProfileForTesting(null);
      await fs.rm(tmp, { recursive: true, force: true });
    }
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

// --- Impress adapter --------------------------------------------------------------

import { impressAdapter, parseImpressAction } from '../src/modules/impress.js';
import type { SlideInfo, SlidesSelectionShape } from '../src/bridge/client.js';

const slide = (i: number, extra: Partial<SlideInfo> = {}): SlideInfo => ({
  i,
  name: `page${i + 1}`,
  current: false,
  shapes: [
    { i: 0, kind: 'title', text: `Title ${i + 1}` },
    { i: 1, kind: 'body', text: `Body A ${i + 1}\nBody B ${i + 1}` },
    { i: 2, kind: 'other', text: null },
  ],
  ...extra,
});

const impressDoc = (extra: Partial<BridgeDocument> = {}): BridgeDocument => ({
  active: true,
  module: 'impress',
  title: 'Deck',
  url: 'file:///C:/docs/deck.odp',
  slides: [slide(0, { current: true }), slide(1)],
  selection: null,
  cursorStyle: null,
  ...extra,
});

const impressSel = (frames: SlidesSelectionShape[] | null = null) => ({
  hasSelection: Boolean(frames?.length),
  text: null,
  cursorStyle: null,
  calc: null,
  slidesSelection: frames,
});

describe('parseImpressAction', () => {
  it('parses a plain prose reply as none', () => {
    expect(parseImpressAction('Just an answer.')).toEqual({
      action: 'none',
      target: null,
      address: null,
      block: null,
      grid: null,
    });
  });

  it('parses rewrite-slide sN with a title-first impress block', () => {
    const reply = 'Here.\n```impress\nNew Title\nFirst point\nSecond point\n```\n[ACTION: rewrite-slide s2]';
    const out = parseImpressAction(reply);
    expect(out.action).toBe('rewrite-slide');
    expect(out.target).toBe(2);
    expect(out.block?.map((p) => p.runs.map((r) => r.text).join('')))
      .toEqual(['New Title', 'First point', 'Second point']);
  });

  it('parses insert-after with s0 and drops action tags from the block', () => {
    const reply = '```impress\nCover\n\n[ACTION: none]\nCovers the deck\n```\n[ACTION: insert-after s0]';
    const out = parseImpressAction(reply);
    expect(out.action).toBe('insert-after');
    expect(out.target).toBe(0);
    expect(out.block?.map((p) => p.runs.map((r) => r.text).join('')))
      .toEqual(['Cover', 'Covers the deck']);
  });

  it('defaults the target to null and takes the last tag', () => {
    const out = parseImpressAction('[ACTION: insert-after s2]\nmore\n[ACTION: none]');
    expect(out.action).toBe('none');
    expect(out.target).toBeNull();
  });

  it('content action without a block yields null block (apply refuses)', () => {
    const out = parseImpressAction('I will insert a slide. [ACTION: insert-after s1]');
    expect(out.action).toBe('insert-after');
    expect(out.target).toBe(1);
    expect(out.block).toBeNull();
  });

  it('writer/calc tags do not parse in the impress grammar', () => {
    expect(parseImpressAction('[ACTION: insert-after p3]').action).toBe('none');
    expect(parseImpressAction('[ACTION: rewrite-at p2]').action).toBe('none');
    expect(parseImpressAction('[ACTION: write-cells]').action).toBe('none');
    expect(parseImpressAction('[ACTION: insert]').action).toBe('none');
  });
});

describe('impressAdapter context', () => {
  it('renders the [sN] outline with titles, body counts, and the current slide', () => {
    const ctx = impressAdapter.buildContextBlock(impressDoc(), 'file:///C:/docs/deck.odp');
    expect(ctx).toContain('[s1] (current) "Title 1" | body: 2 paragraph(s), 1 other shape(s)');
    expect(ctx).toContain('[s2] "Title 2"');
    expect(ctx).toContain('Body A 1');
    expect(ctx).toContain('Slides: 2');
  });

  it('renders the selection block with frame indices and text', () => {
    const block = impressAdapter.buildSelectionBlock(
      impressSel([{ slide: 1, shape: 0, kind: 'title', text: 'Title 2' }]),
    );
    expect(block).toContain('[s2] frame 0 (title):');
    expect(block).toContain('Title 2');
    expect(impressAdapter.buildSelectionBlock(impressSel(null))).toBe('');
  });

  it('refuses rewrite-slide on a slide without a title frame (context shows it)', () => {
    const doc = impressDoc({
      slides: [{ i: 0, name: 'page1', current: true, shapes: [{ i: 0, kind: 'other', text: null }] }],
    });
    const ctx = impressAdapter.buildContextBlock(doc, null);
    expect(ctx).toContain('(no title frame)');
  });
});

describe('impressAdapter applyAction', () => {
  const edits: EditPayload[] = [];
  const bridge = {
    edit: async (payload: EditPayload) => {
      edits.push(payload);
      return {
        applied: true,
        title: 'Deck',
        mode: payload.mode,
        slide: payload.mode === 'insert-slide-after' ? payload.slide : payload.slide ?? 0,
      };
    },
  } as unknown as BridgeClient;

  it('insert-after s1 sends the anchor and the title/body block', async () => {
    const out = parseImpressAction('```impress\nAgenda\nFirst point\nSecond point\n```\n[ACTION: insert-after s1]');
    const r = await impressAdapter.applyAction(bridge, impressDoc(), impressSel(), out);
    expect(edits[edits.length - 1]).toMatchObject({
      mode: 'insert-slide-after',
      slide: 1,
      title: 'Agenda',
      body: ['First point', 'Second point'],
    });
    expect(r.description).toBe('[ACTION: insert-after — new slide after s1]');
  });

  it('insert-after s0 anchors at the very start', async () => {
    const out = parseImpressAction('```impress\nCover\n```\n[ACTION: insert-after s0]');
    const r = await impressAdapter.applyAction(bridge, impressDoc(), impressSel(), out);
    expect(edits[edits.length - 1]).toMatchObject({ mode: 'insert-slide-after', slide: 0, title: 'Cover', body: [] });
    expect(r.description).toBe('[ACTION: insert-after — new slide at the very start]');
  });

  it('rewrite-slide sN sends the 0-based slide index', async () => {
    const out = parseImpressAction('```impress\nNew Title\nPoint\n```\n[ACTION: rewrite-slide s2]');
    await impressAdapter.applyAction(bridge, impressDoc(), impressSel(), out);
    expect(edits[edits.length - 1]).toMatchObject({
      mode: 'rewrite-slide',
      slide: 1,
      title: 'New Title',
      body: ['Point'],
    });
  });

  it('rewrite sends the first selected frame with plain paragraph lines', async () => {
    const out = parseImpressAction('```impress\nReplacement\nMore text\n```\n[ACTION: rewrite]');
    const sel = impressSel([{ slide: 0, shape: 1, kind: 'body', text: 'Body A 1\nBody B 1' }]);
    const r = await impressAdapter.applyAction(bridge, impressDoc(), sel, out);
    expect(edits[edits.length - 1]).toMatchObject({
      mode: 'rewrite-frame',
      slide: 0,
      shape: 1,
      paragraphs: ['Replacement', 'More text'],
    });
    expect(r.description).toBe('[ACTION: rewrite frame on s1]');
  });

  it('rewrite without a selected text frame is refused with nothing sent', async () => {
    const out = parseImpressAction('```impress\nX\n```\n[ACTION: rewrite]');
    const before = edits.length;
    await expect(impressAdapter.applyAction(bridge, impressDoc(), impressSel(null), out)).rejects.toThrow('selected');
    expect(edits.length).toBe(before);
  });

  it('rewrite-slide without a target or with an out-of-range target is refused', async () => {
    const before = edits.length;
    await expect(
      impressAdapter.applyAction(bridge, impressDoc(), impressSel(), parseImpressAction('```impress\nT\n```\n[ACTION: rewrite-slide]')),
    ).rejects.toThrow('slide number');
    await expect(
      impressAdapter.applyAction(bridge, impressDoc(), impressSel(), parseImpressAction('```impress\nT\n```\n[ACTION: rewrite-slide s9]')),
    ).rejects.toThrow('does not exist');
    await expect(
      impressAdapter.applyAction(bridge, impressDoc(), impressSel(), parseImpressAction('```impress\nT\n```\n[ACTION: insert-after s9]')),
    ).rejects.toThrow('does not exist');
    expect(edits.length).toBe(before);
  });

  it('content actions without a block are refused with nothing sent', async () => {
    const before = edits.length;
    await expect(
      impressAdapter.applyAction(bridge, impressDoc(), impressSel(), parseImpressAction('Sure. [ACTION: insert-after s1]')),
    ).rejects.toThrow('impress');
    await expect(
      impressAdapter.applyAction(bridge, impressDoc(), impressSel(), parseImpressAction('Sure. [ACTION: rewrite]')),
    ).rejects.toThrow('impress');
    expect(edits.length).toBe(before);
  });
});
