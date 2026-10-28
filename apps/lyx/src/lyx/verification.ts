/**
 * Paragraph-targeting verification: before a paste is applied at [pN],
 * confirm the paragraph the cursor actually landed on is the one that was
 * addressed — a mis-targeted paste is refused, never applied.
 */
import {
  buildDocumentContext,
  extractBodyLayouts,
  normalizeMarkupBlock,
  splitTopLevelLayouts,
} from './context.js';

/**
 * Normalize text for the paragraph-targeting comparison. Only letters and
 * digits survive (case-insensitive): the .lyx file stores straight quotes
 * and ASCII dashes, while LyX's clipboard text export uses typographic
 * ones, so any punctuation- or whitespace-sensitive comparison would
 * spuriously fail on the same paragraph.
 */
export function normalizeForCompare(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Fuzzy paragraph-targeting match. LyX's UnicodeText export differs from
 * the file's text in ways we cannot normalize away: layout environment
 * labels are prepended ("Abstract", "Summary"), and math insets render
 * inline ($P$ -> "P") while the parser preview has no inset content. So
 * instead of a strict prefix compare, we slide overlapping windows over
 * the expected text and require most of them to appear in the actual
 * text. A genuinely different paragraph (disjoint text) still fails.
 */
export function isLikelyMatch(expected: string, actual: string): boolean {
  if (expected === '') return actual === '';
  const e = expected.slice(0, 160);
  const a = actual.slice(0, 400);
  const WIN = 16;
  const STRIDE = 12;
  let total = 0;
  let hits = 0;
  for (let i = 0; i + WIN <= e.length; i += STRIDE) {
    total++;
    if (a.includes(e.slice(i, i + WIN))) hits++;
  }
  if (total === 0) return a.startsWith(e);
  return hits / total >= 0.6;
}

/**
 * Structure-vs-structure paragraph verification.
 *
 * The old check compared our parsed preview against LyX's RENDERED
 * UnicodeText clipboard export — two representations that can never fully
 * agree (math renders differently, typographic quotes, layout-label
 * prefixes, invisible inset properties), so formula-heavy paragraphs
 * failed targeting on the RIGHT paragraph. Now `copy` puts the raw
 * `application/x-lyx` payload of the selection on the clipboard, and we
 * compare markup against markup:
 *
 * 1. 'markup' — exact (whitespace-insensitive) comparison of the
 *    payload's first top-level layout block against the saved file's
 *    block at `index`. Lossless: formulas, notes, refs compare exactly.
 * 2. 'preview' — if LyX re-serialized the copy cosmetically, parse the
 *    payload with OUR parser and fuzzy-match its preview against the
 *    outline preview (both sides from the same parser — the rendered-
 *    text quirks are gone from the comparison).
 * 3. 'text' — legacy last resort when the clipboard holds no x-lyx
 *    payload: the old UnicodeText fuzzy match.
 */
export interface ParagraphSelectionInput {
  /** Raw .lyx clipboard payload of the copied selection, or null. */
  payload: string | null;
  /** UnicodeText clipboard flavor, used only when payload is null. */
  clipboardText: string | null;
  /** The SAVED .lyx file content (the walk addresses against the file). */
  diskRaw: string;
  /** 0-based index of the target paragraph. */
  index: number;
  /** Outline preview of the target paragraph (expected text). */
  expectedPreview: string;
}

export interface ParagraphVerification {
  ok: boolean;
  /** How the match succeeded: 'markup' | 'preview' | 'text' | 'none'. */
  via: 'markup' | 'preview' | 'text' | 'none';
  /** Normalized text of what was actually found (for the error message). */
  actual: string;
}

export function verifyParagraphSelection(
  input: ParagraphSelectionInput,
): ParagraphVerification {
  const expected = normalizeForCompare(input.expectedPreview);

  if (input.payload) {
    const diskBlocks = splitTopLevelLayouts(extractBodyLayouts(input.diskRaw) ?? '');
    const payloadBlocks = splitTopLevelLayouts(extractBodyLayouts(input.payload) ?? '');
    const diskBlock = diskBlocks[input.index] ?? null;
    const payloadBlock = payloadBlocks[0] ?? null;
    if (diskBlock && payloadBlock) {
      if (normalizeMarkupBlock(payloadBlock) === normalizeMarkupBlock(diskBlock)) {
        return { ok: true, via: 'markup', actual: expected };
      }
    }
    // Same-parser fuzzy fallback: tolerates cosmetic re-serialization by
    // LyX, still rejects a genuinely different paragraph.
    let payloadPreview = '';
    try {
      const payloadCtx = buildDocumentContext(input.payload);
      payloadPreview = payloadCtx.outline[0]?.preview ?? '';
    } catch {
      payloadPreview = '';
    }
    const actual = normalizeForCompare(payloadPreview);
    if (payloadPreview && isLikelyMatch(expected, actual)) {
      return { ok: true, via: 'preview', actual };
    }
    return {
      ok: false,
      via: 'none',
      actual: actual || normalizeForCompare(input.payload),
    };
  }

  const actual = normalizeForCompare(input.clipboardText ?? '');
  if (isLikelyMatch(expected, actual)) {
    return { ok: true, via: 'text', actual };
  }
  return { ok: false, via: 'none', actual };
}