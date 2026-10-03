import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse, parseRecovering, ParseError } from '../src/lyx/parser.js';

function mini(body: string): string {
  return (
    '#LyX\n\\lyxformat 643\n\\begin_document\n\\begin_header\n\\textclass article\n\\end_header\n\\begin_body\n' +
    body +
    '\\end_body\n\\end_document\n'
  );
}

describe('strict parse', () => {
  it('rejects missing hash header', () => {
    expect(() => parse('\\begin_document\n\\end_document', false)).toThrow(
      new ParseError("Invalid LyX file format. Expected '#' comment header."),
    );
  });

  it('snippet skips header guard', () => {
    expect(() => parse('\\begin_layout Standard\n\\end_layout', true)).not.toThrow();
  });

  it('mismatched end tag', () => {
    const src = '#x\n\\begin_layout Standard\n\\end_document';
    expect(() => parse(src, false)).toThrow(
      /Mismatched end tag: expected layout, got document at line 2/,
    );
  });

  it('mismatched end with empty stack', () => {
    const src = '#x\n\\end_layout';
    expect(() => parse(src, false)).toThrow(
      /Mismatched end tag: expected undefined, got layout at line 1/,
    );
  });

  it('unclosed tag', () => {
    const src = '#x\n\\begin_layout Standard';
    expect(() => parse(src, false)).toThrow(
      /Unclosed tag: layout \(opened at line 1\)/,
    );
  });

  it('parses a minimal document into a tree', () => {
    const doc = parse(mini('\\begin_layout Standard\nHello\n\\end_layout\n'));
    const docBlock = doc.children.find((n) => n.type === 'block' && n.tag === 'document');
    expect(docBlock).toBeDefined();
    if (docBlock?.type !== 'block') return;
    expect(docBlock.children.some((n) => n.type === 'block' && n.tag === 'header')).toBe(true);
    const body = docBlock.children.find((n) => n.type === 'block' && n.tag === 'body');
    expect(body).toBeDefined();
  });

  it('captures preamble content as opaque text lines', () => {
    const src = mini('\\begin_layout Standard\nHi\n\\end_layout\n');
    const full =
      '#LyX\n\\lyxformat 643\n\\begin_document\n\\begin_preamble\n\\usepackage{foo}\n\\end_preamble\n\\begin_header\n\\end_header\n\\begin_body\n\\begin_layout Standard\nHi\n\\end_layout\n\\end_body\n\\end_document\n';
    const doc = parse(full);
    const find = (nodes: any[], tag: string): any => {
      for (const n of nodes) {
        if (n.type === 'block' && n.tag === tag) return n;
        if (n.type === 'block') {
          const r = find(n.children, tag);
          if (r) return r;
        }
      }
      return undefined;
    };
    const preamble = find(doc.children, 'preamble');
    expect(preamble).toBeDefined();
    expect(preamble.children).toEqual([
      expect.objectContaining({ type: 'text', text: '\\usepackage{foo}' }),
    ]);
    expect(src).toBeTruthy();
  });
});

describe('recovering parse', () => {
  it('recovers unclosed layout with end_document', () => {
    const src = mini('\\begin_layout Standard\nHello\n');
    expect(() => parse(src, false)).toThrow();
    const recovered = parseRecovering(src);
    expect(recovered.structureRecovered()).toBe(true);
    expect(recovered.notes.some((n) => n.startsWith('unclosed layout'))).toBe(true);
  });

  it('recovers missing end_body', () => {
    const src =
      '#LyX\n\\lyxformat 643\n\\begin_document\n\\begin_header\n\\textclass article\n\\end_header\n\\begin_body\n\\begin_layout Standard\nHi\n\\end_layout\n\\end_document\n';
    expect(() => parse(src, false)).toThrow();
    const recovered = parseRecovering(src);
    expect(recovered.structureRecovered()).toBe(true);
  });

  it('recovers extra end_layout', () => {
    const src = mini('\\begin_layout Standard\nHi\n\\end_layout\n\\end_layout\n');
    expect(() => parse(src, false)).toThrow();
    const recovered = parseRecovering(src);
    expect(recovered.notes.some((n) => n.includes('skipped extra \\end_layout'))).toBe(
      true,
    );
  });

  it('refuses no end_document', () => {
    const src = '#LyX\n\\lyxformat 643\n\\begin_document\n\\begin_layout Standard\nHi';
    expect(() => parseRecovering(src)).toThrow(/ended unexpectedly/);
  });

  it('refuses stray end_inset', () => {
    const src = mini('\\end_inset\n\\begin_layout Standard\nHi\n\\end_layout\n');
    expect(() => parseRecovering(src)).toThrow(/inset/);
  });

  it('accepts lyxformat without hash header', () => {
    const src =
      '\\lyxformat 643\n\\begin_document\n\\begin_header\n\\textclass article\n\\end_header\n\\begin_body\n\\begin_layout Standard\nHi\n\\end_layout\n\\end_body\n\\end_document\n';
    expect(() => parse(src, false)).toThrow();
    const recovered = parseRecovering(src);
    expect(recovered.structureRecovered()).toBe(false);
  });

  it('refuses no lyxformat without hash', () => {
    expect(() => parseRecovering('\\begin_document\n\\end_document\n')).toThrow(
      /lyxformat/,
    );
  });
});

describe('fixture smoke tests (files from lq, MIT)', () => {
  const fixturesDir = join(import.meta.dirname, 'fixtures');
  const files = readdirSync(fixturesDir).filter((f) => f.endsWith('.lyx'));

  it('has fixtures to test', () => {
    expect(files.length).toBeGreaterThanOrEqual(10);
  });

  for (const file of files) {
    it(`strict-parses ${file}`, () => {
      const text = readFileSync(join(fixturesDir, file), 'utf8');
      const doc = parse(text);
      expect(doc.children.length).toBeGreaterThan(0);
    });

    it(`recovering-parses ${file} cleanly`, () => {
      const text = readFileSync(join(fixturesDir, file), 'utf8');
      const recovered = parseRecovering(text);
      expect(recovered.structureRecovered()).toBe(false);
    });
  }
});