/**
 * `application/x-lyx` clipboard access, decoupled from Electron for testing.
 *
 * LyX puts a COMPLETE .lyx document (header + body) of the selection on the
 * clipboard under the `application/x-lyx` format, as raw UTF-8 bytes (a
 * stream). See AGENTS.md "Clipboard protocol" — the payload must be bytes,
 * not a string, or LyX silently falls back to plain text.
 *
 * Electron 43 uses an async, W3C-style clipboard API with atomic
 * multi-format writes (ClipboardItem), so the interface here is async.
 */

export const LYX_CLIPBOARD_FORMAT = 'application/x-lyx';

export interface RawClipboard {
  /** Does the clipboard currently hold the given format? */
  hasFormat(format: string): Promise<boolean>;
  /** Raw bytes of the given format, or null if absent. */
  readFormat(format: string): Promise<Buffer | null>;
  /** Atomically write formats (format -> string or bytes). */
  write(formats: Record<string, string | Buffer>): Promise<void>;
  /** Plain-text flavor of the clipboard. */
  readText(): Promise<string>;
}

export class LyxClipboard {
  constructor(private clipboard: RawClipboard) {}

  async hasLyxPayload(): Promise<boolean> {
    return this.clipboard.hasFormat(LYX_CLIPBOARD_FORMAT);
  }

  /**
   * Read the current .lyx document payload, or null if the clipboard does
   * not hold one (e.g. the copy came from another application).
   */
  async readLyxDocument(): Promise<string | null> {
    const buf = await this.clipboard.readFormat(LYX_CLIPBOARD_FORMAT);
    if (!buf || buf.length === 0) return null;
    return buf.toString('utf8');
  }

  /** The plain-text flavor of the current clipboard (flattened selection). */
  async readText(): Promise<string> {
    return this.clipboard.readText();
  }

  /**
   * Write a .lyx document so that LyX's `paste` LFUN parses it as rich,
   * structured content. A plain-text fallback is written alongside (for
   * other applications) in the same atomic write.
   */
  async writeLyxDocument(doc: string, plainText?: string): Promise<void> {
    const formats: Record<string, string | Buffer> = {
      [LYX_CLIPBOARD_FORMAT]: Buffer.from(doc, 'utf8'),
    };
    if (plainText !== undefined) formats['text/plain'] = plainText;
    await this.clipboard.write(formats);
  }

  /**
   * Write a .lyx document and VERIFY the x-lyx payload actually landed on
   * the clipboard. Electron's async write can race the subsequent `paste`
   * LFUN; when the x-lyx format is missing, LyX silently falls back to the
   * plain-text flavor and inserts LITERAL markup into the document (a
   * live-verified failure). Retries once; returns false if the payload
   * still cannot be read back — the caller must NOT paste then.
   */
  async writeLyxDocumentVerified(doc: string, plainText?: string): Promise<boolean> {
    for (let attempt = 0; attempt < 2; attempt++) {
      await this.writeLyxDocument(doc, plainText);
      if (attempt > 0) await sleep(150);
      const buf = await this.clipboard.readFormat(LYX_CLIPBOARD_FORMAT);
      if (buf !== null && buf.toString('utf8') === doc) return true;
    }
    return false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}