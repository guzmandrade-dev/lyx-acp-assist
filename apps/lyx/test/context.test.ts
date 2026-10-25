import { describe, expect, it } from 'vitest';
import {
  assemblePasteDocument,
  extractBodyLayouts,
  findMarkupProblems,
  buildDocumentContext,
  renderOutline,
  splitTopLevelLayouts,
  normalizeMarkupBlock,
} from '../src/lyx/context.js';
import { parse } from '../src/lyx/parser.js';
import { LYX_MARKUP_KNOWLEDGE } from '../src/lyx/knowledge.js';

const HEADER = [
  '#LyX 2.5 created this file. For more info see https://www.lyx.org/',
  '\\lyxformat 643',
  '\\begin_document',
  '\\begin_header',
  '\\textclass article',
  '\\end_header',
].join('\n');

describe('assemblePasteDocument', () => {
  it('produces a strict-parseable document (regression: \\b escape bug)', () => {
    const doc = assemblePasteDocument(HEADER, '\\begin_layout Standard\nHello\n\\end_layout');
    expect(doc).toContain('\\begin_body');
    expect(doc).toContain('\\end_body');
    expect(doc).toContain('\\end_document');
    expect(() => parse(doc)).not.toThrow();
  });
});

describe('extractBodyLayouts', () => {
  it('extracts from a ```lyx fenced block', () => {
    const reply =
      'Sure!\n```lyx\n\\begin_layout Standard\nHi\n\\end_layout\n```\nDone.';
    expect(extractBodyLayouts(reply)).toBe('\\begin_layout Standard\nHi\n\\end_layout');
  });

  it('extracts the body from a full document', () => {
    const doc = `${HEADER}\n\n\\begin_body\n\n\\begin_layout Standard\nHi\n\\end_layout\n\n\\end_body\n\\end_document\n`;
    expect(extractBodyLayouts(doc)).toBe('\\begin_layout Standard\nHi\n\\end_layout');
  });

  it('returns null when there is no lyx content', () => {
    expect(extractBodyLayouts('just prose, no markup')).toBeNull();
  });
});

describe('findMarkupProblems', () => {
  it('accepts valid LyX token format', () => {
    const body = '\\begin_layout Standard\n\\emph on\nHi\n\\emph default\n there\n\\end_layout';
    expect(findMarkupProblems(body)).toEqual([]);
  });

  it('rejects LaTeX-style inline commands', () => {
    const body = '\\begin_layout Standard\n\\emph{Hi} there\n\\end_layout';
    const problems = findMarkupProblems(body);
    expect(problems.length).toBeGreaterThan(0);
    expect(problems[0]).toMatch(/LaTeX-style/);
  });

  it('rejects content without layouts', () => {
    expect(findMarkupProblems('plain text')).toContainEqual(
      'No \\begin_layout block found.',
    );
  });

  it('rejects an inset missing its inner layout (renders empty)', () => {
    const body =
      '\\begin_layout Standard\n\\begin_inset Note Note\nstatus open\n\n\\end_inset\n\\end_layout';
    const problems = findMarkupProblems(body);
    expect(problems.some((p) => p.includes('will render EMPTY'))).toBe(true);
  });

  it('rejects empty insets', () => {
    const body =
      '\\begin_layout Standard\n\\begin_inset Formula $x$\n\\end_inset\n\\end_layout';
    // Formula is opaque (content on the begin line) - fine.
    expect(findMarkupProblems(body)).toEqual([]);
    const empty =
      '\\begin_layout Standard\n\\begin_inset Note Note\n\\end_inset\n\\end_layout';
    expect(findMarkupProblems(empty).some((p) => p.includes('Empty inset'))).toBe(true);
  });

  it('accepts a well-formed Note inset', () => {
    const body = [
      '\\begin_layout Standard',
      '\\begin_inset Note Note',
      'status open',
      '',
      '\\begin_layout Plain Layout',
      'A note.',
      '\\end_layout',
      '',
      '\\end_inset',
      '\\end_layout',
    ].join('\n');
    expect(findMarkupProblems(body)).toEqual([]);
  });
});

