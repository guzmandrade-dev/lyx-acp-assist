/**
 * Parse the agent's ```writer content block into structured paragraphs.
 *
 * The block format is markdown-lite: line-level styles are chosen by the
 * leading marker, inline formatting by **bold**, *italic*, `code` spans.
 * The result is a list of { style, runs } paragraphs the bridge applies
 * directly (no markup round-trip through LibreOffice).
 */

import type { BlockParagraph, BlockRun } from '../bridge/client.js';
import { ACTION_HEADER, actionTagNote } from '@acp-assist/core';

// Shared with the LyX app via @acp-assist/core; re-exported here so the
// module adapters keep their single markdown.js import point.
export { ACTION_HEADER, actionTagNote };

/**
 * Line-level action-tag test with the tolerant header: tags are
 * protocol, never content, so parseContentBlock/parseTsvBlock drop any
 * line that looks like a tag — including typo'd ones.
 */
export const ACTION_TAG_LINE = new RegExp(`^\\s*${ACTION_HEADER}[^\\]]*\\]\\s*$`, 'i');

/** Map a markdown heading level to a Writer paragraph style name. */
function headingStyle(level: number): string | null {
  switch (Math.min(level, 4)) {
    case 1:
      return 'Heading 1';
    case 2:
      return 'Heading 2';
    case 3:
      return 'Heading 3';
    case 4:
      return 'Heading 4';
    default:
      return null;
  }
}

/**
 * Split one line of inline text into runs. Code spans take precedence
 * (their content is never re-parsed for bold/italic). Emphasis markers
 * only toggle when they look like openers/closers: a `*` surrounded by
 * spaces stays literal ("a * b" is plain text, "*em*" toggles).
 */
export function parseInline(line: string): BlockRun[] {
  const runs: BlockRun[] = [];
  let i = 0;
  let bold = false;
  let italic = false;
  let prev = ''; // last literal character consumed

  const push = (text: string, code: boolean) => {
    if (!text) return;
    const bold0 = code ? false : bold;
    const italic0 = code ? false : italic;
    const last = runs[runs.length - 1];
    if (last && last.bold === bold0 && last.italic === italic0 && last.code === code) {
      last.text += text;
    } else {
      runs.push({ text, bold: bold0, italic: italic0, code });
    }
    prev = text.endsWith(' ') ? ' ' : text.slice(-1);
  };

  while (i < line.length) {
    const rest = line.slice(i);
    const codeMatch = rest.match(/^`([^`\n]+)`/);
    if (codeMatch?.[1] !== undefined) {
      push(codeMatch[1], true);
      i += codeMatch[0].length;
      continue;
    }
    if (rest.startsWith('**')) {
      // Opener: followed by non-space. Closer: preceded by non-space.
      const opener = rest[2] !== undefined && rest[2] !== ' ';
      const closer = prev !== '' && prev !== ' ';
      if (!bold && !opener && !closer) {
        push('**', false);
        i += 2;
        continue;
      }
      bold = !bold;
      i += 2;
      continue;
    }
    if (rest.startsWith('*')) {
      const opener = rest[1] !== undefined && rest[1] !== ' ';
      const closer = prev !== '' && prev !== ' ';
      if (!italic && !opener && !closer) {
        push('*', false);
        i += 1;
        continue;
      }
      italic = !italic;
      i += 1;
      continue;
    }
    // Consume up to the next marker.
    const next = (() => {
      let j = i;
      while (j < line.length && !'`*'.includes(line.charAt(j))) j++;
      return j;
    })();
    push(line.slice(i, next), false);
    i = next;
  }
  return runs.filter((r) => r.text !== '');
}

/**
 * Parse the whole content block. Fenced code sections (``` ... ```)
 * become "Preformatted Text" paragraphs; blank lines separate paragraphs;
 * everything else maps by its leading marker. Consecutive non-blank
 * lines are joined into one paragraph (soft-wrap semantics).
 */
