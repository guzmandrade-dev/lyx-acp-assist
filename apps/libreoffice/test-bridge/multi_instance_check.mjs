// Multi-instance discovery check: multiple LibreOffice bridges live at the
// same time, all discoverable, newest first, stale records dropped.
//
// Prerequisites: TWO LibreOffice instances, each with its own scratch
// profile and --accept socket (e.g. ports 2002 and 2003), the .oxt installed
// in BOTH profiles, and a bridge started in each:
//   "C:\Program Files\LibreOffice\program\python.exe" bridge_ctl.py start localhost 2002
//   "C:\Program Files\LibreOffice\program\python.exe" bridge_ctl.py start localhost 2003
// Then run with the companion's Node:
//   node multi_instance_check.mjs
// (needs `npm run build` first — it imports dist/bridge/client.js)

import fs from 'node:fs/promises';
import path from 'node:path';

import { BridgeClient, bridgesDir, discoverBridges } from '../../dist/bridge/client.js';

const results = [];

function check(name, ok, detail = '') {
  const status = ok ? 'PASS' : 'FAIL';
  results.push([status, name]);
  console.log(`[${status}] ${name}${detail ? ` — ${detail}` : ''}`);
}

const dir = bridgesDir();

// 1. Two live bridges
const records = await discoverBridges();
check('two or more live records', records.length >= 2,
  `found ${records.length}: ${records.map((r) => `${r.pid}@${r.port}`).join(', ')}`);
if (records.length < 2) {
  console.error('Need two running LibreOffice bridge instances to test multi-instance discovery.');
  process.exit(1);
}

// 2. Newest first (sorted by startedAt descending)
const sorted = [...records].sort((a, b) => (b.startedAt ?? '').localeCompare(a.startedAt ?? ''));
const orderOk = records.every((r, i) => r.pid === sorted[i].pid);
check('records newest first', orderOk,
  records.map((r) => `${r.pid}(${r.startedAt})`).join(' > '));

// 3. Every record reaches ITS OWN bridge with ITS OWN token
for (const r of records) {
  let ok = false;
  let detail = '';
  try {
    const status = await new BridgeClient(r).status();
    ok = status.pid === r.pid && status.port === r.port;
    detail = `status pid=${status.pid} port=${status.port}`;
  } catch (e) {
    detail = e.message ?? String(e);
  }
  check(`bridge ${r.pid} reachable with its own token`, ok, detail);
}

// 4. Distinct ports (no fixed-port collision)
const ports = new Set(records.map((r) => r.port));
check('distinct ports across instances', ports.size === records.length,
  [...ports].join(', '));

// 5. A dead-PID record is dropped AND unlinked on rescan
const deadFile = path.join(dir, '4194304.json'); // beyond Windows PID space
await fs.writeFile(deadFile, JSON.stringify({
  app: 'libreoffice-acp-assist', protocol: 1, pid: 4194304, port: 1,
  token: 'x', startedAt: '2999-01-01T00:00:00+00:00',
}));
const afterDead = await discoverBridges();
const deadGone = !afterDead.some((r) => r.pid === 4194304);
let fileGone = false;
try {
  await fs.access(deadFile);
} catch {
  fileGone = true;
}
check('dead-PID record dropped from scan', deadGone);
check('dead-PID record file removed', fileGone);

const failed = results.filter(([s]) => s === 'FAIL').length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
