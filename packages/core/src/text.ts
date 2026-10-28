/**
 * Small text helpers shared by the companion apps
 * (the two identical module-local `preview` helpers in the LibreOffice app).
 */

/**
 * Short single-line preview of a text: whitespace-collapsed, trimmed,
 * capped at `len` characters with an ellipsis. Default 120 = the Writer
 * outline preview length.
 */
export function preview(text: string, len = 120): string {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length <= len ? t : `${t.slice(0, len)}…`;
}
