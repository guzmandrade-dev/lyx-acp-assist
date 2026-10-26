import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import type { Server } from 'node:http';
import { createServer, type AgentRunner, type AgentSettings } from '../src/server.js';
import { PANEL_CONFIG } from '../src/panel-config.js';
import { BridgeClient, BridgeError, type BridgeDocument, type EditPayload, type BridgeStatus, type BridgeDocumentEntry } from '../src/bridge/client.js';

/** Fixed API bearer token (audit B1) for these HTTP-level tests. */
const API_TOKEN = 'test-api-token';

/**
 * In-memory fake of the in-LibreOffice bridge. Implements the same
 * paragraph semantics as acpbridge.py (insert = fresh paragraphs below
 * the cursor, rewrite-at = replace, delete-at = remove) so the whole
 * multi-action loop can run without LibreOffice.
 */
class FakeBridge extends BridgeClient {
  paragraphs: Array<{ text: string; style: string }> = [];
  edits: EditPayload[] = [];
  undone = 0;
  private cursorAt = 0; // paragraph index the view cursor sits in

  constructor() {
    super({ app: 'test', protocol: 1, pid: process.pid, port: 0, token: 't', startedAt: '' });
    this.paragraphs = [
      { text: 'Intro paragraph.', style: 'Standard' },
      { text: 'Body paragraph.', style: 'Standard' },
    ];
  }

  override status(): Promise<BridgeStatus> {
    return Promise.resolve({
      active: true,
      module: 'writer',
      title: 'Fake Doc',
      url: 'file:///fake/doc.odt',
      recordChanges: false,
      pid: process.pid,
      port: 0,
      startedAt: '',
    });
  }

  override documents(): Promise<{ documents: BridgeDocumentEntry[] }> {
    return Promise.resolve({
      documents: [{ title: 'Fake Doc', url: 'file:///fake/doc.odt', module: 'writer', active: true }],
    });
  }

  override document(): Promise<BridgeDocument> {
    return Promise.resolve({
      active: true,
      module: 'writer',
      title: 'Fake Doc',
      url: 'file:///fake/doc.odt',
      paragraphs: this.paragraphs.map((p, i) => ({ i, text: p.text, style: p.style })),
      selection: null,
      cursorStyle: 'Standard',
      truncated: false,
    });
  }

  override paragraph(index: number) {
    const p = this.paragraphs[index];
    if (!p) throw new Error(`paragraph [p${index + 1}] does not exist`);
    return Promise.resolve({ i: index, text: p.text, style: p.style });
  }

  override edit(payload: EditPayload) {
    this.edits.push(payload);
    const paras = payload.paragraphs ?? [];
    const plain = (p: { style: string | null; runs: Array<{ text: string }> }) => ({
      text: p.runs.map((r) => r.text).join(''),
      style: p.style ?? 'Standard',
    });
    if (payload.mode === 'insert' || payload.mode === 'insert-top') {
      const at = payload.mode === 'insert-top' ? 0 : this.cursorAt + 1;
      this.paragraphs.splice(at, 0, ...paras.map(plain));
      this.cursorAt = at + paras.length - 1;
    } else if (payload.mode === 'insert-after') {
      const t = payload.target ?? 0;
      this.paragraphs.splice(t, 0, ...paras.map(plain));
    } else if (payload.mode === 'rewrite-at') {
      const t = (payload.target ?? 0) - 1;
      this.paragraphs.splice(t, 1, ...paras.map(plain));
    } else if (payload.mode === 'delete-at') {
      this.paragraphs.splice((payload.target ?? 0) - 1, 1);
    } else if (payload.mode === 'rewrite') {
      this.paragraphs.splice(this.cursorAt, 1, ...paras.map(plain));
    }
    return Promise.resolve({ applied: true, title: 'Fake Doc', mode: payload.mode, target: payload.target ?? null });
  }

  override undo() {
    this.undone += 1;
    return Promise.resolve({ undone: true });
  }

  override activate() {
    return Promise.resolve({ activated: 'file:///fake/doc.odt' });
  }
}

