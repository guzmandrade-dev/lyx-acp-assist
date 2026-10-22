/**
 * Unit tests for the LyX environment discovery (src/lyxserver/pipe-config.ts):
 * preferences parsing, session-file parsing, window-title parsing, and
 * version-ordered discovery. Pure filesystem fixtures — runs on all platforms.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  parseServerPipe,
  parseSessionFilePaths,
  parseWindowTitle,
  discoverLyxEnvironment,
} from '../src/lyxserver/pipe-config.js';

describe('parseServerPipe', () => {
  it('extracts the \\serverpipe value', () => {
    const prefs = '# LyX preferences\n\\serverpipe "//./pipe/lyxpipe"\n\\other "x"\n';
    expect(parseServerPipe(prefs)).toBe('//./pipe/lyxpipe');
  });

  it('returns null when the setting is absent', () => {
    expect(parseServerPipe('\\other "x"\n')).toBeNull();
    expect(parseServerPipe('')).toBeNull();
  });
});

describe('parseSessionFilePaths', () => {
  it('returns last-opened (slot-ordered) then recent files', () => {
    const session = [
      '## Automatically generated lyx session file',
      '[recent files]',
      'C:/recent/one.lyx',
      'C:/recent/two.lyx',
      '[last opened files]',
      '2, C:/docs/b.lyx',
      '1, C:/docs/a.lyx',
      '[cursor positions]',
      '0, 0, C:/docs/a.lyx',
      '[bookmarks]',
    ].join('\n');
    expect(parseSessionFilePaths(session)).toEqual([
      'C:/docs/a.lyx',
      'C:/docs/b.lyx',
      'C:/recent/one.lyx',
      'C:/recent/two.lyx',
    ]);
  });

  it('is empty for a session without file sections', () => {
    expect(parseSessionFilePaths('[bookmarks]\n')).toEqual([]);
  });
});

describe('parseWindowTitle', () => {
  it('parses file name and directory hint', () => {
    expect(parseWindowTitle('sample.lyx (~\\Documents) - LyX')).toEqual({
      fileName: 'sample.lyx',
      dirHint: '~\\Documents',
    });
  });

  it('parses a title without a directory hint', () => {
    expect(parseWindowTitle('doc.lyx - LyX')).toEqual({ fileName: 'doc.lyx', dirHint: null });
  });

  it('returns null for a documentless window', () => {
    expect(parseWindowTitle('LyX')).toBeNull();
    expect(parseWindowTitle('')).toBeNull();
  });
});

describe('discoverLyxEnvironment', () => {
  it('prefers the newest LyX version with a \\serverpipe setting', () => {
    const appData = fs.mkdtempSync(path.join(os.tmpdir(), 'lyx-pipe-test-'));
    try {
      fs.mkdirSync(path.join(appData, 'LyX2.4'));
      fs.writeFileSync(path.join(appData, 'LyX2.4', 'preferences'), '\\serverpipe "//./pipe/old"');
      fs.mkdirSync(path.join(appData, 'LyX2.5'));
      fs.writeFileSync(path.join(appData, 'LyX2.5', 'preferences'), '\\serverpipe "//./pipe/lyxpipe"');
      const env = discoverLyxEnvironment({ appDataDir: appData });
      // On Windows the forward-slash form is normalized to the \\.\pipe\
      // Win32 namespace; elsewhere it is kept verbatim.
      const expected =
        process.platform === 'win32' ? '\\\\.\\pipe\\lyxpipe' : '//./pipe/lyxpipe';
      expect(env.pipeBase).toBe(expected);
      expect(env.userDir).toBe(path.join(appData, 'LyX2.5'));
    } finally {
      fs.rmSync(appData, { recursive: true, force: true });
    }
  });

  it('skips versions without the setting but still reports the newest user dir', () => {
    const appData = fs.mkdtempSync(path.join(os.tmpdir(), 'lyx-pipe-test-'));
    try {
      fs.mkdirSync(path.join(appData, 'LyX2.5'));
      fs.writeFileSync(path.join(appData, 'LyX2.5', 'preferences'), '\\other "x"');
      const env = discoverLyxEnvironment({ appDataDir: appData, homeDir: appData });
      if (process.platform === 'win32') expect(env.pipeBase).toBe('\\\\.\\pipe\\lyxpipe');
      else expect(env.pipeBase).toBe(`${appData}/.lyxpipe`);
      expect(env.userDir).toBe(path.join(appData, 'LyX2.5'));
    } finally {
      fs.rmSync(appData, { recursive: true, force: true });
    }
  });

  it('falls back to the platform default when nothing is configured', () => {
    const bogus = path.join(os.tmpdir(), 'no-such-dir-xyz');
    const env = discoverLyxEnvironment({ appDataDir: bogus, homeDir: bogus });
    if (process.platform === 'win32') expect(env.pipeBase).toBe('\\\\.\\pipe\\lyxpipe');
    else expect(env.pipeBase).toBe(`${bogus}/.lyxpipe`);
    expect(env.userDir).toBeNull();
  });
});