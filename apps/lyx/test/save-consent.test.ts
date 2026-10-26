/**
 * Save-consent tests: the message stream refuses to save a document that
 * lives outside version control until the user accepts the conditions
 * (POST /save-consent, wired to the panel's modal). The gate is the only
 * thing standing between a plain file overwrite and unrecoverable loss.
 */
import { describe, it, expect, afterEach } from 'vitest';
import type { Server } from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { ContentBlock } from '@agentclientprotocol/sdk';
import { createServer, type AgentRunner } from '../src/server.js';
import { isVersionControlled } from '../src/vcs.js';
import type { LyxServerClient } from '../src/lyxserver/client.js';
import type { RawClipboard } from '../src/clipboard/lyx-clipboard.js';

/** Fixed API bearer token (audit B1) for these HTTP-level tests. */
const API_TOKEN = 'test-api-token';

const fakeDocText = () =>
  [
    '#LyX 2.5 created this file. For more info see https://www.lyx.org/',
    '\\lyxformat 643',
    '\\begin_document',
    '\\begin_header',
    '\\textclass article',
    '\\end_header',
    '',
    '\\begin_body',
    '',
    '\\begin_layout Title',
    'placeholder title',
    '\\end_layout',
    '',
    '\\begin_layout Standard',
    'body',
    '\\end_layout',
    '',
    '\\end_body',
    '\\end_document',
  ].join('\n');

/** Minimal fake agent: records prompts, replies [ACTION: none]. */
class FakeAgent implements AgentRunner {
  prompts: string[] = [];
  constructor(private replies: string[]) {}
  async start() {}
  stop() {}
  async createSession() {}
  cancel() {}
  async prompt(_sessionId: string, content: ContentBlock[]): Promise<string> {
    this.prompts.push(content.map((b) => (b.type === 'text' ? b.text : '')).join('\n'));
    return this.replies[Math.min(this.prompts.length - 1, this.replies.length - 1)] ?? 'Done.\n[ACTION: none]';
  }
}

/** Minimal in-memory LyX stand-in: enough for a [ACTION: none] round trip. */
function fakeLyx(file: string) {
  const calls = { save: 0 };
  return {
    calls,
    client: {
      async start() {},
      stop() {},
      isAvailable() {
        return true;
      },
      async getFilename() {
        return file;
      },
      async getLayout() {
        return 'Standard';
      },
      async getSelectionStats(): Promise<[number, number, number]> {
        return [0, 0, 0];
      },
      async copySelection() {
        return false;
      },
      async save() {
        calls.save += 1;
      },
      async request() {
        return 'INFO:fake:cmd:';
      },
      async tryRequest() {
        return '';
      },
      async clearSelection() {},
      async collapseSelection() {},
      async collapseSelectionForward() {
        return true;
      },
      async beginOfDocument() {
        return true;
      },
      async breakParagraph() {
        return true;
      },
      async paragraphDown() {
        return false;
      },
      async paragraphSelect() {
        return true;
      },
      async deleteSelection() {
        return false;
      },
      async mergeAwayParagraph() {},
      async mergeWithNextParagraph() {
        return true;
      },
      async paste() {},
      async undo() {},
    } as unknown as LyxServerClient,
  };
}

const rawClipboard: RawClipboard = {
  async hasFormat() {
    return false;
  },
  async readFormat() {
    return null;
  },
  async write() {
    /* no-op */
  },
  async readText() {
    return '';
  },
  async writeText() {
    /* no-op */
  },
  async clear() {
    /* no-op */
  },
};

interface Harness {
  base: string;
  sessionId: string;
  agent: FakeAgent;
  lyx: ReturnType<typeof fakeLyx>;
  dir: string;
  server: Server;
}

async function startHarness(withGit: boolean): Promise<Harness> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lyx-consent-'));
  if (withGit) await fs.mkdir(path.join(dir, '.git'));
  const file = path.join(dir, 'doc.lyx');
  await fs.writeFile(file, fakeDocText(), 'utf8');
  const lyx = fakeLyx(file);
  const agent = new FakeAgent(['Just prose.\n[ACTION: none]']);
  const app = createServer({
    apiToken: API_TOKEN, publicDir: new URL('../public', import.meta.url).pathname.replace(/^\/(\w:)/, '$1'),
    clipboard: rawClipboard,
    historyDir: dir,
    lyxFactory: () => lyx.client,
    agentFactory: () => agent,
  });
  const server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const address = server.address();
  if (typeof address !== 'object' || address === null) throw new Error('no address');
  const base = `http://127.0.0.1:${address.port}`;
  const res = await fetch(`${base}/api/session`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${API_TOKEN}` },
    body: JSON.stringify({ agent: { command: 'fake', args: [] } }),
  });
  if (!res.ok) throw new Error(`session create failed: ${res.status}`);
  const info = await res.json();
  return { base, sessionId: info.sessionId, agent, lyx, dir, server };
}

async function postMessage(h: Harness) {
  return fetch(`${h.base}/api/session/${h.sessionId}/message/stream`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${API_TOKEN}` },
    body: JSON.stringify({ message: 'explain the intro' }),
  });
}

