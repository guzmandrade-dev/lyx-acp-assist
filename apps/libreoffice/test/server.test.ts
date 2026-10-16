import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import { createServer, type AgentRunner, type AgentSettings } from '../src/server.js';
import { BridgeClient, type BridgeDocument, type EditPayload, type BridgeStatus, type BridgeDocumentEntry } from '../src/bridge/client.js';

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

  beforeAll(async () => {
    await fs.mkdir(publicDir, { recursive: true });
    await fs.writeFile(path.join(publicDir, 'index.html'), '<html></html>', 'utf8');
    await fs.rm(historyDir, { recursive: true, force: true });
    bridge = new FakeBridge();
    const app = createServer({
      publicDir,
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

  it('runs a multi-action loop: edit, continuation, then none', async () => {
    const scripted = [
      'Adding the section.\n```writer\n## Results\nThe numbers are in.\n```\n[ACTION: insert-after p2]',
      'One more paragraph inserted.\n```writer\nStill to do.\n```\n[ACTION: insert-after p3]',
      'All edits are now complete.',
    ];
    // Re-create the session with a scripted agent (per-test agent).
    const app = createServer({
      publicDir,
      historyDir,
      agentFactory: fakeAgent(scripted),
      bridgeFactory: () => new FakeBridge(),
    });
    const srv = app.listen(0, '127.0.0.1');
    await new Promise<void>((r) => srv.on('listening', r));
    const addr = srv.address() as { port: number };
    const url = `http://127.0.0.1:${addr.port}`;

    const status = await (await fetch(`${url}/api/status`)).json();
    expect(status.bridgeAvailable).toBe(true);

    const created = await fetch(`${url}/api/session`, { method: 'POST' });
    expect(created.status).toBe(200);
    const session = (await created.json()) as { sessionId: string };
    expect(session.documentPath).toBe('file:///fake/doc.odt');
    expect(session.outline).toContain('[p2]');

    const res = await fetch(`${url}/api/session/${session.sessionId}/message/stream`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
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

    // Session info reflects the edited document and the conversation.
    const info = (await (await fetch(`${url}/api/session/${session.sessionId}`)).json()) as {
      conversation: Array<{ role: string; content: string; meta?: { action: string; result: string } }>;
      outline: string;
    };
    expect(info.conversation.length).toBeGreaterThanOrEqual(4);
    expect(info.outline).toContain('Results');
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
      publicDir,
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
    const session = (await (await fetch(`${url}/api/session`, { method: 'POST' })).json()) as {
      sessionId: string;
      outline: string;
    };
    expect(session.outline).toContain('Sheet1 (used A1:B3) *');

    const res = await fetch(`${url}/api/session/${session.sessionId}/message/stream`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'Add a total in C1.' }),
    });
    const frames = sseFrames(await res.text());
    const applied = frames.filter((f) => 'applied' in f);
    expect(applied).toEqual([{ applied: 'write-cells', target: null, address: 'C1' }]);
    expect(edits).toMatchObject([
      { mode: 'write-cells', anchor: 'C1', rows: [['Total', '=SUM(B2:B3)']], tracked: true },
    ]);

    const info = (await (await fetch(`${url}/api/session/${session.sessionId}`)).json()) as {
      conversation: Array<{ meta?: { action: string; address: string | null; result: string } }>;
    };
    const meta = info.conversation.find((t) => t.meta)?.meta;
    expect(meta).toMatchObject({ action: 'write-cells', address: 'C1', result: 'applied' });
    srv.close();
  });

  it('undo routes through the bridge and reports when nothing is undoable', async () => {
    const app = createServer({
      publicDir,
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
    const session = (await (await fetch(`${url}/api/session`, { method: 'POST' })).json()) as {
      sessionId: string;
    };
    const undo = await (await fetch(`${url}/api/session/${session.sessionId}/undo`, { method: 'POST' })).json();
    expect(undo).toEqual({ ok: false, reason: 'nothing to undo' });
    srv.close();
  });

  it('refuses document actions for unsupported modules via the generic adapter', async () => {
    const app = createServer({
      publicDir,
      agentFactory: fakeAgent(['I will edit it.\n```writer\nNope\n```\n[ACTION: insert]']),
      bridgeFactory: () => {
        const b = new FakeBridge();
        b.status = () => Promise.resolve({
          active: true, module: 'impress', title: 'Deck', url: 'file:///fake/deck.odp',
          recordChanges: false, pid: process.pid, port: 0, startedAt: '',
        });
        b.document = () => Promise.resolve({
          active: true, module: 'impress', title: 'Deck', url: 'file:///fake/deck.odp',
          cursorStyle: null,
        });
        return b;
      },
    });
    const srv = app.listen(0, '127.0.0.1');
    await new Promise<void>((r) => srv.on('listening', r));
    const addr = srv.address() as { port: number };
    const url = `http://127.0.0.1:${addr.port}`;
    const session = (await (await fetch(`${url}/api/session`, { method: 'POST' })).json()) as {
      sessionId: string;
    };
    const res = await fetch(`${url}/api/session/${session.sessionId}/message/stream`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'edit this spreadsheet' }),
    });
    const frames = sseFrames(await res.text());
    const error = frames.find((f) => 'error' in f);
    expect(String(error?.['error'])).toContain('not supported for this module');
    srv.close();
  });
});