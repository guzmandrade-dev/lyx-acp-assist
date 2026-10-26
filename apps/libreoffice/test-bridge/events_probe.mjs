// Track D live probe: subscribe to the server's push channel, then make a
// REAL selection change in LibreOffice over UNO and expect a {refresh}
// frame — the /events long-poll -> core channel -> panel chain.
const base = process.env.BASE_URL ?? 'http://127.0.0.1:8787';
const sid = process.argv[2];
import fs from 'node:fs';
import path from 'node:path';
const record = JSON.parse(
  fs.readFileSync(path.join(process.env.APPDATA, 'LibreOffice ACP Assist', 'companion.json'), 'utf8'));

(async () => {
  const res = await fetch(`${base}/api/session/${sid}/events`, {
    headers: { authorization: `Bearer ${record.token}` },
  });
  if (res.status !== 200) throw new Error(`channel status ${res.status}`);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const frames = [];
  let buf = '';
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const { done, value } = await Promise.race([
      reader.read(),
      new Promise((r) => setTimeout(() => r({ done: false, value: undefined, timeout: true }), deadline - Date.now())),
    ]);
    if (done) break;
    if (!value) continue;
    buf += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n\n')) !== -1) {
      const chunk = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      for (const line of chunk.split('\n')) {
        if (line.startsWith('data: ')) {
          const f = JSON.parse(line.slice(6));
          frames.push(f);
          console.log('FRAME', JSON.stringify(f));
        }
      }
    }
    if (frames.some((f) => f.refresh)) {
      console.log('LIVE PUSH VERIFIED');
      break;
    }
  }
  if (!frames.some((f) => f.refresh)) {
    console.log('NO REFRESH FRAME — frames seen:', JSON.stringify(frames));
    process.exit(1);
  }
  await reader.cancel();
})().catch((e) => { console.error('PROBE_ERROR', e.message); process.exit(1); });