describe('findMarkupProblems — spaces around inline insets', () => {
  it('flags a word glued before an inline Formula', () => {
    const body =
      '\\begin_layout Standard\nThe value is\n\\begin_inset Formula $x$\n\\end_inset\n.\n\\end_layout';
    const problems = findMarkupProblems(body);
    expect(problems.some((p) => p.includes('Missing space before'))).toBe(true);
  });

  it('flags a word glued after an inline Formula', () => {
    const body =
      '\\begin_layout Standard\nThe value is \n\\begin_inset Formula $x$\n\\end_inset\nand more text\n\\end_layout';
    const problems = findMarkupProblems(body);
    expect(problems.some((p) => p.includes('Missing space after'))).toBe(true);
  });

  it('flags text glued to a cross-reference inset', () => {
    const body = [
      '\\begin_layout Standard',
      'See section',
      '\\begin_inset CommandInset ref',
      'LatexCommand ref',
      'reference "sec:x"',
      '',
      '\\end_inset',
      'for details',
      '\\end_layout',
    ].join('\n');
    const problems = findMarkupProblems(body);
    expect(problems.some((p) => p.includes('Missing space before'))).toBe(true);
    expect(problems.some((p) => p.includes('Missing space after'))).toBe(true);
  });

  it('accepts explicit spaces around an inline Formula', () => {
    const body =
      '\\begin_layout Standard\nThe value is \n\\begin_inset Formula $x$\n\\end_inset\n and more text\n\\end_layout';
    expect(findMarkupProblems(body)).toEqual([]);
  });

  it('accepts punctuation directly after an inset', () => {
    const body =
      '\\begin_layout Standard\nThe value is \n\\begin_inset Formula $x$\n\\end_inset\n.\n\\end_layout';
    expect(findMarkupProblems(body)).toEqual([]);
  });

  it('leaves Foot insets attached to their word', () => {
    const body = [
      '\\begin_layout Standard',
      'A claim',
      '\\begin_inset Foot',
      'status collapsed',
      '',
      '\\begin_layout Plain Layout',
      'The source.',
      '\\end_layout',
      '',
      '\\end_inset',
      '\\end_layout',
    ].join('\n');
    expect(findMarkupProblems(body)).toEqual([]);
  });

  it('leaves label insets glued to their heading', () => {
    const body = [
      '\\begin_layout Section',
      'My Section',
      '\\begin_inset CommandInset label',
      'LatexCommand label',
      'name "sec:x"',
      '',
      '\\end_inset',
      '\\end_layout',
    ].join('\n');
    expect(findMarkupProblems(body)).toEqual([]);
  });

  it('still flags when blank lines separate the text and the inset', () => {
    const body =
      '\\begin_layout Standard\nThe value is\n\n\\begin_inset Formula $x$\n\\end_inset\n\n\\end_layout';
    const problems = findMarkupProblems(body);
    expect(problems.some((p) => p.includes('Missing space before'))).toBe(true);
  });
});

describe('LYX_MARKUP_KNOWLEDGE spacing rules', () => {
  it('teaches explicit spaces around inline insets (guard against editors stripping them)', () => {
    // "is" carries a trailing space before the inset (the ${' '} in the
    // template literal renders as one real space).
    expect(LYX_MARKUP_KNOWLEDGE).toMatch(/The energy is \n/);
    // "and" starts with a real leading space after \end_inset.
    expect(LYX_MARKUP_KNOWLEDGE).toMatch(/\\end_inset\n {3}and it is conserved\./);
    // The URL example shows the space between "See" and the inset.
    expect(LYX_MARKUP_KNOWLEDGE).toMatch(/See \n {2}\\begin_inset Flex URL/);
  });
});

