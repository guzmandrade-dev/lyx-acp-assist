// Live-regression driver: talks to the companion dev server's HTTP API
// (http://127.0.0.1:8787) the same way the chat panel does.
//
// Usage (run with plain node, no deps):
//   node live_drive.mjs session              -> create a session, print JSON
//   node live_drive.mjs stream <id> <msg>    -> stream one message, print SSE frames
//   node live_drive.mjs undo <id>            -> one undo step, print JSON
//   node live_drive.mjs info <id>            -> session conversation info
//
// The agent command defaults to vibe-acp; override with AGENT_CMD.

const base = process.env.BASE_URL ?? 'http://127.0.0.1:8787';
const agentCommand = process.env.AGENT_CMD ?? 'C:\\Users\\guzma\\.local\\bin\\vibe-acp.exe';

// Tee all output to a log file: background-process output retention is
// short-lived, so the log is the durable record of a run.
import fs from 'node:fs';
const LOG = new URL('./live_drive.log', import.meta.url);
const emit = (line) => {
  console.log(line);
  fs.appendFileSync(LOG, line + '\n');
};

async function post(path, body) {
  const res = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

async function main() {
  const [mode, sessionId, ...rest] = process.argv.slice(2);
  if (mode === 'session') {
    const r = await post('/api/session', {
      agent: { command: agentCommand, args: [] },
    });
    emit(JSON.stringify(r));
    return;
  }
  if (mode === 'undo') {
    const r = await post(`/api/session/${sessionId}/undo`);
    emit(JSON.stringify(r));
    return;
  }
  if (mode === 'info') {
    const res = await fetch(`${base}/api/session/${sessionId}`);
    emit(JSON.stringify(await res.json()));
    return;
  }
  if (mode === 'stream') {
    const message = rest.join(' ');
    if (!message) throw new Error('message required');
    const res = await fetch(`${base}/api/session/${sessionId}/message/stream`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message }),
    });
    // Parse the SSE stream: print each data frame as one line.
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n\n')) !== -1) {
        const chunk = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        for (const line of chunk.split('\n')) {
          if (line.startsWith('data: ')) emit(line.slice(6));
        }
      }
    }
    return;
  }
  throw new Error(`unknown mode ${mode}`);
}

main().catch((e) => {
  emit('DRIVER_ERROR', e);
  process.exit(1);
});