async function readSse(res: Response) {
  const frames: Record<string, unknown>[] = [];
  const text = await res.text();
  for (const raw of text.split('\n\n')) {
    const frame = raw.trim();
    if (!frame.startsWith('data: ')) continue;
    try {
      frames.push(JSON.parse(frame.slice(6)));
    } catch {
      /* ignore */
    }
  }
  return frames;
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

describe('isVersionControlled', () => {
  it('reports false outside any VCS and true inside one (dir or worktree file)', async () => {
    const plain = await fs.mkdtemp(path.join(os.tmpdir(), 'lyx-vc-plain-'));
    cleanups.push(() => fs.rm(plain, { recursive: true, force: true }));
    expect(await isVersionControlled(path.join(plain, 'doc.lyx'))).toBe(false);

    const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'lyx-vc-repo-'));
    cleanups.push(() => fs.rm(repo, { recursive: true, force: true }));
    await fs.mkdir(path.join(repo, '.git'));
    const nested = path.join(repo, 'sub', 'doc.lyx'); // parent traversal
    expect(await isVersionControlled(nested)).toBe(true);

    const worktree = await fs.mkdtemp(path.join(os.tmpdir(), 'lyx-vc-wt-'));
    cleanups.push(() => fs.rm(worktree, { recursive: true, force: true }));
    await fs.writeFile(path.join(worktree, '.git'), 'gitdir: ../.git/worktrees/x\n', 'utf8');
    expect(await isVersionControlled(path.join(worktree, 'doc.lyx'))).toBe(true);
  });
});

describe('save-consent gate', () => {
  it('reports the VCS status on the session and documents endpoints', async () => {
    const harness = await startHarness(false);
    cleanups.push(async () => {
      await new Promise<void>((resolve) => harness.server.close(() => resolve()));
      await fs.rm(harness.dir, { recursive: true, force: true });
    });

    const docs = await (
      await fetch(`${harness.base}/api/session/${harness.sessionId}/documents`, { headers: { authorization: 'Bearer ' + API_TOKEN } })
    ).json();
    expect(docs.active).toBeTruthy();
    expect(docs.versionControlled).toBe(false);
  });

  it('refuses to save a non-VCS document (409) until consent is registered', async () => {
    const harness = await startHarness(false);
    cleanups.push(async () => {
      await new Promise<void>((resolve) => harness.server.close(() => resolve()));
      await fs.rm(harness.dir, { recursive: true, force: true });
    });

    const refused = await postMessage(harness);
    expect(refused.status).toBe(409);
    const body = await refused.json();
    expect(body.code).toBe('save-consent-required');
    expect(body.documentPath).toBe(path.join(harness.dir, 'doc.lyx'));
    // Nothing was saved and the agent was never prompted.
    expect(harness.lyx.calls.save).toBe(0);
    expect(harness.agent.prompts).toHaveLength(0);

    // The client registers the user's acceptance (modal), then retries.
    const consent = await fetch(`${harness.base}/api/session/${harness.sessionId}/save-consent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${API_TOKEN}` },
      body: JSON.stringify({ path: body.documentPath }),
    });
    expect(consent.status).toBe(200);

    const ok = await postMessage(harness);
    expect(ok.status).toBe(200);
    const frames = await readSse(ok);
    expect(harness.lyx.calls.save).toBe(1);
    expect(harness.agent.prompts).toHaveLength(1);
    expect(frames.some((f) => f.action === 'none')).toBe(true);
    expect(frames.at(-1)).toEqual({ done: true });
  });

  it('lets a version-controlled document through without consent', async () => {
    const harness = await startHarness(true);
    cleanups.push(async () => {
      await new Promise<void>((resolve) => harness.server.close(() => resolve()));
      await fs.rm(harness.dir, { recursive: true, force: true });
    });

    const res = await postMessage(harness);
    expect(res.status).toBe(200);
    const frames = await readSse(res);
    expect(harness.lyx.calls.save).toBe(1);
    expect(frames.at(-1)).toEqual({ done: true });
  });

  it('rejects a consent registration without a path', async () => {
    const harness = await startHarness(false);
    cleanups.push(async () => {
      await new Promise<void>((resolve) => harness.server.close(() => resolve()));
      await fs.rm(harness.dir, { recursive: true, force: true });
    });

    const res = await fetch(`${harness.base}/api/session/${harness.sessionId}/save-consent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${API_TOKEN}` },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });
});