/** Fake ACP agent with a scripted queue of replies. */
function fakeAgent(replies: string[]): (settings: AgentSettings) => AgentRunner {
  return () => ({
    start: async () => undefined,
    stop: () => undefined,
    createSession: async () => undefined,
    cancel: () => undefined,
    prompt: async () => {
      const reply = replies.shift();
      if (reply === undefined) throw new Error('fake agent out of scripted replies');
      return reply;
    },
  });
}

function sseFrames(body: string): Array<Record<string, unknown>> {
  return body
    .split('\n\n')
    .filter((f) => f.startsWith('data: '))
    .map((f) => JSON.parse(f.slice(6)));
}

describe('server message loop (fake agent + fake bridge)', () => {
  let httpServer: Server;
  let baseUrl: string;
  let bridge: FakeBridge;
  const publicDir = path.join(os.tmpdir(), 'lo-acp-test-public');
  const historyDir = path.join(os.tmpdir(), 'lo-acp-test-history');

  it('requires the API bearer token and a loopback Host (audit B1)', async () => {    const noAuth = await fetch(`${baseUrl}/api/status`);
    expect(noAuth.status).toBe(401);
    const wrong = await fetch(`${baseUrl}/api/status`, { headers: { authorization: 'Bearer nope' } });
    expect(wrong.status).toBe(401);
    // DNS-rebinding shape: a public Host name is rejected even with a
    // valid token. Raw socket request — fetch() refuses to override the
    // Host header.
    const u = new URL(baseUrl);
    const rebindingStatus = await new Promise<number>((resolve) => {
      const req = http.request(
        {
          host: u.hostname,
          port: u.port,
          path: '/api/status',
          method: 'GET',
          headers: { host: 'evil.example.com', authorization: 'Bearer ' + API_TOKEN },
        },
        (res) => {
          resolve(res.statusCode ?? 0);
          res.resume();
        },
      );
      req.on('error', () => resolve(0));
      req.end();
    });
    expect(rebindingStatus).toBe(403);
    // The panel index references the CSP-safe boot script; the token +
    // config live there.
    const index = await fetch(`${baseUrl}/`);
    expect(index.status).toBe(200);
    expect(await index.text()).toContain('<script src="/panel-boot.js"></script>');
    const boot = await fetch(`${baseUrl}/panel-boot.js`);
    expect(await boot.text()).toContain('window.__ACP_TOKEN__');
  });

  beforeAll(async () => {
    await fs.mkdir(publicDir, { recursive: true });
    await fs.writeFile(path.join(publicDir, 'index.html'), '<html><head></head><body></body></html>', 'utf8');
    await fs.rm(historyDir, { recursive: true, force: true });
    bridge = new FakeBridge();
    const app = createServer({
      apiToken: API_TOKEN, publicDir, panelConfig: PANEL_CONFIG,
      historyDir,
      agentFactory: fakeAgent([]),
      bridgeFactory: () => bridge,
    });
    httpServer = app.listen(0, '127.0.0.1');
    await new Promise<void>((r) => httpServer.on('listening', r));
    const addr = httpServer.address();
    if (typeof addr === 'object' && addr) baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterAll(async () => {
    httpServer.close();
    await fs.rm(historyDir, { recursive: true, force: true });
  });

  it('recovers a stale bridge record without a manual reconnect (B3)', async () => {
    // The session pins a record that has gone dead (bridge restarted from
    // the LO sidebar: new port + token). Every call on it fails like a
    // dead port; recovery must swap in the live bridge and retry once.
    class StaleBridge extends FakeBridge {
      override status(): Promise<BridgeStatus> {
        return Promise.reject(new BridgeError('bridge unreachable (dead port)'));
      }
      override document(): Promise<BridgeDocument> {
        return Promise.reject(new BridgeError('bridge unreachable (dead port)'));
      }
    }
    const fresh = new FakeBridge();
    // Isolated history dir: this fake bridge serves the same doc URL as
    // the suite's shared one, and the recorded turns must not leak into
    // the other tests' conversation assertions.
    const b3History = path.join(os.tmpdir(), 'lo-acp-test-history-b3');
    const app = createServer({
      apiToken: API_TOKEN, publicDir, panelConfig: PANEL_CONFIG,
      historyDir: b3History,
      agentFactory: fakeAgent(['All good. [ACTION: none]']),
      bridgeFactory: () => new StaleBridge() as unknown as BridgeClient,
      recoverBridge: () => Promise.resolve(fresh as unknown as BridgeClient),
    });
    const srv = app.listen(0, '127.0.0.1');
    await new Promise<void>((r) => srv.on('listening', r));
    const addr = srv.address() as { port: number };
    const url = `http://127.0.0.1:${addr.port}`;
    try {
      const headers = { 'content-type': 'application/json', authorization: 'Bearer ' + API_TOKEN };
      // Session creation (sessionInfo -> status) and the message stream
      // (document read) both hit the stale record first and must succeed
      // via the swap.
      const created = await fetch(`${url}/api/session`, { method: 'POST', headers });
      expect(created.status).toBe(200);
      const session = (await created.json()) as { sessionId: string };
      const res = await fetch(`${url}/api/session/${session.sessionId}/message/stream`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ message: 'hello' }),
      });
      const text = await res.text();
      const frames: Record<string, unknown>[] = [];
      for (const raw of text.split('\n\n')) {
        if (!raw.startsWith('data: ')) continue;
        try { frames.push(JSON.parse(raw.slice(6))); } catch { /* skip */ }
      }
      expect(frames.some((f) => f.stopped === 'none')).toBe(true);
      expect(frames[frames.length - 1]).toEqual({ done: true });
      expect(frames.some((f) => typeof f.error === 'string')).toBe(false);
    } finally {
      srv.close();
      await fs.rm(b3History, { recursive: true, force: true });
    }
  });

  it('runs a multi-action loop: edit, continuation, then none', async () => {
    const scripted = [
      'Adding the section.\n```writer\n## Results\nThe numbers are in.\n```\n[ACTION: insert-after p2]',
      'One more paragraph inserted.\n```writer\nStill to do.\n```\n[ACTION: insert-after p3]',
      'All edits are now complete.',
    ];
    // Re-create the session with a scripted agent (per-test agent).
    const app = createServer({
      apiToken: API_TOKEN, publicDir, panelConfig: PANEL_CONFIG,
      historyDir,
      agentFactory: fakeAgent(scripted),
      bridgeFactory: () => new FakeBridge(),
    });
    const srv = app.listen(0, '127.0.0.1');
    await new Promise<void>((r) => srv.on('listening', r));
    const addr = srv.address() as { port: number };
    const url = `http://127.0.0.1:${addr.port}`;

    const status = await (await fetch(`${url}/api/status`, { headers: { authorization: 'Bearer ' + API_TOKEN } })).json();
    expect(status.bridgeAvailable).toBe(true);

    const created = await fetch(`${url}/api/session`, { method: 'POST', headers: { authorization: 'Bearer ' + API_TOKEN } });
    expect(created.status).toBe(200);
    const session = (await created.json()) as { sessionId: string };
    expect(session.documentPath).toBe('file:///fake/doc.odt');
    expect(session.outline).toContain('[p2]');

    const res = await fetch(`${url}/api/session/${session.sessionId}/message/stream`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${API_TOKEN}` },
      body: JSON.stringify({ message: 'Add a Results section after paragraph 2, then a follow-up paragraph.' }),
    });
    const body = await res.text();
    const frames = sseFrames(body);
    const applied = frames.filter((f) => 'applied' in f);
    expect(applied.map((f) => f['applied'])).toEqual(['insert-after', 'insert-after']);
    const stopped = frames.find((f) => 'stopped' in f);
    expect(stopped?.['stopped']).toBe('none');
    expect(frames[frames.length - 1]).toEqual({ done: true });

    // The fake bridge applied both edits with paragraph addressing.
    const fakeBridgeInstance = (srv as unknown as { _loFakeBridge?: FakeBridge });
    void fakeBridgeInstance;

    // Session info reflects the edited document and the conversation. The
    // outline is opt-in (`?outline=1`): the plain GET is the panel's light
    // refresh path and skips the full document read.
    const info = (await (
      await fetch(`${url}/api/session/${session.sessionId}?outline=1`, { headers: { authorization: 'Bearer ' + API_TOKEN } })
    ).json()) as {
      conversation: Array<{ role: string; content: string; meta?: { action: string; result: string } }>;
      outline: string;
    };
    expect(info.conversation.length).toBeGreaterThanOrEqual(4);
    expect(info.outline).toContain('Results');
    // The plain (light) GET skips the full document read.
    const light = (await (await fetch(`${url}/api/session/${session.sessionId}`, { headers: { authorization: 'Bearer ' + API_TOKEN } })).json()) as {
      outline: string;
    };
    expect(light.outline).toBe('');
    const metas = info.conversation.filter((t) => t.meta).map((t) => t.meta);
    expect(metas[0]?.action).toBe('insert-after');
    expect(metas[0]?.result).toBe('applied');

    srv.close();
  });

  it('runs a Calc write-cells action through the calc adapter', async () => {
    const edits: EditPayload[] = [];
    const calcBridge = new (class extends BridgeClient {
      constructor() {
        super({ app: 'test', protocol: 1, pid: process.pid, port: 0, token: 't', startedAt: '' });
      }
      override status(): Promise<BridgeStatus> {
        return Promise.resolve({
          active: true, module: 'calc', title: 'Budget', url: 'file:///fake/budget.ods',
          recordChanges: false, pid: process.pid, port: 0, startedAt: '',
        });
      }
      override document(): Promise<BridgeDocument> {
        return Promise.resolve({
          active: true, module: 'calc', title: 'Budget', url: 'file:///fake/budget.ods',
          calc: {
            sheets: [{ name: 'Sheet1', usedRange: 'A1:B3', active: true }],
            selection: {
              sheet: 'Sheet1', ranges: ['Sheet1!A1:B3'], anchor: 'A1', rows: 3, cols: 2,
              values: [['Name', 'Qty'], ['Widget', '5'], ['', '10']],
              formulas: null, truncated: false,
            },
            data: {
              sheet: 'Sheet1', range: 'A1:B3',
              values: [['Name', 'Qty'], ['Widget', '5'], ['', '10']],
              formulas: null, truncated: false,
            },
          },
          cursorStyle: null,
        });
      }
      override edit(payload: EditPayload) {
        edits.push(payload);
        return Promise.resolve({
          applied: true, title: 'Budget', mode: payload.mode,
          anchor: payload.anchor ?? 'A1',
        });
      }
    })();
    const app = createServer({
      apiToken: API_TOKEN, publicDir, panelConfig: PANEL_CONFIG,
      historyDir,
      agentFactory: fakeAgent([
        'Writing the totals.\n```calc\nTotal\t=SUM(B2:B3)\n```\n[ACTION: write-cells C1]',
        'Done.\n[ACTION: none]',
      ]),
      bridgeFactory: () => calcBridge,
    });
    const srv = app.listen(0, '127.0.0.1');
    await new Promise<void>((r) => srv.on('listening', r));
    const addr = srv.address() as { port: number };
    const url = `http://127.0.0.1:${addr.port}`;
    const session = (await (await fetch(`${url}/api/session`, { method: 'POST', headers: { authorization: 'Bearer ' + API_TOKEN } })).json()) as {
      sessionId: string;
      outline: string;
    };
    expect(session.outline).toContain('Sheet1 (used A1:B3) *');

    const res = await fetch(`${url}/api/session/${session.sessionId}/message/stream`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${API_TOKEN}` },
      body: JSON.stringify({ message: 'Add a total in C1.' }),
    });
    const frames = sseFrames(await res.text());
    const applied = frames.filter((f) => 'applied' in f);
    expect(applied).toEqual([{ applied: 'write-cells', target: null, address: 'C1', module: 'calc' }]);
    expect(edits).toMatchObject([
      { mode: 'write-cells', anchor: 'C1', rows: [['Total', '=SUM(B2:B3)']], tracked: true },
    ]);

    const info = (await (await fetch(`${url}/api/session/${session.sessionId}`, { headers: { authorization: 'Bearer ' + API_TOKEN } })).json()) as {
      conversation: Array<{ meta?: { action: string; address: string | null; result: string } }>;
    };
    const meta = info.conversation.find((t) => t.meta)?.meta;
    expect(meta).toMatchObject({ action: 'write-cells', address: 'C1', result: 'applied' });
    srv.close();
  });

  it('runs an Impress insert-after + rewrite-slide loop through the impress adapter', async () => {
    const edits: EditPayload[] = [];
    const impressBridge = new (class extends BridgeClient {
      constructor() {
        super({ app: 'test', protocol: 1, pid: process.pid, port: 0, token: 't', startedAt: '' });
      }
      override status(): Promise<BridgeStatus> {
        return Promise.resolve({
          active: true, module: 'impress', title: 'Deck', url: 'file:///fake/deck.odp',
          pid: process.pid, port: 0, startedAt: '',
        });
      }
      override document(): Promise<BridgeDocument> {
        return Promise.resolve({
          active: true, module: 'impress', title: 'Deck', url: 'file:///fake/deck.odp',
          slides: [
            { i: 0, name: 'page1', current: true, shapes: [{ i: 0, kind: 'title', text: 'Q3 Results' }, { i: 1, kind: 'body', text: 'Revenue up' }] },
            { i: 1, name: 'page2', current: false, shapes: [{ i: 0, kind: 'title', text: 'Agenda' }, { i: 1, kind: 'body', text: 'Item one\nItem two' }] },
          ],
          selection: null,
          cursorStyle: null,
        });
      }
      override edit(payload: EditPayload) {
        edits.push(payload);
        return Promise.resolve({
          applied: true, title: 'Deck', mode: payload.mode,
          slide: payload.slide ?? 0,
        });
      }
    })();
    const app = createServer({
      apiToken: API_TOKEN, publicDir, panelConfig: PANEL_CONFIG,
      historyDir,
      agentFactory: fakeAgent([
        'Adding the slide.\n```impress\nConclusions\nShip it\nRest is history\n```\n[ACTION: insert-after s2]',
        'Rewording the opener.\n```impress\nQ3 Results — final\nRevenue up\nCosts flat\n```\n[ACTION: rewrite-slide s1]',
        'Done.\n[ACTION: none]',
      ]),
      bridgeFactory: () => impressBridge,
    });
    const srv = app.listen(0, '127.0.0.1');
    await new Promise<void>((r) => srv.on('listening', r));
    const addr = srv.address() as { port: number };
    const url = `http://127.0.0.1:${addr.port}`;
    const session = (await (await fetch(`${url}/api/session`, { method: 'POST', headers: { authorization: 'Bearer ' + API_TOKEN } })).json()) as {
      sessionId: string;
      outline: string;
    };
    expect(session.outline).toContain('[s1] * Q3 Results');

    const res = await fetch(`${url}/api/session/${session.sessionId}/message/stream`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${API_TOKEN}` },
      body: JSON.stringify({ message: 'Add a Conclusions slide after slide 2, then reword slide 1 informally.' }),
    });
    const frames = sseFrames(await res.text());
    const applied = frames.filter((f) => 'applied' in f);
    expect(applied).toEqual([
      { applied: 'insert-after', target: 2, address: null, module: 'impress' },
      { applied: 'rewrite-slide', target: 1, address: null, module: 'impress', step: 2 },
    ]);
    expect(edits).toMatchObject([
      { mode: 'insert-slide-after', slide: 2, title: 'Conclusions', body: ['Ship it', 'Rest is history'] },
      { mode: 'rewrite-slide', slide: 0, title: 'Q3 Results — final', body: ['Revenue up', 'Costs flat'] },
    ]);

    const info = (await (await fetch(`${url}/api/session/${session.sessionId}`, { headers: { authorization: 'Bearer ' + API_TOKEN } })).json()) as {
      conversation: Array<{ meta?: { action: string; target: number | null; module: string; result: string; step?: number } }>;
    };
    const metas = info.conversation.filter((t) => t.meta).map((t) => t.meta);
    expect(metas).toEqual([
      { action: 'insert-after', target: 2, address: null, module: 'impress', result: 'applied' },
      { action: 'rewrite-slide', target: 1, address: null, module: 'impress', result: 'applied', step: 2 },
      { action: 'none', target: null, address: null, module: 'impress', result: 'applied', step: 3 },
    ]);
    srv.close();
  });

  it('undo routes through the bridge and reports when nothing is undoable', async () => {
    const app = createServer({
      apiToken: API_TOKEN, publicDir, panelConfig: PANEL_CONFIG,
      agentFactory: fakeAgent([]),
      bridgeFactory: () => {
        const b = new FakeBridge();
        b.undo = () => Promise.resolve({ undone: false, reason: 'nothing to undo' });
        return b;
      },
    });
    const srv = app.listen(0, '127.0.0.1');
    await new Promise<void>((r) => srv.on('listening', r));
    const addr = srv.address() as { port: number };
    const url = `http://127.0.0.1:${addr.port}`;
    const session = (await (await fetch(`${url}/api/session`, { method: 'POST', headers: { authorization: 'Bearer ' + API_TOKEN } })).json()) as {
      sessionId: string;
    };
    const undo = await (await fetch(`${url}/api/session/${session.sessionId}/undo`, { method: 'POST', headers: { authorization: 'Bearer ' + API_TOKEN } })).json();
    expect(undo).toEqual({ ok: false, reason: 'nothing to undo' });
    srv.close();
  });

  it('refuses document actions for unsupported modules via the generic adapter', async () => {
    const app = createServer({
      apiToken: API_TOKEN, publicDir, panelConfig: PANEL_CONFIG,
      agentFactory: fakeAgent(['I will edit it.\n```writer\nNope\n```\n[ACTION: insert]']),
      bridgeFactory: () => {
        const b = new FakeBridge();
        b.status = () => Promise.resolve({
          active: true, module: 'math', title: 'Formula', url: 'file:///fake/formula.odf',
          recordChanges: false, pid: process.pid, port: 0, startedAt: '',
        });
        b.document = () => Promise.resolve({
          active: true, module: 'math', title: 'Formula', url: 'file:///fake/formula.odf',
          cursorStyle: null,
        });
        return b;
      },
    });
    const srv = app.listen(0, '127.0.0.1');
    await new Promise<void>((r) => srv.on('listening', r));
    const addr = srv.address() as { port: number };
    const url = `http://127.0.0.1:${addr.port}`;
    const session = (await (await fetch(`${url}/api/session`, { method: 'POST', headers: { authorization: 'Bearer ' + API_TOKEN } })).json()) as {
      sessionId: string;
    };
    const res = await fetch(`${url}/api/session/${session.sessionId}/message/stream`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${API_TOKEN}` },
      body: JSON.stringify({ message: 'edit this spreadsheet' }),
    });
    const frames = sseFrames(await res.text());
    const error = frames.find((f) => 'error' in f);
    expect(String(error?.['error'])).toContain('not supported for this module');
    srv.close();
  });
});
describe('bridge extension install routes', () => {
  const publicDir = path.join(os.tmpdir(), 'lo-acp-test-public');

  async function makeApp(opts: Partial<Parameters<typeof createServer>[0]> = {}) {
    const app = createServer({
      apiToken: API_TOKEN, publicDir, panelConfig: PANEL_CONFIG,
      agentFactory: () => ({ start: async () => undefined, stop: () => undefined, createSession: async () => undefined, cancel: () => undefined, prompt: async () => '' }),
      bridgeFactory: () => new FakeBridge(),
      ...opts,
    });
    const srv = app.listen(0, '127.0.0.1');
    await new Promise<void>((r) => srv.on('listening', r));
    const addr = srv.address() as { port: number };
    return { srv, url: `http://127.0.0.1:${addr.port}` };
  }

  it('preflight reports not configured without an oxt path', async () => {
    const { srv, url } = await makeApp();
    const pre = (await (await fetch(`${url}/api/bridge/install/preflight`, { headers: { authorization: 'Bearer ' + API_TOKEN } })).json()) as { canInstall: boolean; reason: string };
    expect(pre.canInstall).toBe(false);
    expect(pre.reason).toContain('not configured');
    srv.close();
  });

  it('preflight reports a missing oxt file', async () => {
    const { srv, url } = await makeApp({
      oxtPath: path.join(os.tmpdir(), 'lo-acp-test', 'missing.oxt'),
      unopkgPath: 'C:/fake/unopkg.exe',
    });
    const pre = (await (await fetch(`${url}/api/bridge/install/preflight`, { headers: { authorization: 'Bearer ' + API_TOKEN } })).json()) as { canInstall: boolean; reason: string };
    expect(pre.canInstall).toBe(false);
    expect(pre.reason).toContain('not found');
    srv.close();
  });

  it('preflight reports installable when oxt + unopkg are present', async () => {
    const oxtPath = path.join(os.tmpdir(), 'lo-acp-test.oxt');
    await fs.writeFile(oxtPath, 'fake oxt', 'utf8');
    const { srv, url } = await makeApp({
      oxtPath,
      unopkgPath: 'C:/fake/unopkg.exe',
      sofficeProbe: async () => false,
    });
    const pre = (await (await fetch(`${url}/api/bridge/install/preflight`, { headers: { authorization: 'Bearer ' + API_TOKEN } })).json()) as {
      canInstall: boolean; unopkg: string; sofficeRunning: boolean;
    };
    expect(pre.canInstall).toBe(true);
    expect(pre.unopkg).toBe('C:/fake/unopkg.exe');
    expect(pre.sofficeRunning).toBe(false);
    await fs.rm(oxtPath, { force: true });
    srv.close();
  });

  it('preflight reports not installable when unopkg is missing', async () => {
    const oxtPath = path.join(os.tmpdir(), 'lo-acp-test.oxt');
    await fs.writeFile(oxtPath, 'fake oxt', 'utf8');
    const { srv, url } = await makeApp({ oxtPath, unopkgPath: null });
    const pre = (await (await fetch(`${url}/api/bridge/install/preflight`, { headers: { authorization: 'Bearer ' + API_TOKEN } })).json()) as { canInstall: boolean; reason: string };
    expect(pre.canInstall).toBe(false);
    expect(pre.reason).toContain('unopkg not found');
    await fs.rm(oxtPath, { force: true });
    srv.close();
  });

  it('install runs remove-then-add and reports success', async () => {
    const calls: Array<{ unopkg: string; oxt: string }> = [];
    const { srv, url } = await makeApp({
      oxtPath: 'C:/fake/bridge.oxt',
      unopkgPath: 'C:/fake/unopkg.exe',
      sofficeProbe: async () => false,
      installBridge: async (unopkg, oxt) => {
        calls.push({ unopkg, oxt });
        return { ok: true, steps: [], message: 'Extension installed.' };
      },
    });
    const res = await fetch(`${url}/api/bridge/install`, { method: 'POST', headers: { authorization: 'Bearer ' + API_TOKEN } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; message: string };
    expect(body.ok).toBe(true);
    expect(body.message).toBe('Extension installed.');
    expect(calls).toEqual([{ unopkg: 'C:/fake/unopkg.exe', oxt: 'C:/fake/bridge.oxt' }]);
    srv.close();
  });

  it('install refuses while LibreOffice is running (409)', async () => {
    const { srv, url } = await makeApp({
      oxtPath: 'C:/fake/bridge.oxt',
      unopkgPath: 'C:/fake/unopkg.exe',
      sofficeProbe: async () => true,
      installBridge: async () => {
        throw new Error('must not be called');
      },
    });
    const res = await fetch(`${url}/api/bridge/install`, { method: 'POST', headers: { authorization: 'Bearer ' + API_TOKEN } });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('Close it first');
    srv.close();
  });

  it('install surfaces a failed unopkg add as 500', async () => {
    const { srv, url } = await makeApp({
      oxtPath: 'C:/fake/bridge.oxt',
      unopkgPath: 'C:/fake/unopkg.exe',
      sofficeProbe: async () => false,
      installBridge: async () => ({
        ok: false,
        steps: [],
        message: 'unopkg add failed (exit 1): boom',
      }),
    });
    const res = await fetch(`${url}/api/bridge/install`, { method: 'POST', headers: { authorization: 'Bearer ' + API_TOKEN } });
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('unopkg add failed');
    srv.close();
  });
});
