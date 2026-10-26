/**
 * Version-control detection for the save-consent gate.
 *
 * The assistant saves the live document to disk on every message (so the
 * parsed file matches the buffer). In a VCS working tree that save has a
 * safety net: the previous state is recoverable. Outside any VCS an
 * overwrite is unrecoverable, so the server asks the user to accept that
 * condition once per document (see the save-consent routes in the apps'
 * server.ts; the LyX app uses this today, LibreOffice may gain
 * save-consent later).
 */

import fs from 'node:fs/promises';
import path from 'node:path';

/** Markers of a working tree, at any ancestor directory. `.git` is a
 *  FILE (not a directory) in linked worktrees, so a plain stat is enough. */
const VCS_MARKERS = ['.git', '.hg', '.svn'];

const controlledCache = new Map<string, boolean>();

async function hasMarker(dir: string): Promise<boolean> {
  for (const marker of VCS_MARKERS) {
    try {
      await fs.stat(path.join(dir, marker));
      return true;
    } catch {
      /* try the next marker */
    }
  }
  return false;
}

/**
 * True when the file lives inside a VCS working tree. Walks up from the
 * file's directory to the root; the walk result is cached per directory.
 */
export async function isVersionControlled(filePath: string): Promise<boolean> {
  let dir = path.dirname(filePath);
  for (;;) {
    const cached = controlledCache.get(dir);
    if (cached !== undefined) return cached;
    if (await hasMarker(dir)) {
      controlledCache.set(dir, true);
      return true;
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      controlledCache.set(dir, false);
      return false;
    }
    dir = parent;
  }
}