/**
 * Bearer-token auth for the companion Express API.
 *
 * The API binds to 127.0.0.1 on a random port, but that alone does not
 * make it private: any local process — or a DNS-rebinding web page, which
 * can send requests to localhost origins and needs no CORS to SEND —
 * could POST /api/session with an arbitrary agent `command` (spawning ANY
 * executable) and drive document edits. The bridge (acpbridge.py) already
 * works this way: random bearer token per process.
 *
 * Defenses here, shared by both companion apps:
 * - a random 256-bit bearer token, required on every /api request;
 * - a loopback Host header check (DNS-rebinding guard: a rebinding page
 *   resolves a public DNS name, so its Host is not 127.0.0.1);
 * - the token is delivered to the SAME-ORIGIN panel by injecting it into
 *   the served index.html — a cross-origin page can send requests but
 *   never READ the response (no CORS headers are emitted), so it cannot
 *   obtain the token;
 * - external tools (the LO sidebar status probe, dev scripts) read the
 *   token from the companion discovery record, which never leaves the
 *   user's own profile directory.
 */

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type express from 'express';

/** Random API bearer token (hex, 256 bits). */
export function generateApiToken(): string {
  return crypto.randomBytes(32).toString('hex');
}

/** Hostname portion of a Host header ("127.0.0.1:54321" -> "127.0.0.1"). */
export function hostnameOf(hostHeader: string): string {
  // Bracketed IPv6 forms keep their brackets ("[::1]:54321").
  if (hostHeader.includes(']')) return hostHeader.slice(0, hostHeader.indexOf(']') + 1);
  return hostHeader.split(':')[0] ?? '';
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

/**
 * Express middleware: reject non-loopback Host headers, then require the
 * bearer token. Mount AFTER the static panel assets, BEFORE the /api
 * routes.
 */
export function createApiAuthGuard(token: string): express.RequestHandler {
  return (req, res, next) => {
    const hostname = hostnameOf(String(req.headers.host ?? '')).toLowerCase();
    if (!LOOPBACK_HOSTS.has(hostname)) {
      res.status(403).json({ error: 'forbidden: non-loopback Host header' });
      return;
    }
    if (req.headers.authorization !== `Bearer ${token}`) {
      res.status(401).json({ error: 'unauthorized: API bearer token required' });
      return;
    }
    next();
  };
}

/** Companion discovery record shape (pid/port/url/exe + API token). */
export interface CompanionRecord {
  pid: number;
  port: number;
  url: string;
  /** Executable to launch for "open companion" (null in dev/browser mode). */
  exe: string | null;
  /** API bearer token — external probes read it from the record. */
  token: string;
}

/** Write a companion discovery record (best-effort, for shutdown too). */
export async function writeCompanionRecord(
  file: string,
  record: CompanionRecord,
): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(record, null, 2), 'utf8');
}

/** Remove a companion discovery record (best-effort, for shutdown). */
export async function removeCompanionRecord(file: string): Promise<void> {
  await fs.rm(file, { force: true }).catch(() => undefined);
}
