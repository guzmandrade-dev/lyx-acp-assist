/**
 * Agent action parsing for the LyX app: the [ACTION: ...] tag vocabulary
 * of the document-edit actions, parsed out of an agent reply.
 */
import { createParseActionTag } from '@acp-assist/core';
import { extractBodyLayouts } from './context.js';

export type AgentAction =
  | 'none'
  | 'continue'
  | 'insert'
  | 'insert-top'
  | 'insert-after'
  | 'insert-before'
  | 'rewrite'
  | 'rewrite-at'
  | 'delete-at'
  | 'merge'
  | 'move';

export interface ActionOutcome {
  action: AgentAction;
  body: string | null;
  /** Paragraph address [pN] for rewrite-at / insert-after. */
  target: number | null;
  /** Destination address [pM] for move (0 = top of the document). */
  target2: number | null;
  /** Raw tag text when a near-miss tag (typo, missing colon) was
   *  auto-corrected by the tolerant parser; null when the tag was
   *  canonical or no tag matched. */
  tagNote?: string | null;
}

/**
 * Grammar: [ACTION: name pN (to )?pM] — the LyX vocabulary with two
 * paragraph targets (move). The layered resolution (last non-empty line,
 * then inside a fence, never bare prose) and the capture extraction live
 * in the core factory.
 */
const parseTag = createParseActionTag({
  actions: 'continue|merge|move|delete-at|rewrite-at|insert-before|insert-after|insert-top|rewrite|insert|none',
  targetPattern: '(?:\\s+p(\\d+))?',
  target2Pattern: '(?:\\s+(?:to\\s+)?p(\\d+))?',
});

/**
 * Extract the trailing [ACTION: ...] tag and the ```lyx block from a
 * reply. The header tolerates tag typos ("[AACTION:", doubled letters)
 * and a missing colon — tagNote reports the auto-correction.
 */
export function parseAction(reply: string): ActionOutcome {
  const tag = parseTag(reply);
  const action = tag.action as AgentAction;
  const target = tag.target !== null ? Number.parseInt(tag.target, 10) : null;
  const target2 = tag.target2 !== null ? Number.parseInt(tag.target2, 10) : null;
  // `continue` is accepted for forward-compatibility but is not a document
  // edit: the server's multi-action loop drives continuations itself.
  const body = action === 'none' || action === 'continue' ? null : extractBodyLayouts(reply);
  const canonical =
    `[ACTION: ${action}${target !== null ? ` p${target}` : ''}${target2 !== null ? ` p${target2}` : ''}]`;
  // "move p3 to p5" is accepted grammar, not a typo: compare with the
  // optional "to" stripped so it is not reported as an auto-correction.
  const tagNote =
    tag.rawTag !== null && tag.rawTag.replace(/\s+to\s+/i, ' ') !== canonical ? tag.rawTag : null;
  return { action, body, target, target2, tagNote };
}

/** Describe one applied step compactly for the next continuation prompt. */
export function describeAction(outcome: ActionOutcome): string {
  const parts: string[] = [outcome.action];
  if (outcome.target !== null) parts.push(`p${outcome.target}`);
  if (outcome.target2 !== null) parts.push(`p${outcome.target2}`);
  return `[ACTION: ${parts.join(' ')}]`;
}