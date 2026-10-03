/**
 * Read-only, line-based parser for the `.lyx` file format.
 *
 * This is a TypeScript port of the grammar implemented by `lq`
 * (https://github.com/naivej/lq, MIT license), adapted from
 * `src/parser.rs` and `src/ast.rs`. We use lq only as a grammar
 * reference; there is no runtime dependency.
 *
 * The `.lyx` format is line-oriented:
 *   - `#` first line: comment header
 *   - `\lyxformat <n>`: format version property
 *   - `\begin_<tag> [args]` ... `\end_<tag>`: blocks
 *   - `\<key> [value]`: properties
 *   - anything else: text lines
 * Blocks whose content must be captured verbatim ("opaque" blocks) are
 * `preamble` and the insets `Formula` and `ERT`.
 *
 * Two parse modes (same as lq):
 *   - `parse()`: strict — any mismatched or unclosed tag is an error.
 *   - `parseRecovering()`: preview-mode — mimics what LyX itself accepts
 *     (auto-close at `\end_document`, skip extra `\end_layout`/`\end_body`/
 *     `\end_deeper`, refuse stray `\end_inset`, require `\lyxformat`).
 *
 * The parser never writes anything: it exists to build agent context and
 * to address content. All document mutation goes through LyX itself via
 * the LyXServer pipe (see AGENTS.md).
 */

export type LyxNode =
  | { type: 'block'; tag: string; args?: string; beginVariant: boolean; line: number; children: LyxNode[] }
  | { type: 'property'; key: string; value?: string; line: number }
  | { type: 'text'; text: string; line: number };

export interface LyxDocument {
  /** Root children: header comment, properties, `\begin_document` block, etc. */
  children: LyxNode[];
}

export class ParseError extends Error {}

export interface RecoveredParse {
  document: LyxDocument;
  /** Notes about imperfect structure LyX would still open. */
  notes: string[];
  structureRecovered(): boolean;
}

function isIdentChar(c: string): boolean {
  return /[A-Za-z0-9_]/.test(c);
}

/**
 * After a command prefix, take `[a-zA-Z0-9_]+` and optional `\s+(.*)` args.
 * `undefined` args when there is no whitespace after the ident.
 */
function identAndArgs(rest: string): { ident: string; args?: string } | undefined {
  const match = /^([A-Za-z0-9_]+)(?: (.*))?$/.exec(rest);
  if (!match) return undefined;
  return { ident: match[1]!, args: match[2] };
}

function parseBegin(line: string): { ident: string; args?: string } | undefined {
  if (!line.startsWith('\\begin_')) return undefined;
  return identAndArgs(line.slice('\\begin_'.length));
}

function parseEnd(line: string): string | undefined {
  if (!line.startsWith('\\end_')) return undefined;
  const rest = line.slice('\\end_'.length);
  if (rest.length === 0 || ![...rest].every(isIdentChar)) return undefined;
  return rest;
}

function parseProp(line: string): { ident: string; args?: string } | undefined {
  if (!line.startsWith('\\')) return undefined;
  return identAndArgs(line.slice(1));
}

function enterOpaque(tag: string, args: string | undefined): boolean {
  const trimmed = (args ?? '').trim();
  return tag === 'preamble' || (tag === 'inset' && (trimmed === 'Formula' || trimmed === 'ERT'));
}

/** Properties that open a block without a `\begin_` variant. */
const PROP_BLOCK_KEYS = new Set(['index', 'branch', 'modules']);

interface StackEntry {
  tag: string;
  line: number;
  children: LyxNode[];
}

function splitLines(text: string): string[] {
  return text.split('\n').map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

/** Strict parse: every tag must be matched. */
export function parse(text: string, isSnippet = false): LyxDocument {
  if (!isSnippet && !text.trimStart().startsWith('#')) {
    throw new ParseError("Invalid LyX file format. Expected '#' comment header.");
  }

  const children: LyxNode[] = [];
  const stack: StackEntry[] = [];
  let inOpaque = false;
  let opaqueTag = '';

  const lines = splitLines(text);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;

    if (inOpaque) {
      if (line === `\\end_${opaqueTag}`) {
        inOpaque = false;
        stack.pop();
      } else {
        const parent = stack[stack.length - 1];
        if (!parent) throw new ParseError('Internal error: opaque block missing from stack.');
        parent.children.push({ type: 'text', text: line, line: i });
      }
      continue;
    }

    const begin = parseBegin(line);
    if (begin) {
      const entry: StackEntry = { tag: begin.ident, line: i, children: [] };
      const node: LyxNode = {
        type: 'block',
        tag: begin.ident,
        args: begin.args,
        beginVariant: true,
        line: i,
        children: entry.children,
      };
      const parent = stack[stack.length - 1];
      if (parent) parent.children.push(node);
      else children.push(node);
      stack.push(entry);
      if (enterOpaque(begin.ident, begin.args)) {
        inOpaque = true;
        opaqueTag = begin.ident;
      }
      continue;
    }

    const end = parseEnd(line);
    if (end) {
      const top = stack[stack.length - 1];
      if (!top || top.tag !== end) {
        throw new ParseError(
          `Mismatched end tag: expected ${top?.tag ?? 'undefined'}, got ${end} at line ${i}`,
        );
      }
      stack.pop();
      continue;
    }

    const prop = parseProp(line);
    if (prop) {
      if (PROP_BLOCK_KEYS.has(prop.ident)) {
        const entry: StackEntry = { tag: prop.ident, line: i, children: [] };
        const node: LyxNode = {
          type: 'block',
          tag: prop.ident,
          args: prop.args,
          beginVariant: false,
          line: i,
          children: entry.children,
        };
        const parent = stack[stack.length - 1];
        if (parent) parent.children.push(node);
        else children.push(node);
        stack.push(entry);
        continue;
      }
      const node: LyxNode = { type: 'property', key: prop.ident, value: prop.args, line: i };
      const parent = stack[stack.length - 1];
      if (parent) parent.children.push(node);
      else children.push(node);
      continue;
    }

    const parent = stack[stack.length - 1];
    const textNode: LyxNode = { type: 'text', text: line, line: i };
    if (parent) parent.children.push(textNode);
    else children.push(textNode);
  }

  if (stack.length > 0) {
    const top = stack[stack.length - 1]!;
    throw new ParseError(`Unclosed tag: ${top.tag} (opened at line ${top.line})`);
  }

  return { children };
}

