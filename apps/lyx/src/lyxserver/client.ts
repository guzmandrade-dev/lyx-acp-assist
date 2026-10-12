/**
 * Client for the LyXServer named pipe (Windows) or FIFO (Unix).
 *
 * Protocol (see AGENTS.md for the full findings):
 *   - handshake: "LYXSRV:<client>:hello"
 *   - request:   "LYXCMD:<client>:<func>:<arg>"  -> "INFO:<client>:<func>:<data>"
 *                                             or  "ERROR:<client>:<func>:<msg>"
 * Windows quirks handled here:
 *   - LyX disconnects each output client after every reply -> auto-reconnect.
 *   - Replies can arrive on a later connection or be duplicated -> we use a
 *     unique client name per process and match replies by client:func.
 *
 * The .in connection is persistent; the .out connection auto-reconnects.
 */

import fs from 'node:fs';
import { EventEmitter } from 'node:events';

const WINDOWS_PIPE_PREFIX = '\\\\.\\pipe\\';

export interface LyxServerOptions {
  /** Configured pipe base name, e.g. `\\\\.\\pipe\\lyxpipe` or `~/.lyxpipe`. */
  pipeBase?: string;
  timeoutMs?: number;
}

export class LyxPipeError extends Error {}

interface Waiter {
  func: string;
  resolve: (line: string | undefined) => void;
}

export class LyxServerClient extends EventEmitter {
  readonly pipeBase: string;
  readonly clientName: string;
  private readonly timeoutMs: number;

  private inPath: string;
  private outPath: string;

  private shuttingDown = false;
  private waiters = new Set<Waiter>();
  private unconsumed: string[] = [];

  private inFd: number | null = null;
  private helloPending = false;

  constructor(options: LyxServerOptions = {}) {
    super();
    this.pipeBase = options.pipeBase ?? defaultPipeBase();
    this.clientName = `lyx-acp-${process.pid}`;
    this.timeoutMs = options.timeoutMs ?? 8000;
    this.inPath = `${this.pipeBase}.in`;
    this.outPath = `${this.pipeBase}.out`;
  }

