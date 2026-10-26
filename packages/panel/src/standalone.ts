/**
 * Shared standalone dev entry (audit Track C): the two apps' standalone.ts
 * differed only in the server construction and the companion-record
 * writer. Serves the panel + API on a dynamic port (PORT overrides),
 * used for development and for driving the app end-to-end from
 * scripts/tools without the Electron shell.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type express from 'express';
import { panelPublicDir } from './index.js';

export interface StandaloneServerOptions {
  /** App name for the boot log line. */
  appName: string;
  /** Dev data dir name (os.tmpdir()/<name>) for history/attachments/logs/settings. */
  dataDirName: string;
  /** Build the app's Express server (dev paths provided). */
  createServer: (paths: {
    publicDir: string;
    assetsDir?: string;
    dataDir: string;
    historyDir: string;
    attachmentsDir: string;
    logDir: string;
    settingsDir: string;
  }) => express.Express;
  /** Per-app asset overrides (logo.svg); passed through to createServer. */
  assetsDir?: string;
  /** Write the companion discovery record once listening. */
  writeRecord: (info: { url: string; port: number; token: string; dataDir: string }) => Promise<void>;
  /** Optional cleanup on Ctrl+C / SIGTERM (e.g. remove the record). */
  removeRecord?: () => Promise<void>;
}

export function createStandaloneServer(options: StandaloneServerOptions): void {
  const publicDir = panelPublicDir();
  if (!fs.existsSync(path.join(publicDir, 'index.html'))) {
    throw new Error(`panel public dir not found at ${publicDir}`);
  }
  const dataDir = path.join(os.tmpdir(), options.dataDirName);
  const server = options.createServer({
    publicDir,
    assetsDir: options.assetsDir,
    dataDir,
    historyDir: path.join(dataDir, 'history'),
    attachmentsDir: path.join(dataDir, 'attachments'),
    logDir: path.join(dataDir, 'logs'),
    settingsDir: dataDir,
  });

  const port = process.env.PORT ? Number.parseInt(process.env.PORT, 10) : 0;
  const httpServer = server.listen(port, '127.0.0.1', () => {
    const address = httpServer.address();
    const actual = typeof address === 'object' && address ? address.port : port;
    console.log(`${options.appName} ACP Assist dev server at http://127.0.0.1:${actual}`);
    options
      .writeRecord({
        url: `http://127.0.0.1:${actual}`,
        port: actual,
        token: (server.locals.apiToken as string) ?? '',
        dataDir,
      })
      .catch(() => undefined);
  });

  /** Best-effort record removal on Ctrl+C / SIGTERM. */
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      httpServer.close();
      (options.removeRecord ? options.removeRecord() : Promise.resolve())
        .catch(() => undefined)
        .finally(() => process.exit(0));
    });
  }
}