export function parseContentBlock(block: string): BlockParagraph[] {
  const paragraphs: BlockParagraph[] = [];
  const lines = block.replace(/\r\n/g, '\n').split('\n');
  let buffer: { style: string | null; lines: string[] } | null = null;

  const flush = () => {
    const buf = buffer;
    if (!buf || buf.lines.length === 0) return;
    const text = buf.lines.join(' ').trim();
    if (text) {
      paragraphs.push({ style: buf.style, runs: parseInline(text) });
    }
    buffer = null;
  };

  let inCodeFence = false;
  let codeLines: string[] = [];

  for (const raw of lines) {
    const line = raw.trimEnd();
    // Agents sometimes put the action tag INSIDE the fenced block (and
    // echo the block twice). Tags are protocol, never content: drop them
    // wherever they appear so they can never land in the document.
    if (ACTION_TAG_LINE.test(line)) {
      flush();
      continue;
    }
    if (inCodeFence) {
      if (line.trim().startsWith('```')) {
        for (const l of codeLines) paragraphs.push({ style: 'Preformatted Text', runs: [{ text: l }] });
        codeLines = [];
        inCodeFence = false;
      } else {
        codeLines.push(raw);
      }
      continue;
    }
    if (line.trim().startsWith('```')) {
      flush();
      inCodeFence = true;
      codeLines = [];
      continue;
    }

    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    const bullet = line.match(/^\s*[-*+]\s+(.*)$/);
    const quote = line.match(/^>\s?(.*)$/);

    if (heading) {
      flush();
      const text = (heading[2] ?? '').trim();
      const level = (heading[1] ?? '#').length;
      if (text) paragraphs.push({ style: headingStyle(level), runs: parseInline(text) });
      continue;
    }
    if (bullet) {
      // List item: keep the bullet visible as plain text (Writer list
      // styles with numbering are a later refinement).
      flush();
      paragraphs.push({ style: null, runs: parseInline(`• ${(bullet[1] ?? '').trim()}`) });
      continue;
    }
    if (quote) {
      flush();
      paragraphs.push({ style: 'Quotations', runs: parseInline((quote[1] ?? '').trim()) });
      continue;
    }
    if (line.trim() === '') {
      flush();
      continue;
    }
    // Plain text: same-style lines join into one paragraph.
    if (!buffer) buffer = { style: null, lines: [] };
    buffer.lines.push(line.trim());
  }
  if (inCodeFence && codeLines.length > 0) {
    // Unclosed fence: still emit what we collected.
    for (const l of codeLines) paragraphs.push({ style: 'Preformatted Text', runs: [{ text: l }] });
  }
  flush();
  return paragraphs;
}

/**
 * Extract a fenced content block from a reply (the content payload for
 * document actions). `lang` selects the fence language ("writer" for
 * markdown-lite paragraphs, "calc" for TSV). Returns null when the reply
 * contains none. The LAST fence wins — some agents echo the block while
 * explaining; like action tags, the final one is the operative content.
 */
/** Compiled fence regexes per language, reused across replies. */
const contentBlockRes = new Map<string, RegExp>();

export function extractContentBlock(reply: string, lang: string = 'writer'): string | null {
  let re = contentBlockRes.get(lang);
  if (!re) {
    re = new RegExp('```' + lang + '\\s*\\n([\\s\\S]*?)```', 'gi');
    contentBlockRes.set(lang, re);
  }
  const fences = [...reply.matchAll(re)];
  const last = fences[fences.length - 1];
  return last?.[1] ?? null;
}

/**
 * Parse a ```calc content block into TSV rows: one sheet row per line,
 * cells split on tabs. Action tags are protocol, never content — they are
 * dropped wherever they appear. Trailing empty lines are removed.
 */
export function parseTsvBlock(block: string): string[][] {
  const rows: string[][] = [];
  for (const raw of block.replace(/\r\n/g, '\n').split('\n')) {
    if (ACTION_TAG_LINE.test(raw)) continue;
    rows.push(raw.split('\t'));
  }
  while (rows.length > 0 && (rows[rows.length - 1] ?? []).every((c) => c.trim() === '')) {
    rows.pop();
  }
  return rows;
}