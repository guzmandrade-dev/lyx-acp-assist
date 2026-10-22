/**
 * Shared session-attachment routes (upload as base64 + drop before send).
 * The heavy lifting of text extraction comes from each app's
 * `extractText` (see attachments.ts for the converter chain).
 */

import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type express from 'express';
import type { AgentRunner, Attachment } from './types.js';
import type { WrapFn } from './settings.js';

/** Minimal session surface the shared lifecycle routes need. */
export interface SessionLike {
  id: string;
  agent: AgentRunner;
  cancelRequested: boolean;
}

export interface SessionRoutesOptions<T extends SessionLike> {
  /** The app's session lookup (throws for unknown ids). */
  getSession: (id: string) => T;
  /** The app's session map (entries are removed on teardown). */
  sessions: Map<string, T>;
  /** App-specific GET response body for the session info. */
  sessionInfo: (session: T) => Promise<unknown>;
  /** Extra teardown before the agent process is stopped (e.g. pipe stop). */
  teardown?: (session: T) => void;
}

export function registerSessionRoutes<T extends SessionLike>(
  app: express.Express,
  wrap: WrapFn,
  options: SessionRoutesOptions<T>,
): void {
  app.get(
    '/api/session/:id',
    wrap(async (req, res) => {
      const session = options.getSession(String(req.params['id']));
      res.json(await options.sessionInfo(session));
    }),
  );

  /** Tear down a session: stop the agent process (+ optional extras). */
  app.delete(
    '/api/session/:id',
    wrap(async (req, res) => {
      const session = options.getSession(String(req.params['id']));
      options.sessions.delete(session.id);
      options.teardown?.(session);
      session.agent.stop();
      res.json({ ok: true });
    }),
  );

  /** Stop the current generation without tearing the session down. */
  app.post(
    '/api/session/:id/cancel',
    wrap(async (req, res) => {
      const session = options.getSession(String(req.params['id']));
      session.cancelRequested = true;
      session.agent.cancel(session.id);
      res.json({ ok: true });
    }),
  );
}

export interface AttachmentRoutesOptions {
  /** Directory where uploaded attachment files are stored. */
  attachmentsDir?: string;
  /** The app's session lookup (throws for unknown ids). */
  getSession: (id: string) => { attachments: Attachment[] };
  /** App-specific text extraction (its textual formats + env override). */
  extractText: (filePath: string, name: string) => Promise<string | null>;
}

export function registerAttachmentRoutes(
  app: express.Express,
  wrap: WrapFn,
  options: AttachmentRoutesOptions,
): void {
  app.post(
    '/api/session/:id/attachments',
    wrap(async (req, res) => {
      const session = options.getSession(String(req.params['id']));
      if (!options.attachmentsDir) throw new Error('Attachments are not configured.');
      const name = (req.body?.name as string | undefined)?.trim();
      const data = req.body?.data as string | undefined;
      if (!name || !data) {
        res.status(400).json({ error: 'name and data are required' });
        return;
      }
      await fs.mkdir(options.attachmentsDir, { recursive: true });
      const safe = name.replace(/[^\w.\- ]+/g, '_');
      const id = randomUUID();
      const filePath = path.join(options.attachmentsDir, `${id}-${safe}`);
      await fs.writeFile(filePath, Buffer.from(data, 'base64'));
      const text = await options.extractText(filePath, name);
      const att: Attachment = { id, name, path: filePath, text };
      session.attachments.push(att);
      res.json({ id, name, converted: text !== null });
    }),
  );

  /** Drop a pending attachment before it is sent. */
  app.delete(
    '/api/session/:id/attachments/:attId',
    wrap(async (req, res) => {
      const session = options.getSession(String(req.params['id']));
      const attId = String(req.params['attId'] ?? '');
      const idx = session.attachments.findIndex((a) => a.id === attId);
      if (idx >= 0) {
        const removed = session.attachments.splice(idx, 1);
        removed[0] && fs.unlink(removed[0].path).catch(() => undefined);
      }
      res.json({ ok: true });
    }),
  );
}