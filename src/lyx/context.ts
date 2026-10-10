/**
 * Build agent-facing context from a saved `.lyx` file.
 *
 * The parser produces the tree; this module flattens it into:
 *  - `extractHeader`: the verbatim header section (reused when assembling
 *    clipboard payloads for paste).
 *  - `buildOutline`: a compact, addressed paragraph list the agent can
 *    reason about (layout names, nesting, first lines of text).
 *
 * Content addressing: paragraphs are numbered [p1], [p2], ... in document
 * order (depth-first through the body). The agent quotes these ids when
 * referring to content.
 */

import { parse, parseRecovering, type LyxNode } from './parser.js';

export interface OutlineEntry {
  id: string;
  layout: string;
  depth: number;
  preview: string;
  hasMath: boolean;
}

export interface DocumentContext {
  /** Verbatim header text, `#...` through `\end_header` inclusive. */
  header: string;
  /** Verbatim text between `\begin_body` and `\end_body`. */
  body: string;
  outline: OutlineEntry[];
  formatVersion?: string;
  textclass?: string;
}

const PREVIEW_LIMIT = 160;

export function extractHeader(lyxText: string): string | null {
  const end = lyxText.indexOf('\\end_header');
  if (end === -1) return null;
  return lyxText.slice(0, end + '\\end_header'.length);
}

export function extractBody(lyxText: string): string | null {
  const start = lyxText.indexOf('\\begin_body');
  const end = lyxText.lastIndexOf('\\end_body');
  if (start === -1 || end === -1 || end < start) return null;
  return lyxText.slice(start + '\\begin_body'.length, end).trim();
}

export function buildDocumentContext(lyxText: string): DocumentContext {
  let root;
  let notes: string[] = [];
  try {
    root = parse(lyxText);
  } catch {
    const recovered = parseRecovering(lyxText);
    root = recovered.document;
    notes = recovered.notes;
  }
  if (notes.length > 0) {
    // Recovering parse: LyX would still open the file; notes kept for debug.
  }

  const formatVersion = findProperty(root.children, 'lyxformat');
  const textclass = findInBlocks(root.children, 'header', 'textclass');

  let counter = 0;
  const outline: OutlineEntry[] = [];
  const body = findBlock(root.children, 'body');
  if (body && body.type === 'block') {
    walk(body.children, 0);
  }

  function walk(nodes: LyxNode[], depth: number): void {
    for (const node of nodes) {
      if (node.type !== 'block') continue;
      if (node.tag === 'deeper') {
        walk(node.children, depth + 1);
      } else if (node.tag === 'layout') {
        counter++;
        const texts = collectTexts(node.children);
        const preview = texts.join(' ').slice(0, PREVIEW_LIMIT);
        outline.push({
          id: `p${counter}`,
          layout: node.args ?? 'Standard',
          depth,
          preview,
          hasMath: JSON.stringify(node.children).includes('Formula'),
        });
        // Do not descend into layouts: their children are the paragraph's
        // own text and insets, already captured by the preview.
      } else {
        walk(node.children, depth);
      }
    }
  }

  const header = extractHeader(lyxText);
  const bodyText = extractBody(lyxText);

  return {
    header: header ?? '',
    body: bodyText ?? '',
    outline,
    formatVersion,
    textclass,
  };
}

/** Render the outline as the text block we attach to agent prompts. */
export function renderOutline(outline: OutlineEntry[]): string {
  return outline
    .map((e) => {
      const indent = '  '.repeat(e.depth);
      const math = e.hasMath ? ' [math]' : '';
      const preview = e.preview ? ` — ${e.preview}` : '';
      return `${indent}[${e.id}] (${e.layout}${math})${preview}`;
    })
    .join('\n');
}

/** Wrap agent-generated body layouts into a full .lyx document for paste. */
export function assemblePasteDocument(header: string, bodyLayouts: string): string {
  const trimmedHeader = header.trim();
  const trimmedBody = bodyLayouts.trim();
  return `${trimmedHeader}\n\n\\begin_body\n\n${trimmedBody}\n\n\\end_body\n\\end_document\n`;
}

/**
 * Extract body layouts from an agent reply. Accepts:
 *  - raw `\begin_layout` blocks
 *  - a full `\begin_document` document
 *  - content between `\begin_body` / `\end_body`
 */
