/**
 * Express API + session orchestration for the LyX ACP companion app.
 *
 * One session = one running LyX instance + one ACP agent. The LyXServer
 * pipe follows LyX's ACTIVE view, so documents are tracked dynamically:
 * every request re-reads `server-get-filename`, conversations are keyed
 * per document path, and the client can list/switch documents. All
 * document reads go through the pipe + the saved `.lyx` file; all writes
 * go through the pipe (`paste` via the `application/x-lyx` clipboard).
 *
 * The session lifecycle, shared routes, and the
 * multi-action message loop live in core `createCompanionServer`; this
 * file is the app's `CompanionBackend` — the pipe + clipboard + verified
 * paste choreographies, the save-consent gate, and the LyX-only
 * markup-retry step.
 */

import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { LyxServerClient, LyxPipeError, createWriteOnlyFallbacks } from './lyxserver/client.js';
import type { RawClipboard } from './clipboard/lyx-clipboard.js';
import { LyxClipboard } from './clipboard/lyx-clipboard.js';
import {
  buildDocumentContext,
  renderOutline,
  assemblePasteDocument,
  extractBodyLayouts,
  findMarkupProblems,
  type DocumentContext,
} from './lyx/context.js';
import { discoverLyxEnvironment } from './lyxserver/pipe-config.js';
import { TIMINGS } from './timings.js';
import { parseAction, describeAction, type ActionOutcome } from './lyx/actions.js';
import {
  buildAutoPrompt,
  buildContinuationPrompt,
  buildMarkupRetryPrompt,
  extractAttachmentText,
  formatHistoryReplay,
  LYX_REPLAY_OPTIONS,
} from './lyx/prompts.js';
import { verifyParagraphSelection, normalizeForCompare } from './lyx/verification.js';
import { findClassLayouts } from './lyx/layouts.js';
import {
  UNSAVED_KEY,
  createCompanionServer,
  createWrap,
  isVersionControlled,
  listKnownDocuments as coreListKnownDocuments,
  pollUntil,
  type AppliedResult,
  type CompanionBackend,
  type CompanionSession,
  type ReadStepResult,
} from '@acp-assist/core';
import { panelPublicDir, type PanelConfig } from '@acp-assist/panel';
import type {
  AgentRunner,
  AgentSettings,
  Attachment,
  Turn,
  TurnMeta,
} from '@acp-assist/core';

export type {
  AgentSettings,
  Turn,
  TurnMeta,
  AgentRunner,
  Attachment,
} from '@acp-assist/core';

// Re-exported for the app's tests and dev tools; the implementations live
// in their focused modules under src/lyx/.
export {
  parseAction,
  describeAction,
  type ActionOutcome,
  buildAutoPrompt,
  buildContinuationPrompt,
  formatHistoryReplay,
  extractAttachmentText,
  normalizeForCompare,
  isLikelyMatch,
  verifyParagraphSelection,
  type ParagraphSelectionInput,
  type ParagraphVerification,
  findClassLayouts,
} from './lyx/index.js';


/**
 * Documents with a body larger than this attach only their outline to
 * prompts; the agent then reads/searches the saved file with its own
 * tools (lazy fetch, like a coding agent in a repository).
 */
const OUTLINE_ONLY_BODY_LIMIT = 16_000;

/** Parsed document snapshot (see LyxState.docSnapshot). */
export interface DocumentSnapshot {
  path: string;
  mtimeMs: number;
  raw: string;
  ctx: DocumentContext;
}


/**
 * The app backend's per-session state (opaque to the core server): the
 * pipe client (with write-only fallbacks), the clipboard adapter, the
 * active document path, the parsed document snapshot cache, and the
 * save-consent set.
 */
export interface LyxState {
  lyx: LyxServerClient;
  clipboard: LyxClipboard;
  /** Active document path, refreshed from LyX on every request. */
  documentPath: string | null;
  /**
   * Parsed document snapshot, cached per (path, mtimeMs). One request
   * parses the document ONCE: every save() bumps the file's mtime, so the
   * snapshot invalidates itself whenever the document actually changed
   * (see readDocumentSnapshot). Previously each step parsed the file
   * 3-4 times (context build, paragraph walk, verification, header).
   */
  docSnapshot?: DocumentSnapshot | null;
  /**
   * Document paths whose save conditions the user accepted this session
   * (save-consent gate; only asked for documents outside version control).
   */
  saveConsent: Set<string>;
  /**
   * Restores the user's pre-run clipboard text at the end of a
   * message run; a no-op until readStep(1) saves the text (the choreography
   * clobbers the clipboard on every edit).
   */
  restoreClipboard: () => Promise<void>;
}

/** One step's data: the context block + selection read for that step. */
interface LyxStepData {
  contextText: string;
  selection: {
    hasSelection: boolean;
    lyxBody: string | null;
    text: string | null;
    layout: string | null;
  };
}