describe('buildDocumentContext', () => {
  const doc = [
    HEADER,
    '',
    '\\begin_body',
    '',
    '\\begin_layout Section',
    'Intro',
    '\\end_layout',
    '',
    '\\begin_layout Standard',
    'Body text here.',
    '\\end_layout',
    '',
    '\\end_body',
    '\\end_document',
    '',
  ].join('\n');

  it('builds an addressed outline', () => {
    const ctx = buildDocumentContext(doc);
    expect(ctx.outline).toEqual([
      expect.objectContaining({ id: 'p1', layout: 'Section', depth: 0 }),
      expect.objectContaining({ id: 'p2', layout: 'Standard', depth: 0, preview: 'Body text here.' }),
    ]);
    expect(ctx.textclass).toBe('article');
    expect(ctx.formatVersion).toBe('643');
  });

  it('renders the outline with ids', () => {
    const ctx = buildDocumentContext(doc);
    expect(renderOutline(ctx.outline)).toContain('[p1] (Section)');
    expect(renderOutline(ctx.outline)).toContain('[p2] (Standard)');
  });

  it('omits inset property syntax from previews (status / LatexCommand args)', () => {
    // Regression: the parser stores inset lines like `status open` and
    // `LatexCommand citep` / `key "..."` as plain text children of the
    // inset block; the preview must not show them (they shift the fuzzy
    // verification windows and broke paragraph targeting on real docs).
    const withNote =
      HEADER +
      [
        '',
        '\\begin_body',
        '',
        '\\begin_layout Standard',
        '\\begin_inset Note Note',
        'status open',
        '',
        '\\begin_layout Plain Layout',
        'This is the visible note text.',
        '',
        '\\end_layout',
        '',
        '\\end_inset',
        '\\end_layout',
        '',
        '\\begin_layout Standard',
        'Regular text with a citation',
        '\\begin_inset LatexCommand citep',
        'key "Fitting20051"',
        'literal "false"',
        '\\end_inset',
        ' trailing words.',
        '\\end_layout',
        '',
        '\\end_body',
        '\\end_document',
        '',
      ].join('\n');
    const ctx = buildDocumentContext(withNote);
    expect(ctx.outline[0].preview).toBe('This is the visible note text.');
    expect(ctx.outline[1].preview).toBe('Regular text with a citation trailing words.');
    // Sanity: neither preview leaks file syntax.
    for (const p of ctx.outline) {
      expect(p.preview).not.toMatch(/status open/);
      expect(p.preview).not.toMatch(/LatexCommand/);
      expect(p.preview).not.toMatch(/literal "false"/);
    }
  });

  it('keeps paragraph text that merely starts with inset-property-like words', () => {
    // Regression guard: the inset-syntax filter only applies INSIDE inset
    // blocks; a paragraph's own text starting with e.g. "Name of the
    // project" must survive.
    const doc2 =
      HEADER +
      '\n\n\\begin_body\n\n\\begin_layout Standard\nName of the project is important.\n\\end_layout\n\n\\end_body\n\\end_document\n';
    const ctx = buildDocumentContext(doc2);
    expect(ctx.outline[0].preview).toContain('Name of the project is important.');
  });

  it('omits quoted CommandInset arguments from previews (ref properties)', () => {
    // Regression (live failure, 2026-10-10): a paragraph "Let [Formula] be
    // the polynomial justification for [ref eq:LotJ]…" leaked
    // `reference "eq:LotJ"`, `plural "false"`, `caps "false"`,
    // `noprefix "false"`, `nolink "false"` into its preview. Those
    // invisible property lines poisoned the fuzzy verification windows
    // and paragraph targeting failed on the RIGHT paragraph.
    const doc3 =
      HEADER +
      [
        '',
        '\\begin_body',
        '',
        '\\begin_layout Standard',
        'Let ',
        '\\begin_inset Formula $S=\\big(a\\cdot t\\big)$',
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
        ' is derivable, and it is possible to assign to it a probability.',
        '\\end_layout',
        '',
        '\\end_body',
        '\\end_document',
        '',
      ].join('\n');
    const ctx = buildDocumentContext(doc3);
    const preview = ctx.outline[0].preview;
    expect(preview).toBe(
      'Let be the polynomial justification for , the statement is derivable, and it is possible to assign to it a probability.',
    );
    for (const p of ctx.outline) {
      expect(p.preview).not.toMatch(/plural|noprefix|nolink|reference "eq/);
    }
  });

  it('keeps quoted prose inside insets that merely looks like a property', () => {
    // Only the exact `name "value"` property form is dropped; real prose
    // inside a note (e.g. "after the proof we …") must survive.
    const doc4 =
      HEADER +
      [
        '',
        '\\begin_body',
        '',
        '\\begin_layout Standard',
        '\\begin_inset Note Note',
        'status open',
        '',
        '\\begin_layout Plain Layout',
        'After the proof we can still say reference "eq:LotJ" in prose.',
        '\\end_layout',
        '',
        '\\end_inset',
        '\\end_layout',
        '',
        '\\end_body',
        '\\end_document',
        '',
      ].join('\n');
    const ctx = buildDocumentContext(doc4);
    expect(ctx.outline[0].preview).toContain('After the proof we can still say');
  });
});
describe('splitTopLevelLayouts / normalizeMarkupBlock', () => {
  const body = [
    '\\begin_layout Standard',
    'First paragraph ',
    '\\begin_inset Note Note',
    'status open',
    '',
    '\\begin_layout Plain Layout',
    'Inner note text.',
    '\\end_layout',
    '',
    '\\end_inset',
    ' trailing.',
    '\\end_layout',
    '',
    '\\begin_layout Section',
    'Second block',
    '\\end_layout',
  ].join('\n');

  it('splits top-level blocks but not inset-inner layouts', () => {
    const blocks = splitTopLevelLayouts(body);
    expect(blocks.length).toBe(2);
    expect(blocks[0]).toContain('\\begin_inset Note Note');
    expect(blocks[0]).toContain('\\begin_layout Plain Layout'); // stays inside block 1
    expect(blocks[0]).not.toContain('\\begin_layout Standard\\n'); // single start line
    expect(blocks[1]).toContain('Second block');
  });

  it('handles CRLF input like the Windows clipboard', () => {
    const blocks = splitTopLevelLayouts(body.replace(/\n/g, '\r\n'));
    expect(blocks.length).toBe(2);
  });

  it('normalizes markup blocks whitespace-insensitively', () => {
    const a = normalizeMarkupBlock('\\begin_layout Standard\r\nHi   \n \nthere.\n');
    const b = normalizeMarkupBlock('\\begin_layout Standard\nHi\nthere.');
    expect(a).toBe(b);
  });

  it('round-trips paragraphs extracted from a full document', () => {
    const doc =
      HEADER +
      '\n\n\\begin_body\n\n' +
      body +
      '\n\n\\end_body\n\\end_document\n';
    const blocks = splitTopLevelLayouts(extractBodyLayouts(doc) ?? '');
    expect(blocks.length).toBe(2);
    const firstBlock = body.split('\n').slice(0, 12).join('\n');
    expect(normalizeMarkupBlock(blocks[0] ?? '')).toBe(normalizeMarkupBlock(firstBlock));
  });
});
