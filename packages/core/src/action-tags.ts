/**
 * Tolerant agent action-tag parsing helpers, shared by both companion
 * apps. The agent ends each reply with a protocol tag like
 * "[ACTION: rewrite-at p3]"; live agents occasionally typo the tag
 * ("[AACTION:", "[ACTTION:") or drop the colon ("[ACTION insert]").
 * A silently unrecognized tag degrades the reply to "chat only" and the
 * requested edit never reaches the document, so the parsers accept
 * near-miss headers and report the auto-correction (tagNote).
 */

/**
 * Tolerant action-tag header for tag regexes: the opening bracket(s),
 * the word "ACTION" with any letter doubled, and an optional colon.
 * Compose as `${ACTION_HEADER}\\s*(<action names>)...`.
 */
export const ACTION_HEADER = '\\[+\\s*A+C+T+I+O+N+\\s*:?';

/**
 * The reply's last non-empty line — the ONLY line the action-tag parsers
 * consider (audit B5: a quoted example mid-reply used to be misparsed as
 * the operative tag; the agent instructions already demand the tag be the
 * reply's last line).
 */
export function lastNonEmptyLine(reply: string): string {
  const lines = reply.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const trimmed = lines[i]?.trim() ?? '';
    if (trimmed) return trimmed;
  }
  return '';
}

/**
 * The LAST tag match INSIDE a fenced (``` ... ```) block. Live-observed
 * 2026-10-24: agents sometimes leave the action tag inside their content
 * fence with no trailing tag line — the parsers recover the action from
 * there. Prose OUTSIDE fences is never searched as a fallback (audit B5:
 * a quoted example mid-reply must not be misparsed as the operative tag).
 */
export function lastFencedMatch(reply: string, tagRe: RegExp): RegExpMatchArray | null {
  let last: RegExpMatchArray | null = null;
  // matchAll needs the global flag; the caller's regex may be non-global.
  const flags = tagRe.flags.includes('g') ? tagRe.flags : `${tagRe.flags}g`;
  const re = new RegExp(tagRe.source, flags);
  for (const fence of reply.matchAll(/```[^\n]*\n[\s\S]*?```/g)) {
    for (const m of (fence[0] ?? '').matchAll(re)) {
      last = m;
    }
  }
  return last;
}

/**
 * Audit Track D: factory for the apps' action-tag parsers. The four
 * near-identical parsers (LyX, LO writer, calc, impress) differ only in
 * vocabulary and target grammar; the B5 layered resolution (last
 * non-empty line, then inside a fence, never bare prose) and the capture
 * extraction live HERE once.
 *
 * `actions` is a pipe-separated alternation, longest-first when actions
 * share prefixes (e.g. `rewrite-at|rewrite`). `targetPattern` /
 * `target2Pattern` are OPTIONAL non-capturing-outer groups whose FIRST
 * capture group is the target (e.g. `(?:\s+p(\d+))?`).
 */
export interface ActionTagGrammar {
  actions: string;
  targetPattern?: string;
  target2Pattern?: string;
}

export interface ParsedActionTag {
  /** Lowercased action name ('none' when no tag matched). */
  action: string;
  /** Raw first-target capture, or null. Callers parse to their own type. */
  target: string | null;
  /** Raw second-target capture, or null (LyX move). */
  target2: string | null;
  /** The matched raw tag text (trimmed), or null. */
  rawTag: string | null;
}

export function createParseActionTag(grammar: ActionTagGrammar): (reply: string) => ParsedActionTag {
  const re = new RegExp(
    `${ACTION_HEADER}\\s*(${grammar.actions})` +
      `${grammar.targetPattern ?? ''}${grammar.target2Pattern ?? ''}\\s*\\]`,
    'i',
  );
  return (reply: string) => {
    const m = lastNonEmptyLine(reply).match(re) ?? lastFencedMatch(reply, re);
    return {
      action: (m?.[1] ?? 'none').toLowerCase(),
      target: m?.[2] ?? null,
      target2: m?.[3] ?? null,
      rawTag: m?.[0]?.trim() ?? null,
    };
  };
}

/**
 * Auto-correction note for one matched action tag: null when the raw tag
 * is the canonical form, otherwise the raw tag text so the UI can show
 * what was corrected.
 */
export function actionTagNote(raw: string | undefined, canonical: string): string | null {
  if (!raw) return null;
  const tag = raw.trim();
  return tag === canonical ? null : tag;
}