export interface ServerOptions {
  /**
   * The SHARED panel package's public dir (defaults to panelPublicDir()).
   * One panel for both apps, config-injected.
   */
  publicDir?: string;
  /**
   * Per-app asset overrides served BEFORE the shared panel dir (e.g. the
   * app's own logo.svg).
   */
  assetsDir?: string;
  /** Panel config injected into the served index.html. */
  panelConfig: PanelConfig;
  clipboard: RawClipboard;
  /** Directory for persisted chat history (per document). Optional. */
  historyDir?: string;
  /** Directory where uploaded attachments are stored. Optional. */
  attachmentsDir?: string;
  /** Directory for the persistent error log (errors.log). Optional. */
  logDir?: string;
  /**
   * Directory for UI settings persisted across runs (agent-settings.json).
   * Optional; when absent the settings routes return defaults.
   */
  settingsDir?: string;
  /**
   * API bearer token. Generated at boot when absent; exposed as
   * `app.locals.apiToken` for the record writers / dev tools.
   */
  apiToken?: string;
  /**
   * Idle-session GC: sessions with no activity for this long
   * are torn down (agent process + pipe client included) — an F5 or
   * crash-reload of the panel otherwise orphans them forever. Default
   * 30 minutes; the sweep interval is idleMs/10.
   */
  sessionIdleMs?: number;
}


export function createServer(options: ServerOptions & {
  /** Test hook: inject a fake agent process instead of spawning one. */
  agentFactory?: (settings: AgentSettings) => AgentRunner;
  /** Test hook: inject a fake LyXServerClient instead of the real pipe. */
  lyxFactory?: () => LyxServerClient;
}) {
  return createCompanionServer({
    panelConfig: options.panelConfig,
    publicDir: options.publicDir ?? panelPublicDir(),
    assetsDir: options.assetsDir,
    historyDir: options.historyDir,
    attachmentsDir: options.attachmentsDir,
    logDir: options.logDir,
    settingsDir: options.settingsDir,
    apiToken: options.apiToken,
    sessionIdleMs: options.sessionIdleMs,
    extractText: extractAttachmentText,
    backend: createLyxBackend(options),
    agentFactory: options.agentFactory,
    extraRoutes: (app, ctx) => {
      // --- save consent ------------------------------------------------------
      /**
       * Record that the user accepted the conditions for saving a document
       * that lives outside version control (asked once per document path,
       * per session; see the gate in readStep). The disk save itself is
       * only performed by the message flow, so consent is purely a
       * session-state flag.
       */
      app.post(
        '/api/session/:id/save-consent',
        ctx.wrap(async (req, res) => {
          const session = ctx.getSession(req.params['id']);
          const docPath = (req.body?.path as string | undefined)?.trim();
          if (!docPath) {
            res.status(400).json({ error: 'path is required' });
            return;
          }
          session.state.saveConsent.add(docPath);
          res.json({ ok: true, path: docPath });
        }),
      );
    },
  });
}

/**
 * The LyX backend: pipe + clipboard + verified paste choreographies
 * behind the core contract. The helper functions below are the
 * pre-B2-lift server's helpers, operating on the core session whose
 * `state` carries this app's per-session data.
 */
