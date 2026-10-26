/**
 * Impress module adapter (also serves Draw): builds the agent's deck
 * context (slide outline, selected frames) and applies slide-addressed
 * actions through the bridge.
 *
 * Addressing is [sN] (1-based slide numbers, rendered from the bridge's
 * 0-based indices); content goes in a ```impress fenced block: the first
 * line is the slide TITLE, every following non-empty line is one body
 * paragraph. One block = one slide. Impress/Draw edits are undo-only
 * (the bridge keeps a per-edit undo journal; there is no change tracking
 * in these modules).
 */

import type { BridgeClient, BridgeDocument, SlidesSelectionShape } from '../bridge/client.js';
import { extractContentBlock, ACTION_HEADER, ACTION_TAG_LINE, actionTagNote, lastFencedMatch, lastNonEmptyLine } from './markdown.js';
import type { ActionOutcome, AppliedAction, ModuleAdapter, SelectionInfo } from './types.js';

/** Last-tag grammar: [ACTION: name] or [ACTION: name sN]. The header
 * tolerates tag typos ("[AACTION:"), reported via tagNote. */
const IMPRESS_TAG = new RegExp(
  `${ACTION_HEADER}\\s*(rewrite-slide|insert-after|rewrite|none|continue)(?:\\s+s([0-9]+))?\\s*\\]`,
  'gi',
);

const CONTENT_ACTIONS = ['rewrite', 'rewrite-slide', 'insert-after'];

/** One ```impress block -> plain paragraphs (title first, then body lines). */
function blockLines(block: string): string[] {
  return block
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !ACTION_TAG_LINE.test(line));
}

/** Parse an agent reply against the Impress vocabulary. */
export function parseImpressAction(reply: string): ActionOutcome {
  // Audit B5: last non-empty line first; a tag inside a content fence
  // still counts (live-observed); bare prose never does.
  const tags = [...lastNonEmptyLine(reply).matchAll(IMPRESS_TAG)];
  const m = tags[tags.length - 1] ?? lastFencedMatch(reply, IMPRESS_TAG) ?? undefined;
  const action = ((m?.[1] ?? 'none').toLowerCase()) as ActionOutcome['action'];
  const target = m?.[2] ? Number.parseInt(m[2], 10) : null;
  const needsContent = CONTENT_ACTIONS.includes(action);
  const rawBlock = needsContent ? extractContentBlock(reply, 'impress') : null;
  const lines = needsContent && rawBlock !== null ? blockLines(rawBlock) : null;
  return {
    action,
    target,
    address: null,
    // Plain single-run paragraphs: Phase 3 slides carry no inline
    // formatting. First entry = the title line, the rest = body.
    block:
      needsContent && lines !== null
        ? lines.map((text) => ({ style: null, runs: [{ text }] }))
        : null,
    grid: null,
    tagNote: actionTagNote(m?.[0], `[ACTION: ${action}${target !== null ? ` s${target}` : ''}]`),
  };
}

function isSlidesDoc(doc: BridgeDocument): boolean {
  return doc.module === 'impress' || doc.module === 'draw';
}

function blockToText(outcome: ActionOutcome): string[] {
  return (outcome.block ?? []).map((p) => p.runs.map((r) => r.text).join(''));
}

function preview(text: string, len = 100): string {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length <= len ? t : `${t.slice(0, len)}…`;
}

