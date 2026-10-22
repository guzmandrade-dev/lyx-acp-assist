/**
 * Mock LyXServer for tests: a real named-pipe server speaking the LyXServer
 * wire protocol (see src/lyxserver/client.ts and AGENTS.md), backed by a
 * small in-memory document model. Lets the full LFUN choreography (insert-
 * after, rewrite-at, ...) be regression-tested in vitest without a live
 * LyX instance.
 *
 * Fidelity notes (live-verified LyX behaviors modeled here):
 * - Each reply is written to the .out connection, which is then ENDED
 *   (LyX's resetPipe) — exercising the client's auto-reconnect.
 * - Cursor motion collapses an active selection; selections persist
 *   otherwise.
 * - "Command disabled" ERROR replies: paragraph-down at the last
 *   paragraph, copy with no selection, char-forward at the document end.
 * - paragraph-break: at offset 0 an empty paragraph is inserted ABOVE
 *   (cursor stays in it); at the end an empty paragraph BELOW (cursor in
 *   it); mid-paragraph the text splits (cursor in the second half).
 */
import fs from 'node:fs';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const DEBUG = Boolean(process.env.MOCK_DEBUG);
const debug = (s: string) => {
  if (DEBUG) fs.appendFileSync('.tmp-mock.log', s + '\n');
};

export interface MockParagraph {
  layout: string;
  text: string;
}

export interface MockLyxOptions {
  paragraphs?: MockParagraph[];
  filename?: string;
}

interface Cursor {
  p: number;
  offset: number;
}

let instanceCounter = 0;

export class MockLyxServer {
  readonly pipeBase: string;
  /** Last text `copy` placed on the mock clipboard. */
  clipboardText: string;
  /** When set, the next `undo` is rejected as disabled (nothing to undo). */
  nextUndoDisabled = false;

  paragraphs: MockParagraph[];
  private readonly filename: string;
  private cursor: Cursor = { p: 0, offset: 0 };
  private selection: { p: number; start: number; end: number } | null = null;
  /** PowerShell child process hosting the real named-pipe transport. */
  private transport: ChildProcess | null = null;
  /** Writable fd of the transport's control pipe (reply channel). */
  private ctlFd: number | null = null;

  constructor(options: MockLyxOptions = {}) {
    instanceCounter++;
    this.pipeBase = `\\\\.\\pipe\\lyxmock-${process.pid}-${instanceCounter}-${randomUUID().slice(0, 8)}`;
    this.paragraphs = options.paragraphs ?? [{ layout: 'Standard', text: 'Hello mock' }];
    this.filename = options.filename ?? 'C:/mock/doc.lyx';
    this.clipboardText = '';
  }

  /**
   * Start the PowerShell pipe transport. NamedPipeServerStream gives the
   * real Win32 pipe semantics the client (fs streams) needs: the .out pipe
   * is OUTBOUND and .in is INBOUND, exactly like LyX; Node's net.Server
   * creates duplex instances that fs clients half-close instantly.
   */
  async start(): Promise<void> {
    if (this.transport) return;
    const script = fileURLToPath(new URL('./mock-lyx-transport.ps1', import.meta.url));
    const child = spawn(
      'powershell',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, '-PipeBase', this.pipeBase],
      { windowsHide: true },
    );
    this.transport = child;

