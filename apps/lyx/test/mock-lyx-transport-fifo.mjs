#!/usr/bin/env node
// Mock LyXServer transport for Linux/macOS: real FIFOs with LyX's
// semantics. Counterpart of mock-lyx-transport.ps1 (Windows named pipes)
// with the same stdout protocol (READY, then IN|<command line> per
// request) and the same control channel: <base>.ctl carries "R|<reply>"
// and "BYE" lines written by the Node harness.
//
// LyX fidelity details (mirroring the Windows transport):
// - Each reply is written to .out and the write end is CLOSED right
//   after, like LyX's resetPipe: the client's read loop sees EOF and
//   reconnects, the same choreography it runs against live LyX.
// - A persistent write end is pre-opened at startup (completes when the
//   client's first reader connects) so the hello probe never hangs on a
//   pipe with no writer.
// - Deaf mode (--deaf): every .out write-end open is closed instantly
//   with zero bytes, reproducing LyX's reset-at-connect bug signature;
//   commands via .in still dispatch.

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';

const argv = process.argv.slice(2);
const baseIndex = argv.indexOf('--base');
if (baseIndex < 0 || !argv[baseIndex + 1]) {
  console.error('usage: node mock-lyx-transport-fifo.mjs --base <path> [--deaf]');
  process.exit(2);
}
const base = argv[baseIndex + 1];
const deaf = argv.includes('--deaf');
const inPath = `${base}.in`;
const outPath = `${base}.out`;
const ctlPath = `${base}.ctl`;

// FIFOs vanish with the process on Windows; unlink them here.
process.on('exit', () => {
  for (const p of [inPath, outPath, ctlPath]) {
    try {
      fs.rmSync(p, { force: true });
    } catch {
      /* already gone */
    }
  }
});
process.on('SIGTERM', () => process.exit(0));

await new Promise((resolve, reject) => {
  execFile('mkfifo', ['-m', '600', inPath, outPath, ctlPath], (err) => (err ? reject(err) : resolve()));
});

// --- .in: commands from the client -----------------------------------------

let inBuf = '';
fs.createReadStream(inPath, { encoding: 'utf8' }).on('data', (chunk) => {
  inBuf += chunk;
  let idx;
  while ((idx = inBuf.indexOf('\n')) >= 0) {
    const line = inBuf.slice(0, idx);
    inBuf = inBuf.slice(idx + 1);
    if (line) console.log(`IN|${line}`);
  }
});

// --- .out: replies to the client -------------------------------------------

// Pre-opened write end, resolved lazily by the client's first reader.
// Healthy mode only: in deaf mode an open write end would keep the
// client's reader alive and hide the reset-at-connect signature.
let preOpened = deaf ? null : fsp.open(outPath, 'w').catch(() => null);
const pending = [];
let flushing = false;

function writeReply(line) {
  if (deaf) return; // replies can never be delivered; do not queue
  pending.push(line);
  if (!flushing) flush();
}

async function flush() {
  flushing = true;
  while (pending.length > 0) {
    const line = pending.shift();
    try {
      // The open completes as soon as the client (re)connects its reader
      // (it reconnects ~50ms after each EOF). Replies that arrive in
      // between queue up here — same as the Windows transport.
      const fd = (await preOpened) ?? (await fsp.open(outPath, 'w'));
      preOpened = null;
      await fd.write(`${line}\n`);
      await fd.close(); // reply-then-close: LyX's resetPipe
    } catch (e) {
      console.log(`WRITE-ERROR|${e.message}`);
    }
  }
  flushing = false;
}

if (deaf) {
  // Reset at connect, zero bytes: the deaf-pipe signature.
  void (async () => {
    for (;;) {
      try {
        const fd = await fsp.open(outPath, 'w');
        await fd.close();
      } catch {
        return;
      }
    }
  })();
}

// --- .ctl: control channel from the harness ---------------------------------

let ctlBuf = '';
fs.createReadStream(ctlPath, { encoding: 'utf8' }).on('data', (chunk) => {
  ctlBuf += chunk;
  let idx;
  while ((idx = ctlBuf.indexOf('\n')) >= 0) {
    const line = ctlBuf.slice(0, idx);
    ctlBuf = ctlBuf.slice(idx + 1);
    if (line === 'BYE') process.exit(0);
    if (line.startsWith('R|')) writeReply(line.slice(2));
  }
});

console.log('READY');