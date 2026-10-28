/**
 * Textclass layout discovery: parse a textclass's .layout file (and its
 * Input include chain) so the agent only ever sees real layout names of
 * the document's class (Beamer, journal classes, ...).
 */
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { discoverLyxEnvironment } from '../lyxserver/pipe-config.js';

/**
 * Results are memoized per class: layout files never change mid-session,
 * and the read chain (up to 4-deep Input includes) ran on every prompt
 * build and every continuation step.
 */
const classLayoutsCache = new Map<string, string[] | null>();

/**
 * Candidate layout directories, version-agnostic (the list
 * used to pin `LyX 2.5`): the user's own layouts dir (via the same
 * version-globbing discovery as the pipe config), then every installed
 * `LyX*` under Program Files (newest version first), then Linux paths.
 * LYX_LAYOUTS_DIR always wins.
 */
function layoutDirCandidates(): string[] {
  const candidates: string[] = [];
  if (process.env.LYX_LAYOUTS_DIR) candidates.push(process.env.LYX_LAYOUTS_DIR);
  if (process.platform === 'win32') {
    const env = discoverLyxEnvironment();
    if (env.userDir) candidates.push(path.join(env.userDir, 'layouts'));
    const programDirs = [process.env.ProgramFiles ?? 'C:\\Program Files', process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)'];
    for (const root of programDirs) {
      try {
        const installs = fsSync
          .readdirSync(root)
          .filter((name) => /^LyX \d+(\.\d+)*$/i.test(name))
          .sort((a, b) => compareLyxDirsDesc(a, b));
        for (const install of installs) {
          candidates.push(path.join(root, install, 'Resources', 'layouts'));
        }
      } catch {
        /* that Program Files root does not exist */
      }
    }
  } else {
    candidates.push(path.join(os.homedir(), '.lyx', 'layouts'));
  }
  candidates.push('/usr/share/lyx/layouts', '/usr/local/share/lyx/layouts');
  return [...new Set(candidates)];
}

/** Sort helper: "LyX 2.5" > "LyX 2.4.1" > "LyX 2.4". */
function compareLyxDirsDesc(a: string, b: string): number {
  const ver = (s: string) => (s.match(/\d+(?:\.\d+)*/g)?.[0] ?? '').split('.').map(Number);
  const va = ver(a);
  const vb = ver(b);
  for (let i = 0; i < Math.max(va.length, vb.length); i++) {
    const d = (vb[i] ?? 0) - (va[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/**
 * Layout names defined by a LyX textclass, parsed from its .layout file.
 * Search order: the user's LyX layouts dir (custom/journal classes), then
 * the installation's Resources (article, beamer, ...), then common Linux
 * paths. Returns null when the class file cannot be found.
 */
export async function findClassLayouts(textclass: string): Promise<string[] | null> {
  const safeClass = textclass.replace(/[^\w.-]+/g, '');
  if (!safeClass) return null;
  if (classLayoutsCache.has(safeClass)) return classLayoutsCache.get(safeClass) ?? null;
  for (const dir of layoutDirCandidates()) {
    const names = await collectStyles(path.join(dir, `${safeClass}.layout`), dir, 0);
    if (names) {
      classLayoutsCache.set(safeClass, names);
      return names;
    }
  }
  classLayoutsCache.set(safeClass, null);
  return null;
}

/**
 * Parse Style names out of a .layout/.inc file, following `Input <file>`
 * includes (e.g. article.layout Inputs stdsections.inc for Section etc.).
 * Returns null if the file itself cannot be read.
 */
async function collectStyles(file: string, dir: string, depth: number): Promise<string[] | null> {
  let raw: string;
  try {
    raw = await fs.readFile(file, 'utf8');
  } catch {
    return null;
  }
  const names = new Set<string>();
  const includes: string[] = [];
  for (const m of raw.matchAll(/^(Input|Include)\s+(\S+)[^\r\n]*$/gm)) {
    if (m[2]) includes.push(m[2]);
  }
  for (const m of raw.matchAll(/^Style\s+(\S[^\r\n]*?)\s*$/gm)) {
    if (m[1]) names.add(m[1].trim());
  }
  if (depth < 4) {
    for (const inc of includes) {
      // Input targets usually already carry the extension (stdclass.inc);
      // some don't. Try as-is, then with the common extensions.
      for (const candidate of [inc, `${inc}.inc`, `${inc}.layout`]) {
        const sub = await collectStyles(path.join(dir, candidate), dir, depth + 1);
        if (sub) {
          for (const n of sub) names.add(n);
          break;
        }
      }
    }
  }
  return [...names];
}