export const impressAdapter: ModuleAdapter = {
  id: 'impress',

  buildActionInstructions(): string {
    return [
      'Decide yourself what the user wants, and END your reply with exactly one',
      'of these action tags on its own last line:',
      '- [ACTION: none] to reply in prose only (questions, explanations,',
      '  discussion, planning).',
      '- [ACTION: rewrite] to REPLACE the text of the SELECTED frame (given',
      '  below): include a ```impress block with the complete new frame text.',
      '- [ACTION: rewrite-slide sN] to REPLACE the outline of slide [sN]:',
      '  include a ```impress block whose first line is the new title and the',
      '  following lines are the new body paragraphs (empty body lines keep',
      '  the current body).',
      '- [ACTION: insert-after sN] to insert a NEW slide after slide [sN]',
      '  with a title and body: include a ```impress block. Use s0 to insert',
      '  at the very start of the deck (as the new first slide).',
      '',
      'Content format (```impress block): plain text, no markdown. The FIRST',
      'non-empty line is the slide title; every following non-empty line is',
      'one body paragraph (rendered as one bullet/outline point). One block',
      '= one slide. When one request needs SEVERAL new slides, insert the',
      'FIRST one now; the app re-prompts you with fresh context for the next.',
      '',
      'Rules for document actions:',
      '- The document context lists slides as [sN] ids with their titles and',
      '  body previews.',
      '- The action tag must be the very last line of your reply.',
      '- The action is applied to the LIVE document. These modules have no',
      '  change tracking: each edit is a single undo step the user can',
      '  revert with the app\u2019s Undo button.',
      '- Slides the context shows as having no title/body frame cannot be',
      '  rewritten with rewrite-slide (a fresh slide from insert-after',
      '  always has both).',
      '- When one request needs SEVERAL edits, apply the FIRST edit now and',
      '  end with its action tag; the app re-prompts you with fresh slide',
      '  numbers for the next edit.',
    ].join('\n');
  },

  buildContextBlock(doc: BridgeDocument, filePath: string | null): string {
    if (!isSlidesDoc(doc) || !doc.slides) {
      return `Document context\n================\nActive document is not an Impress/Draw document (module: ${doc.module}).`;
    }
    const lines: string[] = [
      'Document context',
      '================',
      `File: ${filePath ?? '(unsaved document)'}`,
      `Title: ${doc.title}`,
      `Slides: ${doc.slides.length}${doc.truncated ? ' (truncated — more exist)' : ''}`,
      `Module: ${doc.module}`,
      '',
    ];
    for (const slide of doc.slides) {
      const shapes = slide.shapes;
      const title = shapes.find((s) => s.kind === 'title') ?? shapes.find((s) => s.kind === 'text');
      const body = shapes.find((s) => s.kind === 'body');
      const others = shapes.filter((s) => s.kind === 'other').length;
      const current = slide.current ? ' (current)' : '';
      const main = `[s${slide.i + 1}]${current} ${title?.text ? `"${title.text}"` : '(no title frame)'}`;
      const detail: string[] = [];
      if (body) {
        const paras = body.text ? body.text.split('\n').filter((l) => l.length > 0).length : 0;
        detail.push(`body: ${paras} paragraph(s)`);
      }
      if (doc.module === 'draw') {
        const texts = shapes.filter((s) => s.kind === 'text');
        if (texts.length > 0) {
          detail.push(`${texts.length} text frame(s) — use rewrite on a selected frame`);
        }
      }
      if (others > 0) detail.push(`${others} other shape(s)`);
      lines.push(main + (detail.length > 0 ? ` | ${detail.join(', ')}` : ''));
      if (body?.text) {
        const first = body.text.split('\n').find((l) => l.length > 0);
        if (first) lines.push(`     ${preview(first)}`);
      }
    }
    return lines.join('\n');
  },

  buildSelectionBlock(sel: SelectionInfo): string {
    const frames = sel.slidesSelection;
    if (!frames || frames.length === 0) return '';
    const lines: string[] = ['', 'Current selection (the user may ask you to rewrite it):'];
    for (const f of frames) {
      if (f.kind === 'other' || f.text === null) continue;
      lines.push(`[s${f.slide + 1}] frame ${f.shape} (${f.kind}):`);
      lines.push('```text');
      lines.push(f.text);
      lines.push('```');
    }
    return lines.length > 2 ? lines.join('\n') : '';
  },

  renderOutline(doc: BridgeDocument): string {
    return (doc.slides ?? [])
      .map((s) => {
        const title = s.shapes.find((sh) => sh.kind === 'title' || sh.kind === 'text');
        return `[s${s.i + 1}]${s.current ? ' *' : ''} ${title?.text ? preview(title.text) : '(untitled)'}`;
      })
      .join('\n');
  },

  async applyAction(
    bridge: BridgeClient,
    doc: BridgeDocument,
    sel: SelectionInfo,
    outcome: ActionOutcome,
  ): Promise<AppliedAction> {
    const needsContent = CONTENT_ACTIONS.includes(outcome.action);
    if (needsContent && (!outcome.block || outcome.block.length === 0)) {
      throw new Error(
        `[ACTION: ${outcome.action}] needs a \`\`\`impress content block; the reply contained none.`,
      );
    }
    const slideCount = doc.slides?.length ?? 0;
    const lines = blockToText(outcome);
    const title = lines[0] ?? '';
    const body = lines.slice(1);

    if (outcome.action === 'rewrite') {
      const frames = (sel.slidesSelection ?? []).filter((f) => f.kind !== 'other' && f.text !== null);
      const frame: SlidesSelectionShape | undefined = frames[0];
      if (!frame) {
        throw new Error('[ACTION: rewrite] but no text frame is selected on the slide.');
      }
      await bridge.edit({
        mode: 'rewrite-frame',
        slide: frame.slide,
        shape: frame.shape,
        paragraphs: lines,
      });
      return { description: `[ACTION: rewrite frame on s${frame.slide + 1}]` };
    }

    if (outcome.action === 'rewrite-slide') {
      if (!outcome.target || outcome.target < 1) {
        throw new Error('[ACTION: rewrite-slide] needs a slide number (e.g. rewrite-slide s2).');
      }
      if (outcome.target > slideCount) {
        throw new Error(`Slide [s${outcome.target}] does not exist (deck has ${slideCount}).`);
      }
      await bridge.edit({
        mode: 'rewrite-slide',
        slide: outcome.target - 1,
        title,
        body,
      });
      return { description: `[ACTION: rewrite-slide s${outcome.target}]` };
    }

    if (outcome.action === 'insert-after') {
      if (outcome.target === null || outcome.target < 0) {
        throw new Error('[ACTION: insert-after] needs a slide number (s0 = the very start, e.g. insert-after s2).');
      }
      if (outcome.target > slideCount) {
        throw new Error(`Slide [s${outcome.target}] does not exist (deck has ${slideCount}).`);
      }
      const r = await bridge.edit({
        mode: 'insert-slide-after',
        slide: outcome.target,
        title,
        body,
      });
      const at = r.slide ?? outcome.target;
      const where = at === 0 ? 'at the very start' : `after s${at}`;
      return { description: `[ACTION: insert-after — new slide ${where}]` };
    }

    throw new Error(`[ACTION: ${outcome.action}] is not an Impress/Draw document action.`);
  },
};
