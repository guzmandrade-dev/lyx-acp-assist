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
 * Auto-correction note for one matched action tag: null when the raw tag
 * is the canonical form, otherwise the raw tag text so the UI can show
 * what was corrected.
 */
export function actionTagNote(raw: string | undefined, canonical: string): string | null {
  if (!raw) return null;
  const tag = raw.trim();
  return tag === canonical ? null : tag;
}