function firstRealLine(text: string): string | undefined {
  for (const raw of splitLines(text)) {
    const line = raw.trim();
    if (line && !line.startsWith('#')) return line;
  }
  return undefined;
}

function firstRealTokenIsLyxformat(text: string): boolean {
  const line = firstRealLine(text);
  if (!line) return false;
  const prop = parseProp(line);
  return prop?.ident === 'lyxformat';
}

/** Recovering parse: follow the LyX window; never fail on files LyX opens. */
export function parseRecovering(text: string): RecoveredParse {
  if (!text.trimStart().startsWith('#') && !firstRealTokenIsLyxformat(text)) {
    throw new ParseError(
      'This file is not a readable LyX document (missing \\lyxformat).',
    );
  }

  const children: LyxNode[] = [];
  const stack: StackEntry[] = [];
  const notes: string[] = [];
  let inOpaque = false;
  let opaqueTag = '';
  let sawEndDocument = false;

  const closeOpen = () => {
    const entry = stack.pop();
    if (!entry) return;
    notes.push(`unclosed ${entry.tag} (opened at line ${entry.line})`);
  };

  const lines = splitLines(text);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;

    if (inOpaque) {
      if (line === `\\end_${opaqueTag}`) {
        inOpaque = false;
        stack.pop();
      } else {
        const parent = stack[stack.length - 1];
        if (!parent) throw new ParseError('Internal error: opaque block missing from stack.');
        parent.children.push({ type: 'text', text: line, line: i });
      }
      continue;
    }

    const begin = parseBegin(line);
    if (begin) {
      const entry: StackEntry = { tag: begin.ident, line: i, children: [] };
      const node: LyxNode = {
        type: 'block',
        tag: begin.ident,
        args: begin.args,
        beginVariant: true,
        line: i,
        children: entry.children,
      };
      const parent = stack[stack.length - 1];
      if (parent) parent.children.push(node);
      else children.push(node);
      stack.push(entry);
      if (enterOpaque(begin.ident, begin.args)) {
        inOpaque = true;
        opaqueTag = begin.ident;
      }
      continue;
    }

    const end = parseEnd(line);
    if (end) {
      if (end === 'document') {
        while (stack.length > 0 && stack[stack.length - 1]!.tag !== 'document') {
          closeOpen();
        }
        if (stack.length > 0 && stack[stack.length - 1]!.tag === 'document') {
          stack.pop();
        }
        sawEndDocument = true;
        break;
      }

      const top = stack[stack.length - 1];
      if (top && top.tag === end) {
        stack.pop();
        continue;
      }

      // Close intermediates until the matching ancestor.
      const ancestorDepth = [...stack].reverse().findIndex((e) => e.tag === end);
      if (ancestorDepth !== -1) {
        for (let d = 0; d < ancestorDepth; d++) closeOpen();
        stack.pop();
        continue;
      }

      if (end === 'inset') {
        throw new ParseError(
          `Mismatched end tag: expected ${top?.tag ?? 'undefined'}, got inset at line ${i}`,
        );
      }

      notes.push(`skipped extra \\end_${end} at line ${i}`);
      continue;
    }

    const prop = parseProp(line);
    if (prop) {
      if (PROP_BLOCK_KEYS.has(prop.ident)) {
        const entry: StackEntry = { tag: prop.ident, line: i, children: [] };
        const node: LyxNode = {
          type: 'block',
          tag: prop.ident,
          args: prop.args,
          beginVariant: false,
          line: i,
          children: entry.children,
        };
        const parent = stack[stack.length - 1];
        if (parent) parent.children.push(node);
        else children.push(node);
        stack.push(entry);
        continue;
      }
      const node: LyxNode = { type: 'property', key: prop.ident, value: prop.args, line: i };
      const parent = stack[stack.length - 1];
      if (parent) parent.children.push(node);
      else children.push(node);
      continue;
    }

    const parent = stack[stack.length - 1];
    const textNode: LyxNode = { type: 'text', text: line, line: i };
    if (parent) parent.children.push(textNode);
    else children.push(textNode);
  }

  if (!sawEndDocument) {
    throw new ParseError(
      'Document ended unexpectedly, which means it is probably corrupted.',
    );
  }

  return {
    document: { children },
    notes,
    structureRecovered() {
      return notes.length > 0;
    },
  };
}