  /** True if the pipe appears to exist right now (LyX running, server enabled). */
  isAvailable(): boolean {
    try {
      fs.accessSync(this.outPath);
      fs.accessSync(this.inPath);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Start reading replies and register with LyX.
   * Throws if the pipe is not available.
   */
  async start(): Promise<void> {
    if (!this.isAvailable()) {
      throw new LyxPipeError(
        `LyXServer pipe not found at ${this.inPath}. Is LyX running with a ` +
          'document open, and is Preferences -> Paths -> LyXServer pipe configured?',
      );
    }
    this.shuttingDown = false;
    this.readLoop();
    // Give the first .out connection time to come up, then say hello.
    await sleep(100);
    this.send(`LYXSRV:${this.clientName}:hello\n`);
    this.helloPending = true;
  }

  stop(): void {
    this.shuttingDown = true;
    if (this.inFd !== null) {
      try {
        fs.closeSync(this.inFd);
      } catch {
        /* already closed */
      }
      this.inFd = null;
    }
    for (const w of this.waiters) w.resolve(undefined);
    this.waiters.clear();
  }

  /** Send an LFUN and wait for its INFO/ERROR reply. Returns the reply line. */
  async request(func: string, arg = '', timeoutMs?: number): Promise<string> {
    const timeout = timeoutMs ?? this.timeoutMs;
    // Note: do NOT consume previously-unmatched replies here. The Windows
    // pipe broadcasts duplicates, and stale duplicates of earlier requests
    // would be mistaken for fresh replies. Waiters are registered before
    // the request is sent, so genuine replies always reach the waiter.

    const promise = new Promise<string | undefined>((resolve) => {
      const waiter: Waiter = { func, resolve };
      this.waiters.add(waiter);
      setTimeout(() => {
        this.waiters.delete(waiter);
        resolve(undefined);
      }, timeout);
    });

    this.send(`LYXCMD:${this.clientName}:${func}:${arg}\n`);
    const reply = await promise;
    if (reply === undefined) {
      throw new LyxPipeError(
        `No reply from LyX for "${func}" within ${timeout}ms (LyX busy or modal open?).`,
      );
    }
    if (reply.startsWith('ERROR:')) {
      throw new LyxPipeError(`LyX rejected "${func}": ${replyData(reply)}`);
    }
    return reply;
  }

  /** Like request(), but resolves errors/timeouts to null. */
  async tryRequest(func: string, arg = '', timeoutMs?: number): Promise<string | null> {
    try {
      const reply = await this.request(func, arg, timeoutMs);
      return replyData(reply);
    } catch {
      return null;
    }
  }

  // --- Reply stream ------------------------------------------------------

  private readLoop(): void {
    if (this.shuttingDown) return;
    let stream: fs.ReadStream;
    try {
      stream = fs.createReadStream(this.outPath, { encoding: 'utf8' });
    } catch {
      setTimeout(() => this.readLoop(), 250);
      return;
    }

    let buf = '';
    stream.on('data', (chunk: string) => {
      buf += chunk;
      let idx: number;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (line) this.dispatch(line);
      }
    });

    let reopened = false;
    const reopen = () => {
      if (reopened) return; // only one retry per stream
      reopened = true;
      stream.destroy();
      if (!this.shuttingDown) setTimeout(() => this.readLoop(), 50);
    };
    // Post-reply disconnects (normal on Windows) surface as error/end/close.
    stream.on('error', () => reopen());
    stream.on('end', () => reopen());
    stream.on('close', () => reopen());
  }

  private dispatch(line: string): void {
    this.emit('message', line);
    if (this.helloPending && line === `LYXSRV:${this.clientName}:hello`) {
      this.helloPending = false;
      this.emit('hello');
      return;
    }
    const m = /^(?:INFO|ERROR):([^:]+):([^:]*):?/.exec(line);
    if (m && m[1] === this.clientName) {
      for (const w of this.waiters) {
        if (w.func === m[2]) {
          this.waiters.delete(w);
          w.resolve(line);
          return;
        }
      }
    }
    this.unconsumed.push(line);
  }

  private send(line: string): void {
    if (this.inFd === null) this.inFd = fs.openSync(this.inPath, 'w');
    fs.writeSync(this.inFd, line);
    this.emit('sent', line.trim());
  }

  // --- Convenience wrappers ----------------------------------------------

  /** Absolute path of the document in the active LyX view. */
  async getFilename(): Promise<string> {
    const reply = await this.request('server-get-filename');
    return replyData(reply);
  }

  /** Layout of the paragraph at the cursor (e.g. "Standard"). */
  async getLayout(): Promise<string> {
    return replyData(await this.request('server-get-layout'));
  }

  /** "words chars chars-with-spaces" of the current selection; "0 0 0" if none. */
  async getSelectionStats(): Promise<[number, number, number]> {
    const raw = replyData(await this.request('server-get-statistics'));
    const parts = raw.split(' ').map((n) => Number.parseInt(n, 10));
    if (parts.length !== 3 || parts.some((n) => Number.isNaN(n))) {
      throw new LyxPipeError(`Unexpected statistics reply: ${raw}`);
    }
    return parts as [number, number, number];
  }

  async hasSelection(): Promise<boolean> {
    const [words] = await this.getSelectionStats();
    return words > 0;
  }

  /** Save the current buffer. Only safe for already-saved files (no dialogs). */
  async save(): Promise<void> {
    try {
      await this.request('buffer-write');
    } catch (e) {
      // "Command disabled" means there is nothing to save: not an error.
      if (e instanceof LyxPipeError && e.message.includes('Command disabled')) return;
      throw e;
    }
  }

  /**
   * Copy the current selection to the clipboard (keeps the selection active).
   * Returns false when LyX rejected the copy ("Command disabled"), i.e. there
   * is no usable selection — the caller must then treat it as no selection,
   * since the clipboard may still hold a previous copy.
   */
  async copySelection(): Promise<boolean> {
    try {
      await this.request('copy');
      return true;
    } catch (e) {
      if (e instanceof LyxPipeError && e.message.includes('Command disabled')) return false;
      throw e;
    }
  }

  /** Paste the clipboard at the cursor, replacing the active selection. */
  async paste(): Promise<void> {
    await this.request('paste');
  }

  /** Type plain text at the cursor, replacing the active selection. */
  async insertText(text: string): Promise<void> {
    await this.request('self-insert', text);
  }

  /** Move the cursor to the very beginning of the document. */
  async beginOfDocument(): Promise<boolean> {
    return (await this.tryRequest('buffer-begin')) !== null;
  }

  /**
   * Split the paragraph at the cursor. At buffer-begin this leaves an empty
   * paragraph above the former first paragraph, so a paste merges into it
   * instead of into the existing text (which would discard the pasted layout).
   */
  async breakParagraph(): Promise<boolean> {
    try {
      await this.request('paragraph-break');
      return true;
    } catch (e) {
      if (e instanceof LyxPipeError && e.message.includes('Command disabled')) return false;
      throw e;
    }
  }

  /** Move the cursor to the beginning of the next paragraph. */
  async paragraphDown(): Promise<boolean> {
    try {
      await this.request('paragraph-down');
      return true;
    } catch (e) {
      if (e instanceof LyxPipeError && e.message.includes('Command disabled')) return false;
      throw e;
    }
  }

  /** Select the entire paragraph the cursor is in. */
  async paragraphSelect(): Promise<boolean> {
    return (await this.tryRequest('paragraph-select')) !== null;
  }

  /** Collapse an active selection, moving the cursor to its end. */
  async collapseSelectionForward(): Promise<boolean> {
    return (await this.tryRequest('char-forward')) !== null;
  }

  /** Collapse an active selection around the current cursor position. */
  async collapseSelection(): Promise<void> {
    await this.tryRequest('char-forward');
    await this.tryRequest('char-backward');
  }

  /**
   * Delete the active selection (LyX's delete LFUNs remove the selection
   * first). Tolerates "Command disabled" as a no-op.
   */
  async deleteSelection(): Promise<boolean> {
    try {
      await this.request('char-delete-forward', 'confirm');
      return true;
    } catch (e) {
      if (e instanceof LyxPipeError && e.message.includes('Command disabled')) return false;
      throw e;
    }
  }

  /**
   * Merge an EMPTY paragraph at the cursor away: backspace merges it into
   * the previous paragraph; if it is the first paragraph, delete merges it
   * with the next. Either way the paragraph break disappears (LyX's
   * backspace/delete at a paragraph boundary).
   */
  async mergeAwayParagraph(): Promise<void> {
    // tryRequest resolves successful replies with empty data to '' (falsy),
    // so compare against null, like all other tryRequest wrappers.
    if ((await this.tryRequest('char-delete-backward')) !== null) return;
    await this.tryRequest('char-delete-forward');
  }

  /**
   * Merge the paragraph AFTER the cursor into it: with the cursor at the
   * END of a paragraph, `char-delete-forward` deletes the paragraph break
   * (LyX's delete key), appending the next paragraph's text into this one.
   */
  async mergeWithNextParagraph(): Promise<boolean> {
    return (await this.tryRequest('char-delete-forward')) !== null;
  }

  /**
   * Collapse any active selection (moving the cursor collapses it).
   * Selections persist across pipe commands, so failures must clean up.
   */
  async clearSelection(): Promise<void> {
    await this.tryRequest('buffer-begin');
  }

  async undo(): Promise<void> {
    try {
      await this.request('undo');
    } catch (e) {
      // "Command disabled" means there is nothing to undo: not an error.
      if (e instanceof LyxPipeError && e.message.includes('Command disabled')) return;
      throw e;
    }
  }
}

/** Extract <data> from "INFO:<client>:<func>:<data>" / ERROR replies. */
function replyData(reply: string): string {
  const first = reply.indexOf(':');
  const second = reply.indexOf(':', first + 1);
  const third = reply.indexOf(':', second + 1);
  return third >= 0 ? reply.slice(third + 1) : '';
}

function defaultPipeBase(): string {
  if (process.env.LYX_PIPE) return process.env.LYX_PIPE;
  if (process.platform === 'win32') return `${WINDOWS_PIPE_PREFIX}lyxpipe`;
  const home = process.env.HOME ?? process.env.USERPROFILE ?? '~';
  return `${home}/.lyxpipe`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}