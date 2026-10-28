/**
 * Panel smoke tests: the shared assets are config-driven and the index
 * handler injects everything the panel needs at boot.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import express from 'express';
import { createPanelBootScript, createPanelIndexHandler, panelPublicDir, type PanelConfig } from '../src/index.js';

const execFileAsync = promisify(execFile);


const testConfig: PanelConfig = {
  appName: 'TestEditor',
  appTitle: 'TestEditor ACP Assist',
  fenceRe: 'test',
  statusKey: 'testAvailable',
  statusMissing: 'TestEditor not running',
  cursorTerm: 'layout',
  hasSaveConsent: true,
  hasInstallFlow: false,
  composerRefreshSelection: false,
  busyText: 'talking to TestEditor…',
  eventPush: false,
  theme: 'theme-test',
};

describe('shared panel assets', () => {
  it('public dir contains the shared panel files', async () => {
    const dir = panelPublicDir();
    await expect(fs.access(path.join(dir, 'index.html'))).resolves.toBeUndefined();
    await expect(fs.access(path.join(dir, 'app.js'))).resolves.toBeUndefined();
    await expect(fs.access(path.join(dir, 'style.css'))).resolves.toBeUndefined();
    for (const name of [
      'state.js', 'api.js', 'markdown.js', 'messages.js', 'typing.js',
      'status.js', 'save-consent.js', 'install.js', 'documents.js',
      'events.js', 'conversation.js', 'attachments.js',
    ]) {
      await expect(fs.access(path.join(dir, name))).resolves.toBeUndefined();
    }
  });

  it('shared modules are syntactically valid and carry the config seams', async () => {
    const dir = panelPublicDir();
    const entries = await fs.readdir(dir);
    const modules = entries.filter((f) => f.endsWith('.js')).sort();
    expect(modules.length).toBeGreaterThan(1);

    // Syntax-check every module as an ES module: node --check validates
    // import/export without executing the code.
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'panel-syntax-'));
    try {
      for (const name of modules) {
        const target = path.join(tmp, name.replace(/\.js$/, '.mjs'));
        await fs.copyFile(path.join(dir, name), target);
        await execFileAsync(process.execPath, ['--check', target]);
      }
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }

    // The config seams the apps rely on, across the whole module set.
    const source = (
      await Promise.all(modules.map((name) => fs.readFile(path.join(dir, name), 'utf8')))
    ).join('\n');
    expect(source).toContain('__ACP_PANEL_CONFIG__');
    expect(source).toContain('__ACP_TOKEN__');
    expect(source).toContain('FENCE_RE');
    expect(source).toContain('hasSaveConsent');
    expect(source).toContain('hasInstallFlow');
    expect(source).toContain('composerRefreshSelection');
    expect(source).toContain('busyText');
    expect(source).toContain('eventPush');
  });

  it('shared css carries both themes and both feature sections', async () => {
    const css = await fs.readFile(path.join(panelPublicDir(), 'style.css'), 'utf8');
    expect(css).toContain('theme-lyx');
    expect(css).toContain('.vcs-warn');
    expect(css).toContain('.modal-backdrop');
    expect(css).toContain('.install-btn');
  });

  it('shared index.html carries both apps\' optional elements (hidden)', async () => {
    const html = await fs.readFile(path.join(panelPublicDir(), 'index.html'), 'utf8');
    expect(html).toContain('id="vcs-warn"');
    expect(html).toContain('id="save-consent-backdrop"');
    expect(html).toContain('id="install-btn"');
    expect(html).toContain('id="bridge-spinner"');
  });

  it('index references the boot script; the boot script carries token + config + theme', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'panel-index-'));
    await fs.writeFile(path.join(dir, 'index.html'), '<html><head></head><body></body></html>', 'utf8');
    const app = express();
    app.get('/', createPanelIndexHandler(dir, { token: 'tok-123', config: testConfig }));
    app.get('/panel-boot.js', createPanelBootScript({ token: 'tok-123', config: testConfig }));
    const server = app.listen(0, '127.0.0.1');
    await new Promise<void>((r) => server.on('listening', r));
    const port = (server.address() as { port: number }).port;
    try {
      const html = await (await fetch(`http://127.0.0.1:${port}/`)).text();
      // CSP-safe: an EXTERNAL script (the tight CSP blocks inline ones).
      expect(html).toContain('<script src="/panel-boot.js"></script>');
      expect(html).not.toContain('window.__ACP_TOKEN__');
      const boot = await (await fetch(`http://127.0.0.1:${port}/panel-boot.js`)).text();
      expect(boot).toContain('window.__ACP_TOKEN__ = "tok-123"');
      expect(boot).toContain('"appName":"TestEditor"');
      expect(boot).toContain('classList.add("theme-test")');
    } finally {
      server.close();
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('omits the theme class when config.theme is null', async () => {
    const boot = createPanelBootScript({ token: 'tok', config: { ...testConfig, theme: null } });
    const app = express();
    app.get('/panel-boot.js', boot);
    const server = app.listen(0, '127.0.0.1');
    await new Promise<void>((r) => server.on('listening', r));
    const port = (server.address() as { port: number }).port;
    try {
      const js = await (await fetch(`http://127.0.0.1:${port}/panel-boot.js`)).text();
      expect(js).not.toContain('classList.add');
    } finally {
      server.close();
    }
  });
});