    const ready = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('mock transport did not start')), 15_000);
      const onLine = (line: string) => {
        if (line === 'READY') {
          clearTimeout(timer);
          resolve();
        }
      };
      this.consumeStdout(child, onLine);
    });
    child.on('exit', () => {
      this.transport = null;
    });
    child.stdin?.on('error', () => undefined);
    await ready;
    // Connect the control channel (replies) and keep one persistent fd,
    // the same pattern the LyxServerClient uses for .in.
    this.ctlFd = fs.openSync(`${this.pipeBase}.ctl`, 'w');
    debug(`transport ready at ${this.pipeBase}`);
  }

  async stop(): Promise<void> {
    const child = this.transport;
    this.transport = null;
    if (this.ctlFd !== null) {
      try {
        fs.writeSync(this.ctlFd, 'BYE\n');
      } catch {
        /* already gone */
      }
      try {
        fs.closeSync(this.ctlFd);
      } catch {
        /* already closed */
      }
      this.ctlFd = null;
    }
    child?.kill();
  }

  private consumeStdout(child: ChildProcess, onLine: (line: string) => void): void {
    let buf = '';
    let seen = 0;
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      buf += chunk;
      let idx: number;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line) continue;
        seen++;
        debug(`PS> ${line}`);
        if (line.startsWith('IN|')) {
          this.handleLine(line.slice(3));
        } else if (line === 'OUTCONNECTED') {
          /* replies are flushed by the transport itself */
        } else if (seen === 1) {
          onLine(line); // READY
        }
      }
    });
  }

  // --- wire protocol ------------------------------------------------------

  private handleLine(line: string): void {
    if (line.startsWith('LYXSRV:') || line === '') return; // hello: no reply
    const m = /^LYXCMD:([^:]+):([^:]+):?(.*)$/.exec(line);
    if (!m) return;
    const [, client, func, arg] = m;
    const reply = this.dispatch(func, arg);
    const text = reply.error
      ? `ERROR:${client}:${func}:${reply.error}`
      : `INFO:${client}:${func}:${reply.data ?? ''}`;
    this.writeCtl(`R|${text}\n`);
  }

  /** Send a control line to the transport (reply or BYE). */
  private writeCtl(line: string): void {
    if (this.ctlFd === null) return;
    try {
      fs.writeSync(this.ctlFd, line);
    } catch (e) {
      debug(`ctl write failed: ${(e as Error).message}`);
    }
  }


  private dispatch(func: string, arg: string): { data?: string; error?: string } {
    const cursor = this.cursor;
    const para = this.paragraphs[cursor.p];
    switch (func) {
      case 'server-get-filename':
        return { data: this.filename };
      case 'server-get-layout':
        return { data: para?.layout ?? 'Standard' };
      case 'server-get-statistics': {
        if (!this.selection) return { data: '0 0 0' };
        const sel = this.paragraphs[this.selection.p].text.slice(this.selection.start, this.selection.end);
        const words = sel.split(/\s+/).filter(Boolean).length;
        return { data: `${words} ${sel.length} ${sel.length + 1}` };
      }
      case 'buffer-begin':
        this.moveCursor(0, 0);
        return { data: '' };
      case 'paragraph-down': {
        if (cursor.p >= this.paragraphs.length - 1) return { error: 'Command disabled' };
        this.moveCursor(cursor.p + 1, 0);
        return { data: '' };
      }
      case 'paragraph-select': {
        if (!para) return { error: 'Command disabled' };
        this.selection = { p: cursor.p, start: 0, end: para.text.length };
        return { data: '' };
      }
      case 'copy': {
        if (!this.selection) return { error: 'Command disabled' };
        this.clipboardText = this.paragraphs[this.selection.p].text.slice(
          this.selection.start,
          this.selection.end,
        );
        return { data: '' };
      }
      case 'paste': {
        if (this.selection) {
          this.paragraphs[this.selection.p].text =
            this.paragraphs[this.selection.p].text.slice(0, this.selection.start) +
            this.clipboardText +
            this.paragraphs[this.selection.p].text.slice(this.selection.end);
          this.moveCursor(this.selection.p, this.selection.start + this.clipboardText.length);
        } else if (para) {
          para.text = para.text.slice(0, cursor.offset) + this.clipboardText + para.text.slice(cursor.offset);
          this.moveCursor(cursor.p, cursor.offset + this.clipboardText.length);
        }
        return { data: '' };
      }
      case 'paragraph-break': {
        if (!para) return { error: 'Command disabled' };
        const { p, offset } = cursor;
        if (offset === 0) {
          // Empty paragraph above; cursor stays in (now points at) it.
          this.paragraphs.splice(p, 0, { layout: para.layout, text: '' });
          this.moveCursor(p, 0);
        } else if (offset >= para.text.length) {
          // Empty paragraph below; cursor moves into it.
          this.paragraphs.splice(p + 1, 0, { layout: para.layout, text: '' });
          this.moveCursor(p + 1, 0);
        } else {
          // Split: cursor moves to the start of the second half.
          const rest = para.text.slice(offset);
          para.text = para.text.slice(0, offset);
          this.paragraphs.splice(p + 1, 0, { layout: para.layout, text: rest });
          this.moveCursor(p + 1, 0);
        }
        return { data: '' };
      }
      case 'char-forward': {
        if (this.selection) {
          this.moveCursor(this.selection.p, this.selection.end);
          return { data: '' };
        }
        if (!para || cursor.offset >= para.text.length) return { error: 'Command disabled' };
        this.moveCursor(cursor.p, cursor.offset + 1);
        return { data: '' };
      }
      case 'char-delete-forward': {
        if (this.selection) {
          // Deleting the selection: remove the text and collapse the cursor.
          const { p, start, end } = this.selection;
          this.paragraphs[p].text =
            this.paragraphs[p].text.slice(0, start) + this.paragraphs[p].text.slice(end);
          this.moveCursor(p, start);
          return { data: '' };
        }
        if (!para) return { error: 'Command disabled' };
        if (cursor.offset < para.text.length) {
          para.text = para.text.slice(0, cursor.offset) + para.text.slice(cursor.offset + 1);
          return { data: '' };
        }
        // At the paragraph end: merge the NEXT paragraph into this one
        // (deleting the paragraph break), like LyX's delete key.
        if (cursor.p < this.paragraphs.length - 1) {
          para.text += this.paragraphs[cursor.p + 1].text;
          this.paragraphs.splice(cursor.p + 1, 1);
          return { data: '' };
        }
        return { error: 'Command disabled' };
      }
      case 'char-delete-backward': {
        if (this.selection) {
          const { p, start, end } = this.selection;
          this.paragraphs[p].text =
            this.paragraphs[p].text.slice(0, start) + this.paragraphs[p].text.slice(end);
          this.moveCursor(p, start);
          return { data: '' };
        }
        if (!para) return { error: 'Command disabled' };
        if (cursor.offset > 0) {
          para.text = para.text.slice(0, cursor.offset - 1) + para.text.slice(cursor.offset);
          this.moveCursor(cursor.p, cursor.offset - 1);
          return { data: '' };
        }
        // At the paragraph start: merge this paragraph into the PREVIOUS
        // one (deleting the paragraph break), like LyX's backspace.
        if (cursor.p > 0) {
          const prev = this.paragraphs[cursor.p - 1];
          const at = prev.text.length;
          prev.text += para.text;
          this.paragraphs.splice(cursor.p, 1);
          this.moveCursor(cursor.p - 1, at);
          return { data: '' };
        }
        return { error: 'Command disabled' };
      }
      case 'char-backward': {
        if (this.selection) {
          this.moveCursor(this.selection.p, this.selection.start);
          return { data: '' };
        }
        if (cursor.offset === 0) return { error: 'Command disabled' };
        this.moveCursor(cursor.p, cursor.offset - 1);
        return { data: '' };
      }
      case 'self-insert': {
        if (this.selection) {
          this.pasteLike(arg);
        } else if (para) {
          para.text = para.text.slice(0, cursor.offset) + arg + para.text.slice(cursor.offset);
          this.moveCursor(cursor.p, cursor.offset + arg.length);
        }
        return { data: '' };
      }
      case 'buffer-write':
      case 'file-open':
        return { data: '' };
      case 'undo': {
        if (this.nextUndoDisabled) {
          this.nextUndoDisabled = false;
          return { error: 'Command disabled' };
        }
        return { data: '' };
      }
      default:
        return { error: 'Unknown action' };
    }
  }

  /** Any cursor motion collapses the selection (LyX behavior). */
  private moveCursor(p: number, offset: number): void {
    this.cursor = { p, offset };
    this.selection = null;
  }

  private pasteLike(arg: string): void {
    if (!this.selection) return;
    const { p, start, end } = this.selection;
    this.paragraphs[p].text =
      this.paragraphs[p].text.slice(0, start) + arg + this.paragraphs[p].text.slice(end);
    this.moveCursor(p, start + arg.length);
  }
}

function listen(path: string, onConnection: (socket: net.Socket) => void): Promise<net.Server> {
  return new Promise((resolve, reject) => {
    const server = net.createServer(onConnection);
    server.once('error', reject);
    server.listen(path, () => resolve(server));
  });
}

function close(server: net.Server | null): Promise<void> {
  return new Promise((resolve) => {
    if (!server) return resolve();
    server.close(() => resolve());
  });
}
