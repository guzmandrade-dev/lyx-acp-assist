/**
 * Persisted agent settings (agent-settings.json) + the GET/PUT
 * /api/settings/agent routes. The settings live server-side because the
 * companion's port is random per launch — localStorage (origin-scoped)
 * would not survive a restart.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import type express from 'express';
import type { AgentSettings } from './types.js';

/** The app-level async error wrapper (see each app's createServer). */
export type WrapFn = (
  handler: (req: express.Request, res: express.Response) => Promise<unknown>,
) => (req: express.Request, res: express.Response) => void;

export interface AgentSettingsStore {
  /** Path of the persisted settings file (null when not configured). */
  settingsFile: string | null;
  /** Read the persisted settings ({} when absent or unreadable). */
  read: () => Promise<Partial<AgentSettings>>;
  /** Register GET/PUT /api/settings/agent on the given Express app. */
  register: (app: express.Express, wrap: WrapFn) => void;
}

export function createAgentSettings(settingsDir: string | undefined): AgentSettingsStore {
  const settingsFile = settingsDir
    ? path.join(settingsDir, 'agent-settings.json')
    : null;

  async function read(): Promise<Partial<AgentSettings>> {
    if (!settingsFile) return {};
    try {
      const raw = JSON.parse(await fs.readFile(settingsFile, 'utf8'));
      return raw && typeof raw === 'object' ? (raw as Partial<AgentSettings>) : {};
    } catch {
      return {};
    }
  }

  function register(app: express.Express, wrap: WrapFn): void {
    app.get('/api/settings/agent', (_req, res) => {
      read()
        .then((s) => res.json(s))
        .catch(() => res.json({}));
    });

    app.put(
      '/api/settings/agent',
      wrap(async (req, res) => {
        const s = readAgentSettingsBody(req.body);
        if (!settingsFile) {
          // No persistence configured (tests): echo back, nothing is stored.
          res.json(s);
          return;
        }
        await fs.mkdir(settingsDir!, { recursive: true });
        const previous = await read();
        const merged = { ...previous, ...s };
        await fs.writeFile(settingsFile, JSON.stringify(merged, null, 2), 'utf8');
        res.json(merged);
      }),
    );
  }

  return { settingsFile, read, register };
}

/** Validate and normalize the JSON body of PUT /api/settings/agent. */
export function readAgentSettingsBody(body: unknown): Partial<AgentSettings> {
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  const out: Partial<AgentSettings> = {};
  if (typeof b.command === 'string') out.command = b.command.trim();
  if (typeof b.args === 'string') out.args = b.args.trim().split(/\s+/).filter(Boolean);
  else if (Array.isArray(b.args)) {
    out.args = b.args.filter((a): a is string => typeof a === 'string' && a.trim().length > 0);
  }
  if (b.env && typeof b.env === 'object') {
    out.env = Object.fromEntries(
      Object.entries(b.env as Record<string, unknown>).filter(
        (e): e is [string, string] => typeof e[1] === 'string',
      ),
    );
  }
  return out;
}