function createLyxBackend(
  options: ServerOptions & {
    agentFactory?: (settings: AgentSettings) => AgentRunner;
    lyxFactory?: () => LyxServerClient;
  },
): CompanionBackend<LyxState, ActionOutcome> {

  // --- helpers -----------------------------------------------------------



  /** Re-read the active document path from LyX and track it. */
  async function refreshActiveDocument(session: CompanionSession<LyxState>): Promise<string | null> {
    const path = await session.state.lyx.getFilename();
    session.state.documentPath = path;
    if (path) {
      session.knownDocuments.add(path);
      await session.ensureConversation(path);
    } else {
      await session.ensureConversation( UNSAVED_KEY);
    }
    return path;
  }

  function conversationKey(session: CompanionSession<LyxState>): string {
    return session.state.documentPath ?? UNSAVED_KEY;
  }

  /**
   * Get (creating if needed) the conversation for a key and remember how many
   * of its turns came from persisted history on disk. The in-memory list is
   * what the agent is told about (see buildHistoryPrefix): the agent keeps
   * its own context within a session, so replaying history it already saw
   * would only eat context — but after an app restart (or a reconnect) the
   * agent is a fresh process with NO memory, and it must be briefed on the
   * turns it missed. Awaits the persisted history load so callers
   * (sessionInfo) never observe a half-loaded turn list — the
   * fire-and-forget version raced and returned empty history.
   */












  /**
   * Save the buffer AND invalidate the document snapshot: the file is
   * about to change on disk, and filesystem timestamps can be too coarse
   * (same-tick writes) to detect rapid successive saves via mtime alone.
   */
  async function saveDocument(session: CompanionSession<LyxState>): Promise<void> {
    session.state.docSnapshot = null;
    await session.state.lyx.save();
  }

  /**
   * Read + parse the active document ONCE per (path, mtime): the snapshot
   * is cached on the session and re-read only when the file changed on
   * disk. Every app-driven save invalidates it explicitly (see
   * saveDocument); mtime covers external changes. stat() is cheap; the
   * full read + parse is what we avoid repeating 3-4 times per step.
   */
  async function readDocumentSnapshot(session: CompanionSession<LyxState>): Promise<DocumentSnapshot> {
    const filePath = session.state.documentPath;
    if (!filePath) throw new Error('Document is not saved on disk.');
    let mtimeMs: number;
    try {
      mtimeMs = (await fs.stat(filePath)).mtimeMs;
    } catch {
      throw new Error(`Cannot read ${filePath}`);
    }
    const cached = session.state.docSnapshot;
    if (cached && cached.path === filePath && cached.mtimeMs === mtimeMs) {
      return cached;
    }
    const raw = await fs.readFile(filePath, 'utf8');
    const snapshot: DocumentSnapshot = {
      path: filePath,
      mtimeMs,
      raw,
      ctx: buildDocumentContext(raw),
    };
    session.state.docSnapshot = snapshot;
    return snapshot;
  }

  async function readDocumentContext(session: CompanionSession<LyxState>) {
    return (await readDocumentSnapshot(session)).ctx;
  }

  async function currentHeader(session: CompanionSession<LyxState>): Promise<string | null> {
    try {
      // Reuses the session's document snapshot (see readDocumentSnapshot).
      const ctx = await readDocumentContext(session);
      return ctx.header || null;
    } catch {
      return null;
    }
  }

  async function buildContextBlock(session: CompanionSession<LyxState>): Promise<string> {
    try {
      const [ctx, layout] = await Promise.all([
        readDocumentContext(session),
        session.state.lyx.getLayout(),
      ]);
      const head =
        `Document context\n` +
        `================\n` +
        `File: ${session.state.documentPath}\n` +
        `Text class: ${ctx.textclass ?? 'unknown'}\n` +
        `LyX format: ${ctx.formatVersion ?? 'unknown'}\n` +
        `Cursor paragraph layout: ${layout || 'unknown'}\n\n` +
        `Document outline ([pN] ids address paragraphs):\n${renderOutline(ctx.outline)}\n\n`;
      let contextText = head;
      const classLayouts = ctx.textclass ? await findClassLayouts(ctx.textclass) : null;
      if (classLayouts) {
        contextText +=
          `Layouts defined by the document class "${ctx.textclass}" ` +
          `(use these names, or ones already in the outline, for new content):\n` +
          classLayouts.join(', ') + '\n\n';
      }
      if (ctx.body.length <= OUTLINE_ONLY_BODY_LIMIT) {
        // Small document: attach the full body for maximum fidelity.
        return contextText + `Full body (.lyx markup):\n${ctx.body}\n`;
      }
      // Large document: outline only. The agent reads/searches the saved
      // file itself with its own tools (like a coding agent in a repo).
      return (
        contextText +
        `The document is LARGE (${ctx.body.length} chars), so only the outline above is\n` +
        `attached. To see the exact text of any paragraph, read or search the saved\n` +
        `file "${session.state.documentPath}" with your file tools — it is the exact live\n` +
        `document, and it was saved moments ago. The [pN] ids correspond to the\n` +
        `\\begin_layout blocks of the body in document order (inset inner layouts count\n` +
        `too), so you can locate paragraph [pN] by counting \\begin_layout occurrences.\n`
      );
    } catch (e) {
      return (
        `Document context\n================\nFile: ${session.state.documentPath ?? UNSAVED_KEY}\n` +
        `No .lyx file context available (document unsaved?): ${(e as Error).message}\n`
      );
    }
  }

  async function readSelectionFor(session: CompanionSession<LyxState>) {
    const stats = await session.state.lyx.getSelectionStats();
    let hasSelection = stats[0] > 0;
    let lyxBody: string | null = null;
    let text: string | null = null;
    let layout: string | null = null;
    if (hasSelection) {
      const copied = await session.state.lyx.copySelection();
      if (copied) {
        // Wait until the x-lyx payload lands on the clipboard (the copy
        // LFUN is dispatched asynchronously in LyX's event loop).
        const doc = await pollUntil(() => session.state.clipboard.readLyxDocument(), {
          timeoutMs: TIMINGS.clipboardPayloadPollMs,
          intervalMs: TIMINGS.pollIntervalMs,
        });
        if (doc) {
          lyxBody = extractBodyLayouts(doc) ?? doc;
          text = await session.state.clipboard.readText();
        }
      } else {
        // Stats claimed a selection but LyX refused to copy (stale/weird
        // state); report no selection instead of trusting a stale clipboard.
        hasSelection = false;
      }
      layout = await session.state.lyx.tryRequest('server-get-layout');
    }
    return { hasSelection, stats, lyxBody, text, layout };
  }

  /**
   * Position the cursor for a paragraph-addressed action, with target
   * verification (copy + normalized comparison against the outline
   * preview — a mis-targeted paste never happens; on mismatch we return
   * an error and nothing is pasted):
   * - mode 'rewrite': the whole paragraph [pN] stays SELECTED, so the
   *   subsequent paste replaces it.
   * - mode 'insert-after': the selection is collapsed to the paragraph's
   *   end and a fresh empty paragraph is created BELOW [pN], so the paste
   *   lands in it with its own layout (never merges into [pN]).
   */
  async function gotoParagraph(
    session: CompanionSession<LyxState>,
    target: number | null,
    mode: 'rewrite' | 'insert-after',
  ): Promise<{ target: number | null; error: string | null; payload: string | null }> {
    if (!target || target < 1) {
      return {
        target,
        error: `Agent chose an addressed action without a valid paragraph number.`,
        payload: null,
      };
    }
    const fail = async (error: string): Promise<{ target: number | null; error: string; payload: null }> => {
      // Our paragraph-select may have selected the wrong paragraph; a
      // selection persists in LyX and would pollute later commands.
      await session.state.lyx.clearSelection();
      return { target, error, payload: null };
    };
    let ctx;
    let raw: string;
    try {
      // One parse per step: the snapshot cache means the context build and
      // the header read of the same step reuse this parse.
      const snap = await readDocumentSnapshot(session);
      raw = snap.raw;
      ctx = snap.ctx;
    } catch (e) {
      return fail(`Cannot address paragraphs: ${(e as Error).message}`);
    }
    const entry = ctx.outline[target - 1];
    if (!entry) {
      return fail(`Paragraph [p${target}] does not exist (document has ${ctx.outline.length}).`);
    }
    const moved = await session.state.lyx.beginOfDocument();
    if (!moved) return fail('buffer-begin failed.');
    let ok = true;
    for (let i = 1; i < target && ok; i++) ok = await session.state.lyx.paragraphDown();
    if (!ok) {
      return fail(`Could not reach paragraph [p${target}] (paragraph-down failed).`);
    }
    const selected = await session.state.lyx.paragraphSelect();
    if (!selected) return fail('paragraph-select failed.');
    // Verify the target against the SAVED file: copy the selection and
    // compare its raw .lyx markup with the file's paragraph (see
    // verifyParagraphSelection — a mis-targeted paste never happens).
    const copied = await session.state.lyx.copySelection();
    if (!copied) {
      return fail('Could not copy the selected paragraph for verification.');
    }
    const payload = await pollUntil(() => session.state.clipboard.readLyxDocument(), {
      timeoutMs: TIMINGS.clipboardPayloadPollMs,
      intervalMs: TIMINGS.pollIntervalMs,
    });
    const clipboardText = payload === null ? await session.state.clipboard.readText() : null;
    const verify = verifyParagraphSelection({
      payload,
      clipboardText,
      diskRaw: raw,
      index: target - 1,
      expectedPreview: entry.preview,
    });
    if (!verify.ok) {
      return fail(
        `Paragraph targeting failed: [p${target}] should start with ` +
          `"${normalizeForCompare(entry.preview).slice(0, 60)}\u2026" but the cursor landed on ` +
          `"${verify.actual.slice(0, 60)}\u2026". Nothing was pasted.`,
      );
    }
    if (mode === 'insert-after') {
      // Collapse the selection to the end of [pN] and break a fresh empty
      // paragraph below it; the paste then merges into that empty
      // paragraph and keeps its own layout.
      const collapsed = await session.state.lyx.collapseSelectionForward();
      if (!collapsed) {
        return fail(`Could not move the cursor to the end of [p${target}].`);
      }
      const broke = await session.state.lyx.breakParagraph();
      if (!broke) {
        return fail(`Could not create a new paragraph below [p${target}].`);
      }
    }
    return { target, error: null, payload };
  }

  /**
   * Merge paragraph [pN] with [p(N+1)] into one paragraph (the user-quoted
   * M must equal N+1 — only adjacent paragraphs can merge). Choreography:
   * gotoParagraph(pN) selects and verifies it, the selection is collapsed
   * to the paragraph's end, then `char-delete-forward` deletes the
   * paragraph break so [p(N+1)]'s text is appended into [pN]. The merged
   * paragraph keeps [pN]'s layout; one undo reverts the merge.
   */
  async function mergeParagraph(
    session: CompanionSession<LyxState>,
    n: number | null,
    m: number | null,
  ): Promise<{ target2: number | null; error: string | null }> {
    const fail = (error: string): { target2: number | null; error: string } => ({
      target2: m,
      error,
    });
    if (!n || n < 1) {
      return fail('Agent chose [ACTION: merge] without a valid first paragraph number.');
    }
    if (m === null || m !== n + 1) {
      return fail(
        '[ACTION: merge pN pM] requires two ADJACENT paragraphs (M = N+1). ' +
          'Merge the pair one at a time.',
      );
    }
    let ctx;
    try {
      ctx = await readDocumentContext(session);
    } catch (e) {
      return fail(`Cannot address paragraphs: ${(e as Error).message}`);
    }
    if (n >= ctx.outline.length) {
      return fail(
        `Paragraph [p${n + 1}] does not exist (document has ${ctx.outline.length}).`,
      );
    }
    const gotoResult = await gotoParagraph(session, n, 'rewrite');
    if (gotoResult.error) return fail(gotoResult.error);
    const collapsed = await session.state.lyx.collapseSelectionForward();
    if (!collapsed) {
      return fail(`Could not move the cursor to the end of paragraph [p${n}].`);
    }
    const merged = await session.state.lyx.mergeWithNextParagraph();
    if (!merged) {
      return fail(`LyX could not merge paragraph [p${n}] with [p${m}].`);
    }
    return { target2: m, error: null };
  }

  /**
   * Move paragraph [pN] to the position right after paragraph [pM]
   * (pM = 0 -> the very top). Verified choreography:
   * 1. gotoParagraph(pN) selects and verifies it; the verification copy
   *    leaves its x-lyx payload on the clipboard, which we capture.
   * 2. Delete [pN] with the delete-at choreography.
   * 3. Re-save the buffer so the .lyx file on disk matches the shrunken
   *    document — gotoParagraph verifies destinations against the FILE,
   *    and a stale file would mis-target the paste.
   * 4. Walk to the adjusted destination (M >= N -> M-1 after removal)
   *    and paste the captured paragraph there (insert-after / insert-top
   *    choreographies keep its layout).
   */
  async function moveParagraph(
    session: CompanionSession<LyxState>,
    from: number | null,
    to: number | null,
  ): Promise<{ target2: number | null; error: string | null }> {
    const fail = (error: string): { target2: number | null; error: string } => ({
      target2: to,
      error,
    });
    if (!from || from < 1) {
      return fail('Agent chose [ACTION: move] without a valid source paragraph number.');
    }
    if (to === null || to < 0) {
      return fail('Agent chose [ACTION: move] without a valid destination paragraph number (p0 = top).');
    }
    let ctx;
    try {
      ctx = await readDocumentContext(session);
    } catch (e) {
      return fail(`Cannot address paragraphs: ${(e as Error).message}`);
    }
    const count = ctx.outline.length;
    if (from > count) {
      return fail(`Paragraph [p${from}] does not exist (document has ${count}).`);
    }
    if (to > count) {
      return fail(`Destination [p${to}] does not exist (document has ${count}).`);
    }
    // Already in place: moving pN after itself or after its predecessor
    // is a no-op — report success without touching the document.
    if (to === from || to === from - 1) return { target2: to, error: null };

    // 1. Select + verify [pN]; the verification copy leaves its x-lyx on
    //    the clipboard (gotoParagraph captured the payload).
    const gotoResult = await gotoParagraph(session, from, 'rewrite');
    if (gotoResult.error) return fail(gotoResult.error);
    const copied = gotoResult.payload ?? (await session.state.clipboard.readLyxDocument());
    const body = copied ? extractBodyLayouts(copied) : null;
    if (!body) {
      await session.state.lyx.clearSelection();
      return fail(`Could not read paragraph [p${from}] from the clipboard; nothing was moved.`);
    }

    // 2. Delete [pN].
    const deleted = await session.state.lyx.deleteSelection();
    if (!deleted) {
      await session.state.lyx.clearSelection();
      return fail(`LyX could not delete paragraph [p${from}]; nothing was moved.`);
    }
    await session.state.lyx.mergeAwayParagraph();

    // 3. Keep the file on disk in sync (see the doc comment).
    await saveDocument(session);

    // 4. Position at the adjusted destination, then paste.
    const dest = to === 0 ? 0 : to < from ? to : to - 1;
    if (dest === 0) {
      const moved = await session.state.lyx.beginOfDocument();
      if (!moved) return fail('Could not move the cursor to the start of the document (buffer-begin failed).');
      // buffer-begin lands INSIDE the first paragraph; break first so the
      // paste lands in a fresh empty paragraph and keeps its layout.
      const broke = await session.state.lyx.breakParagraph();
      if (!broke) return fail('Could not create a paragraph at the top of the document.');
    } else {
      const gotoDest = await gotoParagraph(session, dest, 'insert-after');
      if (gotoDest.error) return fail(gotoDest.error);
    }
    if (session.cancelRequested) {
      return fail('Cancelled before the paste; the paragraph was deleted — undo in LyX to restore it.');
    }
    const header = (await currentHeader(session)) ?? FALLBACK_HEADER;
    const doc = assemblePasteDocument(header, body);
    const written = await session.state.clipboard.writeLyxDocumentVerified(doc, body);
    if (!written) {
      return fail(
        'The .lyx payload could not be written to the clipboard; the paragraph ' +
          'was deleted but not re-inserted. Undo in LyX to restore it.',
      );
    }
    // The clipboard write above is verified by read-back, so the payload is
    // already globally visible — no settle wait is needed before the paste.
    await session.state.lyx.paste();
    return { target2: to, error: null };
  }

  return {
    acp: { appName: 'lyx-acp-assist', writerName: 'LyX' },
    mapStatus: (err) => (err instanceof LyxPipeError ? 503 : 500),
    promptTimeoutMs: TIMINGS.promptTimeoutMs,
    replayOptions: LYX_REPLAY_OPTIONS,

    async createSessionState({ knownDocuments }) {
      // Tests may inject a fake LyX pipe client so the whole multi-action
      // loop can be exercised without live processes. The write-only
      // fallback's filename resolution sees the session's known-documents
      // set grow over its lifetime (same set instance).
      const lyx = options.lyxFactory
        ? options.lyxFactory()
        : new LyxServerClient({
            fallbacks: createWriteOnlyFallbacks(options.clipboard, () => knownDocuments),
          });
      await lyx.start();
      if (lyx.mode === 'write-only') {
        console.warn(
          'LyXServer pipe is deaf (LyX resets every .out connection; see ' +
            'AGENTS.md "Live-test debugging trail"). Running in write-only ' +
            'fallback mode: commands work, replies are substituted from ' +
            'the window title, session file, and clipboard.',
        );
      }
      return {
        lyx,
        clipboard: new LyxClipboard(options.clipboard),
        documentPath: null,
        docSnapshot: null,
        saveConsent: new Set(),
        restoreClipboard: async () => {},
      };
    },

    teardownSession(state) {
      state.lyx.stop();
    },

    conversationKey(session) {
      return session.state.documentPath ?? UNSAVED_KEY;
    },

    async statusSummary() {
      const probe = new LyxServerClient();
      return { lyxPipeAvailable: probe.isAvailable() };
    },

    async documents(session) {
      const active = await refreshActiveDocument(session);
      return {
        active,
        versionControlled: active ? await isVersionControlled(active) : null,
        documents: [...session.knownDocuments],
      };
    },

    /**
     * Switch LyX's active tab/window to the given document (it must be
     * already open). The pipe has no "list buffers" LFUN, so switching is
     * done via file-open, which activates an already-open buffer.
     */
    async switchDocument(session, target) {
      await session.state.lyx.request('file-open', target);
      // Wait until LyX actually switched (bounded poll instead of a fixed
      // sleep); on timeout we fall through and report whatever is active.
      await pollUntil(async () => (await session.state.lyx.getFilename()) === target, {
        timeoutMs: TIMINGS.documentSwitchPollMs,
        intervalMs: 50,
      });
      const active = await refreshActiveDocument(session);
      return {
        active,
        versionControlled: active ? await isVersionControlled(active) : null,
        documents: [...session.knownDocuments],
      };
    },

    async selection(session) {
      return await readSelectionFor(session);
    },

    async undo(session) {
      await refreshActiveDocument(session);
      await session.state.lyx.undo();
      return { ok: true };
    },

    async sessionInfo(session, opts) {
      const docPath = await refreshActiveDocument(session);
      let outline = '';
      let layout = '';
      try {
        layout = await session.state.lyx.getLayout();
        if (opts.outline) {
          const ctx = await readDocumentContext(session);
          outline = renderOutline(ctx.outline);
        }
      } catch {
        /* document may be unsaved; outline unavailable */
      }
      return {
        sessionId: session.id,
        documentPath: docPath,
        documents: [...session.knownDocuments],
        versionControlled: docPath ? await isVersionControlled(docPath) : null,
        layout,
        outline,
        lyxMode: session.state.lyx.mode,
        conversation: session.conversations.get(session.state.documentPath ?? UNSAVED_KEY) ?? [],
      };
    },

    async readStep(session, step): Promise<ReadStepResult<LyxStepData>> {
      await refreshActiveDocument(session);
      if (step === 1) {
        // Save-consent gate: the save below overwrites the file on disk
        // with the assistant's edits. In a VCS working tree the previous
        // state is recoverable; outside one it is not, so the user must
        // have accepted that condition for THIS document path first
        // (modal in the panel UI; the client retries after POSTing
        // /save-consent).
        const docPath = session.state.documentPath;
        if (
          docPath &&
          !(await isVersionControlled(docPath)) &&
          !session.state.saveConsent.has(docPath)
        ) {
          return {
            blocked: {
              status: 409,
              body: {
                error: 'This document is not under version control. Accept that the assistant saves changes to the file before sending a message.',
                code: 'save-consent-required',
                documentPath: docPath,
              },
            },
          };
        }
        // Read path per architecture: save the buffer first so the outline
        // and body parsed from disk match the live document. Only for saved
        // buffers — buffer-write on an untitled buffer opens a Save As
        // dialog.
        if (session.state.documentPath) await saveDocument(session);
        // The clipboard is both write channel and verification
        // channel — every choreography clobbers the user's clipboard. Save
        // the pre-run TEXT flavor (non-text flavors cannot be preserved by
        // the adapter) and restore it when the run ends (see afterRun).
        const savedClipboardText = await session.state.clipboard.readText().catch(() => '');
        session.state.restoreClipboard = async () => {
          await session.state.clipboard.writeText(savedClipboardText).catch(() => {
            /* restoration is best-effort; never break the stream */
          });
        };
      } else {
        if (session.state.documentPath) await saveDocument(session);
      }
      const contextText = await buildContextBlock(session);
      const selection = await readSelectionFor(session);
      return { data: { contextText, selection } };
    },

    async buildAutoPrompt(_session, stepData, message, attachments, historyPrefix) {
      const s = stepData as LyxStepData;
      return buildAutoPrompt(s.contextText, s.selection, message, attachments, historyPrefix);
    },

    async buildContinuationPrompt(_session, stepData, originalMessage, completed) {
      const s = stepData as LyxStepData;
      return buildContinuationPrompt(s.contextText, s.selection, originalMessage, completed);
    },

    parseAction(_session, reply) {
      return parseAction(reply);
    },

    /**
     * The LyX-only markup step: validate the ```lyx markup and, when it has
     * problems, prompt the agent once with a corrective retry. Returns
     * the reply to record and re-parse (the retried one when it ran).
     */
    async retryReply(session, outcome, reply, send, step) {
      if (!session.cancelRequested && outcome.action !== 'none' && outcome.action !== 'continue' && outcome.body) {
        const problems = findMarkupProblems(outcome.body);
        if (problems.length > 0) {
          const retry = buildMarkupRetryPrompt(outcome.action, problems);
          return await session.agent.prompt(session.id, [{ type: 'text', text: retry }], {
            onChunk: (chunk) => send({ text: `\n${chunk}`, ...(step > 1 ? { step } : {}) }),
            onToolCall: (tool) => send({ tool }),
            // Same budget as the main prompt (this call originally had NO
            // timeoutMs, so a stuck retry could hang the stream).
            timeoutMs: TIMINGS.promptTimeoutMs,
          });
        }
      }
      return reply;
    },

    async applyAction(session, outcome, stepData, step): Promise<AppliedResult> {
      const selection = (stepData as LyxStepData).selection;
      const fail = (error: string): AppliedResult => ({ ok: false, error, description: '' });

      if (outcome.action === 'delete-at') {
        // Delete needs no ```lyx block: walk, verify, select, delete the
        // text, then merge the leftover empty paragraph away.
        const gotoResult = await gotoParagraph(session, outcome.target, 'rewrite');
        if (gotoResult.error) return fail(gotoResult.error);
        const deleted = await session.state.lyx.deleteSelection();
        if (!deleted) {
          return fail(`LyX could not delete paragraph [p${outcome.target}].`);
        }
        await session.state.lyx.mergeAwayParagraph();
        return {
          ok: true,
          description: describeAction(outcome),
          target: outcome.target,
          target2: outcome.target2,
        };
      }
      if (outcome.action === 'merge') {
        // Merge needs no ```lyx block: walk + verify + collapse to the end
        // of [pN], then delete-forward merges [p(N+1)] into it.
        const result = await mergeParagraph(session, outcome.target, outcome.target2);
        if (result.error) return fail(result.error);
        return {
          ok: true,
          description: describeAction(outcome),
          target: outcome.target,
          target2: outcome.target2,
        };
      }
      if (outcome.action === 'move') {
        // Move needs no ```lyx block: capture the paragraph via the
        // clipboard, delete it, then re-paste at the adjusted destination.
        const result = await moveParagraph(session, outcome.target, outcome.target2);
        if (result.error) return fail(result.error);
        return {
          ok: true,
          description: describeAction(outcome),
          target: outcome.target,
          target2: outcome.target2,
        };
      }

      // A write action: position the cursor, then paste.
      if (!outcome.body) {
        return fail(`Agent chose [ACTION: ${outcome.action}] but returned no \`\`\`lyx block.`);
      }
      let positionError: string | null = null;
      let target = outcome.target;
      if (outcome.action === 'rewrite' && !selection.hasSelection) {
        positionError = 'Agent chose [ACTION: rewrite] but LyX has no active selection.';
      } else if (outcome.action === 'insert' && selection.hasSelection) {
        // A selection is active: paste would REPLACE it. The agent chose
        // plain insert, not rewrite — collapse the selection so the
        // user's text survives and the paste lands at the cursor.
        await session.state.lyx.collapseSelection();
      } else if (outcome.action === 'insert-top') {
        const moved = await session.state.lyx.beginOfDocument();
        if (!moved) {
          positionError = 'Could not move the cursor to the start of the document (buffer-begin failed).';
        } else {
          // buffer-begin lands INSIDE the first paragraph: a paste there
          // would merge into it and drop the pasted layout. Break the
          // paragraph first so the paste lands in a fresh empty paragraph.
          await session.state.lyx.breakParagraph();
        }
      } else if (outcome.action === 'rewrite-at') {
        const gotoResult = await gotoParagraph(session, outcome.target, 'rewrite');
        target = gotoResult.target;
        positionError = gotoResult.error;
      } else if (outcome.action === 'insert-after') {
        const gotoResult = await gotoParagraph(session, outcome.target, 'insert-after');
        target = gotoResult.target;
        positionError = gotoResult.error;
      } else if (outcome.action === 'insert-before') {
        // Insert-before pN = insert-after p(N-1), reusing the fully
        // verified insert-after choreography (walk, verify, collapse,
        // break a fresh paragraph). For p1 it degenerates to the
        // insert-top choreography; the reported target stays pN.
        if (outcome.target === 1) {
          const moved = await session.state.lyx.beginOfDocument();
          if (!moved) {
            positionError = 'Could not move the cursor to the start of the document (buffer-begin failed).';
          } else {
            await session.state.lyx.breakParagraph();
          }
        } else {
          const gotoResult = await gotoParagraph(session, (outcome.target ?? 0) - 1, 'insert-after');
          positionError = gotoResult.error;
        }
      }
      if (positionError) return fail(positionError);
      const header = (await currentHeader(session)) ?? FALLBACK_HEADER;
      const doc = assemblePasteDocument(header, outcome.body);
      const written = await session.state.clipboard.writeLyxDocumentVerified(doc, outcome.body);
      if (!written) {
        return fail(
          'The .lyx payload could not be written to the clipboard; ' +
            'nothing was pasted. Please try again.',
        );
      }
      await session.state.lyx.paste(); // replaces the active selection if any
      return {
        ok: true,
        description: describeAction(outcome),
        target,
        target2: outcome.target2,
      };
    },

    frame(_session, ctx) {
      const stepField = ctx.step > 1 ? { step: ctx.step } : {};
      switch (ctx.kind) {
        case 'afterParse':
          // Near-miss action tags (typos like "[AACTION:") are
          // auto-corrected by the tolerant parser; tell the panel so the
          // user sees it.
          return ctx.outcome.tagNote ? { tagNote: ctx.outcome.tagNote, ...stepField } : null;
        case 'none':
          return { action: 'none', ...stepField };
        case 'applied': {
          const outcome = ctx.outcome;
          return {
            applied: outcome.action,
            target: ctx.applied?.target ?? outcome.target ?? null,
            ...(outcome.target2 !== null && outcome.target2 !== undefined
              ? { target2: outcome.target2 }
              : {}),
            ...stepField,
          };
        }
        case 'appliedStep':
          return {
            appliedStep: ctx.step,
            action: ctx.outcome.action,
            target: ctx.applied?.target ?? ctx.outcome.target ?? null,
            target2: ctx.applied?.target2 ?? ctx.outcome.target2 ?? null,
          };
      }
    },

    metaExtras(_session, outcome) {
      return { target2: outcome.target2 };
    },

    async afterRun(session) {
      // Best-effort restore of the user's pre-run clipboard
      // text; a no-op until readStep(1) saved something.
      await session.state.restoreClipboard();
    },
  };
}

// --- history persistence ---------------------------------------------------

/**
 * Document paths that have persisted chat history, for seeding the document
 * selector on a fresh session. The LyXServer pipe has no "list open
 * buffers" LFUN, so this is the only way to show other tabs after an app
 * restart. Skips the unsaved pseudo-key and paths that no longer exist on
 * disk (file-open on a stale path would reopen or fail in LyX).
 */
export async function listKnownDocuments(historyDir: string): Promise<string[]> {
  return coreListKnownDocuments(historyDir, {
    exists: async (key) => {
      try {
        await fs.access(key);
        return true;
      } catch {
        return false;
      }
    },
  });
}

/** Minimal header used when the document has never been saved. */
// Paste-document header when the real document header is unavailable
// (unsaved buffer; LyX UPGRADES older
// \lyxformat documents on read, so a slightly older pinned format is
// safe across future LyX versions — no discovery needed).
const FALLBACK_HEADER = [
  '#LyX 2.5 created this file. For more info see https://www.lyx.org/',
  '\\lyxformat 643',
  '\\begin_document',
  '\\begin_header',
  '\\textclass article',
  '\\use_default_options true',
  '\\language american',
  '\\end_header',
].join('\n');

