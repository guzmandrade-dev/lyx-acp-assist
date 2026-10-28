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
 *
 * Write-only fallback mode: on Windows builds whose zero-length overlapped
 * WriteFile changed semantics (Oct 2026 updates), LyX resets every fresh
 * .out connection at connect (upstream LyX bug; see AGENTS.md "Live-test
 * debugging trail"). Replies can NEVER arrive, but commands via .in still
 * dispatch. When start() detects that signature, the client degrades to
 * fire-and-forget commands and substitutes the read paths:
 *   - getFilename: LyX window title + document candidates + session file
 *   - getSelectionStats/copySelection: clear clipboard, `copy`, inspect
 *   - getLayout: unknown (empty)
 * Command success can no longer be confirmed (no ERROR replies); callers
 * verify effects instead (disk re-read, clipboard comparison).
 */

import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { TIMINGS } from '../timings.js';
import {
  discoverLyxEnvironment,
  parseSessionFilePaths,
  parseWindowTitle,
  readLyxWindowTitle,
} from './pipe-config.js';
import { LYX_CLIPBOARD_FORMAT, type RawClipboard } from '../clipboard/lyx-clipboard.js';

export interface LyxServerOptions {
  /** Configured pipe base name, e.g. `\\\\.\\pipe\\lyxpipe` or `~/.lyxpipe`. */
  pipeBase?: string;
  /** LyX user directory override (normally discovered; used by tests). */
  userDir?: string;
  timeoutMs?: number;
  /**
   * How long start() waits for the hello echo on a fresh .out connection
   * before assuming the pipe is healthy-but-silent (LyX busy). A
   * connection closed with zero bytes within this window (twice in a row)
   * is the deaf-pipe signature.
   */
  deafProbeMs?: number;
  /** Grace period per fire-and-forget command in write-only mode. */
  writeOnlyGraceMs?: number;
  /** Substitutes for the reply-dependent reads in write-only mode. */
  fallbacks?: LyxWriteOnlyFallbacks;
}

/** Read-path substitutes used while the pipe is deaf (see module comment). */
export interface LyxWriteOnlyFallbacks {
  /** Empty the clipboard (all formats). */
  clearClipboard(): Promise<void>;
  /** Plain-text clipboard flavor (the selection text after `copy`). */
  readClipboardText(): Promise<string>;
  /** Does the clipboard hold the application/x-lyx format right now? */
  hasClipboardLyxPayload(): Promise<boolean>;
  /** Main-window title of the running LyX process, or null. */
  readLyxWindowTitle(): Promise<string | null>;
  /** Known document paths to resolve window titles against. */
  documentCandidates(): Iterable<string>;
}

/**
 * Standard fallbacks built from the app's native clipboard adapter: the
 * clipboard pieces wrap RawClipboard, the title comes from the LyX
 * process, and candidates come from the caller (the server passes its
 * per-session known-documents set).
 */
export function createWriteOnlyFallbacks(
  clipboard: RawClipboard,
  documentCandidates: () => Iterable<string>,
): LyxWriteOnlyFallbacks {
  return {
    clearClipboard: () => clipboard.clear(),
    readClipboardText: () => clipboard.readText(),
    hasClipboardLyxPayload: () => clipboard.hasFormat(LYX_CLIPBOARD_FORMAT),
    readLyxWindowTitle,
    documentCandidates,
  };
}

/** Client mode: full pipe protocol, or deaf-pipe fire-and-forget. */
export type LyxClientMode = 'pipe' | 'write-only';

export class LyxPipeError extends Error {}

interface Waiter {
  func: string;
  resolve: (line: string | undefined) => void;
}

export class LyxServerClient extends EventEmitter {
  readonly pipeBase: string;
  readonly clientName: string;
  /** LyX user directory (preferences/session), when discovered. */
  readonly userDir: string | null;
  /** Active mode; decided by start() (pipe until then). */
  mode: LyxClientMode = 'pipe';

  private readonly timeoutMs: number;
  private readonly deafProbeMs: number;
  private readonly writeOnlyGraceMs: number;
  private readonly fallbacks: LyxWriteOnlyFallbacks | null;

  private inPath: string;
  private outPath: string;

  private shuttingDown = false;
  private waiters = new Set<Waiter>();
  /** Per-func request serialization (see request()). */
  private requestQueue = new Map<string, Promise<unknown>>();

  private inFd: number | null = null;
  private helloPending = false;

  constructor(options: LyxServerOptions = {}) {
    super();
    const env = discoverLyxEnvironment();
    // Resolution order: explicit option > LYX_PIPE env > LyX preferences
    // (discovered; see pipe-config.ts) > platform default.
    this.pipeBase = options.pipeBase ?? process.env.LYX_PIPE ?? env.pipeBase;
    this.userDir = options.userDir ?? env.userDir;
    this.clientName = `lyx-acp-${process.pid}`;
    this.timeoutMs = options.timeoutMs ?? TIMINGS.pipeTimeoutMs;
    this.deafProbeMs = options.deafProbeMs ?? TIMINGS.deafProbeMs;
    this.writeOnlyGraceMs = options.writeOnlyGraceMs ?? TIMINGS.writeOnlyGraceMs;
    this.fallbacks = options.fallbacks ?? null;
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
   * Start reading replies and register with LyX. Throws if the pipe is not
   * available. Detects the deaf-pipe condition (see module comment) and
   * degrades to write-only mode instead of failing every request.
   */
  async start(): Promise<void> {
    if (!this.isAvailable()) {
      throw new LyxPipeError(
        `LyXServer pipe not found at ${this.inPath}. Is LyX running with a ` +
          'document open, and is Preferences -> Paths -> LyXServer pipe configured?',
      );
    }
    this.shuttingDown = false;
    const probe = await this.probeOut();
    if (probe.deaf) {
      // Deaf pipe: hello still went out via .in (commands dispatch; LyX
      // registers clients from the .in hello alone), but no echo can ever
      // arrive. Assume registered so stop() sends the freeing "bye"
      // (LyX's client list caps at 10, leaked slots are permanent).
      this.mode = 'write-only';
      this.helloPending = false;
      this.emit('write-only');
      return;
    }
    this.mode = 'pipe';
    // A healthy probe connection is handed over as the initial readLoop
    // stream (never destroyed mid-flight: a dying connection can swallow
    // one reply — the server-side write succeeds into the buffer of a
    // client that is about to close). It is null when data arrived but
    // the connection was already reset (reply-then-close).
    this.readLoop(probe.stream ?? undefined);
  }

  /**
   * Probe .out health while handshaking: open a fresh .out connection,
   * send hello via .in, and watch it.
   *   - any data (the hello echo)          -> healthy
   *   - closed with zero bytes, TWICE      -> deaf pipe (reset-at-connect)
   *   - silent but alive after deafProbeMs -> healthy (LyX busy; requests
   *     then fail with their own timeouts, exactly like before)
   * Returns `deaf: true` for the deaf pipe; otherwise the live probe
   * connection (or null when data arrived but the connection was already
   * reset — the caller then starts a fresh readLoop).
   */
  private async probeOut(): Promise<{ deaf: boolean; stream: fs.ReadStream | null }> {
    let helloSent = false;
    type Verdict = 'data' | 'empty-close' | 'timeout';
    const attempt = (): Promise<{ verdict: Verdict; stream: fs.ReadStream | null }> =>
      new Promise((resolve) => {
        let stream: fs.ReadStream;
        try {
          stream = fs.createReadStream(this.outPath, { encoding: 'utf8' });
        } catch {
          resolve({ verdict: 'empty-close', stream: null });
          return;
        }
        let bytes = 0;
        let settled = false;
        let buf = '';
        let timer: NodeJS.Timeout | undefined;
        const done = (verdict: Verdict) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          if (verdict === 'empty-close') {
            // The server reset this connection itself; nothing to deliver.
            stream.destroy();
            resolve({ verdict, stream: null });
          } else {
            resolve({ verdict, stream });
          }
        };
        stream.on('open', () => {
          if (helloSent) return;
          helloSent = true;
          try {
            this.send(`LYXSRV:${this.clientName}:hello\n`);
            this.helloPending = true;
          } catch {
            /* .in broken: requests will fail with their own errors */
          }
        });
        stream.on('data', (chunk: string) => {
          bytes += chunk.length;
          buf += chunk;
          let idx: number;
          while ((idx = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, idx).trim();
            buf = buf.slice(idx + 1);
            if (line) this.dispatch(line);
          }
          done('data');
        });
        // The deaf pipe closes the connection instantly; a reply-then-close
        // (LyX's resetPipe) still delivered data first, so bytes decides.
        const onClosed = () => {
          if (settled) return;
          if (bytes > 0) {
            // Data was dispatched before the close (reply-then-reset): the
            // connection is dead, so hand over nothing — start() opens a
            // fresh readLoop stream.
            settled = true;
            clearTimeout(timer);
            stream.destroy();
            resolve({ verdict: 'data', stream: null });
          } else {
            done('empty-close');
          }
        };
        stream.on('error', onClosed);
        stream.on('end', onClosed);
        stream.on('close', onClosed);
        timer = setTimeout(() => done('timeout'), this.deafProbeMs);
      });

    const first = await attempt();
    if (first.verdict !== 'empty-close') return { deaf: false, stream: first.stream };
    const second = await attempt();
    return second.verdict === 'empty-close'
      ? { deaf: true, stream: null }
      : { deaf: false, stream: second.stream };
  }

  stop(): void {
    this.shuttingDown = true;
    // Deregister from LyX's client list (LyX registers every "hello" and
    // only frees the slot on an explicit "bye"; the list caps at 10
    // clients, after which LyX silently ignores further handshakes for
    // the lifetime of the LyX process). Best-effort: a failing write
    // (LyX gone) must not block teardown.
    if (this.inFd !== null && !this.helloPending) {
      try {
        this.send(`LYXSRV:${this.clientName}:bye\n`);
      } catch {
        /* pipe gone — nothing to deregister from */
      }
    }
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
    if (this.mode === 'write-only') {
      this.send(`LYXCMD:${this.clientName}:${func}:${arg}\n`);
      await sleep(this.graceFor(func));
      // Synthetic empty success: replies can never arrive on a deaf pipe.
      // Callers that need data (filename, layout, statistics) use the
      // overridden wrappers below instead.
      return `INFO:${this.clientName}:${func}:`;
    }
    // Replies match by client:func ONLY (the wire protocol has
    // no request id), so two overlapping same-func requests would
    // cross-resolve — one reply would release the wrong waiter and the
    // other would time out. Serialize per func; different funcs still
    // overlap freely (their wait keys differ).
    const tail = this.requestQueue.get(func) ?? Promise.resolve();
    const run = tail.then(() => this.roundTrip(func, arg, timeoutMs));
    this.requestQueue.set(func, run.catch(() => undefined));
    return run;
  }

  private async roundTrip(func: string, arg: string, timeoutMs?: number): Promise<string> {
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

  /**
   * Read replies from .out, reconnecting after LyX's post-reply resets.
   * `existing` is a probe connection whose data handler is already wired
   * (probeOut dispatches its lines); only the reopen handlers are added.
   */
  private readLoop(existing?: fs.ReadStream): void {
    if (this.shuttingDown) return;
    let stream: fs.ReadStream;
    if (existing) {
      stream = existing;
    } else {
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
    }

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
    // Unmatched lines are deliberately dropped: stale/duplicated broadcasts
    // must never be mistaken for fresh replies (see AGENTS.md), and the
    // 'message' event above already surfaced the line to any listener.
  }

  private send(line: string): void {
    if (this.inFd === null) this.inFd = fs.openSync(this.inPath, 'w');
    fs.writeSync(this.inFd, line);
    this.emit('sent', line.trim());
  }

  // --- Write-only fallback internals --------------------------------------

  private requireFallbacks(): LyxWriteOnlyFallbacks {
    if (!this.fallbacks) {
      throw new LyxPipeError('write-only fallbacks are not configured for this client');
    }
    return this.fallbacks;
  }

  /** Grace before a blind command counts as done (file ops need more). */
  private graceFor(func: string): number {
    const slow = func === 'buffer-write' || func === 'file-open' || func === 'paste';
    return slow ? this.writeOnlyGraceMs * 4 : this.writeOnlyGraceMs;
  }

  /**
   * Write-only substitute for selection queries: clear the clipboard, send
   * `copy`, wait, then inspect what landed. Without the clear, a rejected
   * copy (no selection) would leave a stale payload indistinguishable from
   * a fresh selection. Always probes fresh — a cached result would defeat
   * the paragraph-verification copies in the paste flows.
   */
  private async probeSelection(): Promise<{
    hasSelection: boolean;
    stats: [number, number, number];
  }> {
    const f = this.requireFallbacks();
    await f.clearClipboard();
    this.send(`LYXCMD:${this.clientName}:copy:\n`);
    await sleep(this.graceFor('copy'));
    const text = (await f.readClipboardText()).trim();
    const hasLyx = await f.hasClipboardLyxPayload();
    const hasSelection = text.length > 0 || hasLyx;
    const stats: [number, number, number] = hasSelection
      ? [
          text.split(/\s+/).filter(Boolean).length,
          text.replace(/\s/g, '').length,
          text.length,
        ]
      : [0, 0, 0];
    return { hasSelection, stats };
  }

  /**
   * Write-only substitute for `server-get-filename`: the LyX window title
   * names the active document, often with a directory hint
   * ("doc.lyx (~\Documents) - LyX"). Resolve it via the hint, then against
   * known documents (app history + LyX's session file). Returns '' when
   * unresolvable — callers treat that like LyX's empty reply for an
   * unsaved buffer.
   */
  private async resolveFilenameFallback(): Promise<string> {
    const f = this.requireFallbacks();
    const title = await f.readLyxWindowTitle();
    const parsed = title ? parseWindowTitle(title) : null;
    if (!parsed || !parsed.fileName) return '';
    const home = process.env.USERPROFILE ?? process.env.HOME ?? '';

    // 1. Directory hint from the title ("~\Documents" -> <home>\Documents).
    const hint = parsed.dirHint;
    if (hint && !hint.includes('...')) {
      const base = hint.startsWith('~') ? home : '';
      const dir = hint.replace(/^~/, '');
      const resolved = this.existingPath(path.join(base, dir, parsed.fileName));
      if (resolved) return resolved;
    }

    // 2. Match the file name against known documents, then LyX's session.
    const candidates = [...f.documentCandidates(), ...(await this.sessionFilePaths())];
    for (const candidate of candidates) {
      if (path.basename(candidate).toLowerCase() === parsed.fileName.toLowerCase()) {
        const resolved = this.existingPath(candidate);
        if (resolved) return resolved;
      }
    }
    return '';
  }

  /** Verify existence; normalize to LyX's forward-slash reply format. */
  private existingPath(candidate: string): string | null {
    try {
      if (!fs.existsSync(candidate)) return null;
      return process.platform === 'win32' ? candidate.replace(/\\/g, '/') : candidate;
    } catch {
      return null;
    }
  }

  /** Document paths from LyX's session file (see pipe-config.ts). */
  private async sessionFilePaths(): Promise<string[]> {
    if (!this.userDir) return [];
    try {
      return parseSessionFilePaths(
        await fs.promises.readFile(path.join(this.userDir, 'session'), 'utf8'),
      );
    } catch {
      return [];
    }
  }

  // --- Convenience wrappers ----------------------------------------------

  /** Absolute path of the document in the active LyX view. */
  async getFilename(): Promise<string> {
    if (this.mode === 'write-only') return this.resolveFilenameFallback();
    const reply = await this.request('server-get-filename');
    return replyData(reply);
  }

  /** Layout of the paragraph at the cursor (e.g. "Standard"). */
  async getLayout(): Promise<string> {
    if (this.mode === 'write-only') return ''; // cursor position is unknown without replies
    return replyData(await this.request('server-get-layout'));
  }

  /** "words chars chars-with-spaces" of the current selection; "0 0 0" if none. */
  async getSelectionStats(): Promise<[number, number, number]> {
    if (this.mode === 'write-only') return (await this.probeSelection()).stats;
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
    if (this.mode === 'write-only') return (await this.probeSelection()).hasSelection;
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

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}