export function extractBodyLayouts(text: string): string | null {
  const fenced = extractLyxFencedBlock(text) ?? text;
  const bodyStart = fenced.indexOf('\\begin_body');
  const bodyEnd = fenced.lastIndexOf('\\end_body');
  if (bodyStart !== -1 && bodyEnd !== -1 && bodyEnd > bodyStart) {
    return fenced.slice(bodyStart + '\\begin_body'.length, bodyEnd).trim();
  }
  if (bodyStart !== -1 && bodyEnd === -1) {
    // Agent wrote \begin_body without its end: take the remainder.
    return fenced.slice(bodyStart + '\\begin_body'.length).trim();
  }
  if (fenced.includes('\\begin_layout')) {
    return fenced.trim();
  }
  return null;
}

/**
 * Detect LaTeX-style constructs that LyX would mangle into literal text.
 * LyX uses its own token format: `\emph on` ... `\emph default` on their
 * own lines — not `\emph{...}`.
 */
/**
 * Detect markup the agent must fix before we paste it. LyX renders
 * malformed content as literal text or empty insets.
 */
export function findMarkupProblems(body: string): string[] {
  const problems: string[] = [];
  const latexInline = /\\(?:emph|textbf|textit|noun|underline)\\?\{/.exec(body);
  if (latexInline) {
    problems.push(
      `LaTeX-style inline command "${latexInline[0]}" found. LyX markup uses ` +
        'token format instead: \\emph on\\n...\\n\\emph default on their own lines.',
    );
  }
  if (/\\begin\{document\}/.test(body)) problems.push('\\begin{document} is LaTeX, not LyX.');
  if (!body.includes('\\begin_layout')) {
    problems.push('No \\begin_layout block found.');
    return problems;
  }

  // Empty insets: begin_inset line whose args are word-only (type words
  // only, no content) immediately followed by \end_inset. Formula etc.
  // keep content on the begin line, so those with real args are not empty.
  if (/\\begin_inset [A-Za-z][A-Za-z0-9_]*(?: [A-Za-z0-9_]+)*\n\\end_inset/.test(body)) {
    problems.push('Empty inset found (\\begin_inset with no content). Remove or fill it.');
  }
  const insetWithBody = /\\begin_inset (Note|Foot|Flex)\b[\s\S]*?(?=\\end_inset)/g;
  for (const m of body.matchAll(insetWithBody)) {
    if (!m[0].includes('\\begin_layout')) {
      problems.push(
        `Inset "${m[1]}" has no inner \\begin_layout Plain Layout block — ` +
          'it will render EMPTY. Every inset with a body must contain ' +
          '\\begin_layout Plain Layout ... \\end_layout.',
      );
    }
  }
  return problems;
}

/** Prefer a ```lyx fenced block if the agent used one. */
function extractLyxFencedBlock(text: string): string | null {
  const m = /```lyx\s*\n([\s\S]*?)```/.exec(text);
  return m ? m[1]! : null;
}

function findBlock(nodes: LyxNode[], tag: string): LyxNode | undefined {
  for (const node of nodes) {
    if (node.type === 'block') {
      if (node.tag === tag) return node;
      const found = findBlock(node.children, tag);
      if (found) return found;
    }
  }
  return undefined;
}

function findProperty(nodes: LyxNode[], key: string): string | undefined {
  for (const node of nodes) {
    if (node.type === 'property' && node.key === key) return node.value;
    if (node.type === 'block') {
      const found = findProperty(node.children, key);
      if (found) return found;
    }
  }
  return undefined;
}

function findInBlocks(nodes: LyxNode[], blockTag: string, key: string): string | undefined {
  const block = findBlock(nodes, blockTag);
  return block && block.type === 'block' ? findProperty(block.children, key) : undefined;
}

/**
 * Inset property lines that the parser stores as plain `text` children of
 * the inset block (they are file syntax, not visible content). Inside an
 * inset, lines like `status open`, `key "..."`, `LatexCommand ...` are
 * arguments LyX never displays in the document — they leak into previews
 * and break the verification comparison (shifting the fuzzy windows).
 */
const INSET_PROP_LINE =
  /^(status\s+(open|collapsed)|key\s|literal\s|name\s|target\s|LatexCommand\s|label\s)/;

function collectTexts(nodes: LyxNode[], insideInset = false): string[] {
  const out: string[] = [];
  for (const node of nodes) {
    if (node.type === 'text') {
      const cleaned = node.text.replace(/\\(begin|end)_[A-Za-z0-9_]+/g, '').trim();
      // Only treat property-like lines as syntax when they sit directly
      // inside an inset block — paragraph text may legitimately start
      // with the same words.
      if (insideInset && INSET_PROP_LINE.test(cleaned)) continue;
      out.push(cleaned);
    } else if (node.type === 'block') {
      // Skip opaque blocks' raw markup in the preview, but note formulas.
      const inner = collectTexts(node.children, insideInset || node.tag === 'inset');
      out.push(...inner);
    }
  }
  return out.filter((t) => t.length > 0);
}