#!/usr/bin/env node
/**
 * Spike 1: talk to the LyXServer named pipe from Node.
 *
 * Findings (verified against LyX src/Server.cpp + empirical testing):
 *
 * 1. On Windows the \serverpipe preference must use FORWARD SLASHES:
 *      \serverpipe "//./pipe/lyxpipe"
 *    Backslashes cannot round-trip: LyX's config lexer consumes them as
 *    escapes when reading preferences, silently corrupting the value.
 *
 * 2. Pipes: \\.\pipe\lyxpipe.in (client -> LyX) and
 *            \\.\pipe\lyxpipe.out (LyX -> client)
 *
 * 3. Protocol: "LYXSRV:<client>:hello\n" handshake;
 *      "LYXCMD:<client>:<func>:<arg>\n"  -> request
 *      "INFO:<client>:<func>:<data>\n"   -> success reply
 *      "ERROR:<client>:<func>:<msg>\n"  -> error reply
 *
 * 4. Quirks the client must tolerate:
 *    - LyX disconnects each .out client after each reply it writes
 *      (resetPipe on successful write) -> auto-reconnect after EOF/EPIPE.
 *    - Replies are broadcast into per-instance buffers, so a reply can
 *      arrive on a LATER connection than the request that made it.
 *      => collect all lines, match them to pending requests by
 *      client:func prefix; use a unique client name per session so
 *      stale messages from previous sessions can't match.
 *    - The .in connection persists across multiple requests.
 */

import fs from 'node:fs';
import { once } from 'node:events';

const PIPE_BASE = process.env.LYX_PIPE ?? '\\\\.\\pipe\\lyxpipe';
const IN_PATH = `${PIPE_BASE}.in`;
const OUT_PATH = `${PIPE_BASE}.out`;
const CLIENT = `spike-${process.pid}`;

console.log(`pipe in : ${IN_PATH}`);
console.log(`pipe out: ${OUT_PATH}  (client: ${CLIENT})`);

if (!fs.existsSync(OUT_PATH) || !fs.existsSync(IN_PATH)) {
  console.error('Pipe not found. Is LyX running with a document open, and is');
  console.error('Preferences -> Paths -> LyXServer pipe set to //./pipe/lyxpipe?');
  process.exit(1);
}

// --- Persistent auto-reconnecting reply reader ---------------------------
const waiters = new Set(); // { client, func, resolve }
const unconsumed = [];

function readLoop() {
  const stream = fs.createReadStream(OUT_PATH, { encoding: 'utf8' });
  let buf = '';
  stream.on('data', (chunk) => {
    buf += chunk;
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (line) dispatch(line);
    }
  });
  const reopen = () => {
    if (shuttingDown) return;
    setTimeout(readLoop, 50);
  };
  stream.on('error', () => reopen());
  stream.on('end', () => reopen());
}

function dispatch(line) {
  console.log(`< ${line}`);
  const m = line.match(/^(INFO|ERROR):([^:]+):([^:]*):?/);
  if (m) {
    for (const w of waiters) {
      if (w.client === m[2] && w.func === m[3]) {
        waiters.delete(w);
        w.resolve(line);
        return;
      }
    }
  }
  unconsumed.push(line);
}

let shuttingDown = false;
readLoop();
await new Promise((r) => setTimeout(r, 100)); // let first connection come up

// --- Request sender ------------------------------------------------------
let inFd = null;
function send(line) {
  if (inFd === null) inFd = fs.openSync(IN_PATH, 'w');
  fs.writeSync(inFd, line);
  console.log(`> ${line.trim()}`);
}

function request(func, arg = '', timeoutMs = 8000) {
  return new Promise((resolve) => {
    const w = {
      client: CLIENT,
      func,
      resolve: (line) => { clearTimeout(timer); resolve(line); },
    };
    // First check unconsumed replies that arrived earlier.
    const found = unconsumed.findIndex((l) =>
      l.startsWith(`INFO:${CLIENT}:${func}:`)
      || l.startsWith(`ERROR:${CLIENT}:${func}:`));
    if (found >= 0) {
      resolve(unconsumed.splice(found, 1)[0]);
      return;
    }
    waiters.add(w);
    const timer = setTimeout(() => {
      waiters.delete(w);
      resolve(`(timeout waiting for ${func})`);
    }, timeoutMs);
    send(`LYXCMD:${CLIENT}:${func}:${arg}\n`);
  });
}

// Handshake (register our client name)
send(`LYXSRV:${CLIENT}:hello\n`);

// Optional: run LFUNs given on the command line instead of the demo flow.
//   node spike1-pipe.mjs undo server-get-filename "self-insert:hello world"
const cliArgs = process.argv.slice(2).map((a) => {
  const [func, ...rest] = a.split(':');
  return { func, arg: rest.join(':') };
});

if (cliArgs.length > 0) {
  for (const { func, arg } of cliArgs) {
    console.log(await request(func, arg));
  }
} else {
  // 1. Current document filename (LFUN: server-get-filename)
  console.log(await request('server-get-filename'));

  // 2. Current paragraph layout at cursor
  console.log(await request('server-get-layout'));

  // 3. Trigger a save so the on-disk .lyx file is fresh (read-path primitive)
  console.log(await request('buffer-write'));

  // 4. Insert text at the cursor (write-path primitive; LFUN: self-insert)
  console.log(await request('self-insert', 'LyXServer works from Node!'));
}

shuttingDown = true;
if (inFd !== null) fs.closeSync(inFd);
console.log('done');
process.exit(0); // readLoop reconnects forever otherwise