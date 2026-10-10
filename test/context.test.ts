import { describe, expect, it } from 'vitest';
import {
  assemblePasteDocument,
  extractBodyLayouts,
  findMarkupProblems,
  buildDocumentContext,
  renderOutline,
} from '../src/lyx/context.js';
import { parse } from '../src/lyx/parser.js';

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
});