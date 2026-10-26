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
 * Phase B2 (audit Track D): the session lifecycle, shared routes, and the
 * multi-action message loop live in core `createCompanionServer`; this
 * file is the app's `CompanionBackend` — the pipe + clipboard + verified
 * paste choreographies, the save-consent gate, and the LyX-only
 * markup-retry (VRP) step.
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
  splitTopLevelLayouts,
  normalizeMarkupBlock,
  findMarkupProblems,
  type DocumentContext,
} from './lyx/context.js';
import { CHAT_KNOWLEDGE } from './lyx/knowledge.js';
import { discoverLyxEnvironment } from './lyxserver/pipe-config.js';
import { TIMINGS } from './timings.js';
import {
  UNSAVED_KEY,
  createParseActionTag,
  createAttachmentExtractor,
  createCompanionServer,
  createWrap,
  isVersionControlled,
  buildAttachmentBlock,
  formatHistoryReplay as coreFormatHistoryReplay,
  listKnownDocuments as coreListKnownDocuments,
  MAX_ACTIONS_PER_MESSAGE,
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
   * Audit B4: restores the user's pre-run clipboard text at the end of a
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
   * Track C: one panel, config-injected.
   */
  publicDir?: string;
  /**
   * Per-app asset overrides served BEFORE the shared panel dir (e.g. the
   * app's own logo.svg).
   */
  assetsDir?: string;
  /** Panel config (Track C): injected into the served index.html. */
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
   * API bearer token (audit B1). Generated at boot when absent; exposed as
   * `app.locals.apiToken` for the record writers / dev tools.
   */
  apiToken?: string;
  /**
   * Idle-session GC (audit B2): sessions with no activity for this long
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
      await session.ensureConversation( path);
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
        // Audit B4: the clipboard is both write channel and verification
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
     * The LyX-only VRP step: validate the ```lyx markup and, when it has
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
            // Same budget as the main prompt (audit B8: this call had NO
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
      // Audit B4: best-effort restore of the user's pre-run clipboard
      // text; a no-op until readStep(1) saved something.
      await session.state.restoreClipboard();
    },
  };
}

// --- agent action parsing / prompt building -------------------------------

type AgentAction =
  | 'none'
  | 'continue'
  | 'insert'
  | 'insert-top'
  | 'insert-after'
  | 'insert-before'
  | 'rewrite'
  | 'rewrite-at'
  | 'delete-at'
  | 'merge'
  | 'move';

interface ActionOutcome {
  action: AgentAction;
  body: string | null;
  /** Paragraph address [pN] for rewrite-at / insert-after. */
  target: number | null;
  /** Destination address [pM] for move (0 = top of the document). */
  target2: number | null;
  /** Raw tag text when a near-miss tag (typo, missing colon) was
   *  auto-corrected by the tolerant parser; null when the tag was
   *  canonical or no tag matched. */
  tagNote?: string | null;
}

/**
 * Extract the trailing [ACTION: ...] tag and the ```lyx block from a reply.
 * The header tolerates tag typos ("[AACTION:", doubled letters) and a
 * missing colon — tagNote reports the auto-correction. The regex itself
 * is assembled by the core factory (see parseTag below).
 */

/**
 * Grammar: [ACTION: name pN (to )?pM] — the LyX vocabulary with two
 * paragraph targets (move). The B5 layered resolution and capture
 * extraction live in the core factory.
 */
const parseTag = createParseActionTag({
  actions: 'continue|merge|move|delete-at|rewrite-at|insert-before|insert-after|insert-top|rewrite|insert|none',
  targetPattern: '(?:\\s+p(\\d+))?',
  target2Pattern: '(?:\\s+(?:to\\s+)?p(\\d+))?',
});

export function parseAction(reply: string): ActionOutcome {
  const tag = parseTag(reply);
  const action = tag.action as AgentAction;
  const target = tag.target !== null ? Number.parseInt(tag.target, 10) : null;
  const target2 = tag.target2 !== null ? Number.parseInt(tag.target2, 10) : null;
  // `continue` is accepted for forward-compatibility but is not a document
  // edit: the server's multi-action loop drives continuations itself.
  const body = action === 'none' || action === 'continue' ? null : extractBodyLayouts(reply);
  const canonical =
    `[ACTION: ${action}${target !== null ? ` p${target}` : ''}${target2 !== null ? ` p${target2}` : ''}]`;
  // "move p3 to p5" is accepted grammar, not a typo: compare with the
  // optional "to" stripped so it is not reported as an auto-correction.
  const tagNote =
    tag.rawTag !== null && tag.rawTag.replace(/\s+to\s+/i, ' ') !== canonical ? tag.rawTag : null;
  return { action, body, target, target2, tagNote };
}

/** Describe one applied step compactly for the next continuation prompt. */
export function describeAction(outcome: ActionOutcome): string {
  const parts: string[] = [outcome.action];
  if (outcome.target !== null) parts.push(`p${outcome.target}`);
  if (outcome.target2 !== null) parts.push(`p${outcome.target2}`);
  return `[ACTION: ${parts.join(' ')}]`;
}

/**
 * Continuation prompt after a successfully applied edit. The document was
 * just edited, so the fresh context below has the NEW paragraph numbering;
 * the agent must not reuse addresses from before the edit.
 */
export function buildContinuationPrompt(
  contextText: string,
  selection: { hasSelection: boolean; lyxBody: string | null; text: string | null; layout: string | null },
  originalMessage: string,
  completed: string[],
): string {
  const parts = [
    'You are continuing the SAME user request after one edit was applied ' +
      'to the live LyX document. The document context below is FRESH: ' +
      'paragraph addresses ([pN]) may have shifted because of the edit.',
    '',
    'Original user request:', originalMessage,
    '',
    'Edits already applied (do not repeat them):',
    ...completed.map((entry) => `- ${entry}`),
    '',
    'If the request needs MORE edits, END your reply with exactly one ' +
      'document action tag from the action list (rewrite-at, insert-after, ' +
      'insert-before, insert-top, insert, rewrite, delete-at, merge, move) ' +
      'on its own last line, and include the ```lyx block when the action ' +
      'needs content.',
    `If the request is now complete, or you need the user to answer a ` +
      `question, reply in prose only and end with [ACTION: none].`,
    `If you are not sure whether more edits remain, ask one short question ` +
      `with [ACTION: none] instead of guessing.`,
    `The app enforces a safety limit of ${MAX_ACTIONS_PER_MESSAGE} document ` +
      `edits per user message; if that limit is reached it stops and tells ` +
      `the user, who can ask you to continue in a follow-up message.`,
    '',
    CHAT_KNOWLEDGE,
    '',
    contextText,
  ];
  if (selection.hasSelection) {
    parts.push(
      '',
      `Current LyX selection (cursor paragraph layout: ${selection.layout ?? 'unknown'}):`,
      '```lyx',
      selection.lyxBody ?? selection.text ?? '',
      '```',
    );
  }
  return parts.join('\n');
}

/**
 * Format the leading `unseen` turns of a conversation for replay into an
 * agent prompt: one compact line per turn (roles swapped to User/You),
 * action outcomes as short parenthetical notes, whitespace collapsed and
 * each turn truncated to HISTORY_REPLAY_CHAR_LIMIT. Pure and exported for
 * tests. `unseen` is the number of leading turns the agent has not seen
 * (restored from persisted history after an app restart); later turns
 * were produced live by this same agent process and are skipped.
 */
/** Replay rendering shared by the history wrapper and the conversation store. */
const LYX_REPLAY_OPTIONS = {
  blockPattern: /```lyx[\s\S]*?```/g,
  describeTarget: (m: TurnMeta) =>
    `${m.target ? ` p${m.target}` : ''}${m.target2 ? ` p${m.target2}` : ''}`,
};

export function formatHistoryReplay(turns: Turn[], unseen: number): string {
  return coreFormatHistoryReplay(turns, unseen, LYX_REPLAY_OPTIONS);
}

export function buildAutoPrompt(
  contextText: string,
  selection: {
    hasSelection: boolean;
    lyxBody: string | null;
    text: string | null;
    layout: string | null;
  },
  message: string,
  attachments: Attachment[] = [],
  historyPrefix = '',
): string {
  const parts: string[] = [
    'You are assisting an author writing a document in LyX. Your reply is shown ' +
      'in a chat panel, and you can also write content directly into the live ' +
      'LyX document.',
    '',
    'Decide yourself what the user wants, and END your reply with exactly one ' +
      'of these action tags on its own last line:',
    '- [ACTION: none] to reply in prose only (questions, explanations, ' +
      'discussion, outlines, planning).',
    '- [ACTION: insert] to insert NEW content at the CURSOR (its current ' +
      'position, which you do not control): include a ```lyx fenced block. ' +
      'CAREFUL: the paste happens INSIDE the cursor\'s paragraph, so the ' +
      'first pasted paragraph merges into it and takes that paragraph\'s ' +
      'layout — only use this when the user clearly wants the content at ' +
      'the cursor.',
    '- [ACTION: insert-top] to insert NEW content at the VERY BEGINNING of ' +
      'the document (titles, abstracts, anything that belongs above the ' +
      'first paragraph): include a ```lyx fenced block.',
    '- [ACTION: insert-after pN] to insert NEW content as its own ' +
      'paragraph(s) right AFTER paragraph [pN] from the outline (use this ' +
      'when the user asks to add a section/paragraph to the document and ' +
      'the position follows from the outline): include a ```lyx fenced block.',
    '- [ACTION: insert-before pN] to insert NEW content as its own ' +
      'paragraph(s) right BEFORE paragraph [pN] from the outline (e.g. an ' +
      'intro paragraph in front of [pN], or a heading above [pN]; use ' +
      'insert-top for the very beginning of the document): include a ```lyx ' +
      'fenced block.',
    '- [ACTION: rewrite] to REPLACE the currently selected text (given ' +
      'below): include a ```lyx fenced block with the complete replacement.',
    '- [ACTION: delete-at pN] to DELETE the entire paragraph [pN] from the ' +
      'outline (use when the user asks to remove a specific paragraph): ' +
      'NO fenced block, just the tag.',
    '- [ACTION: merge pN pM] to merge two ADJACENT paragraphs [pN] and ' +
      '[pM] into ONE paragraph (M must be N+1; the merged paragraph keeps ' +
      '[pN]\'s layout): NO fenced block, just the tag. To SPLIT one ' +
      'paragraph instead, use [ACTION: rewrite-at pN] with two (or more) ' +
      '```lyx paragraphs in the fenced block — the paragraph is replaced ' +
      'by them, splitting it at the point you choose.',
    '- [ACTION: move pN pM] to MOVE the entire paragraph [pN] so it ends ' +
      'up right AFTER paragraph [pM] (p0 = the very top of the document; ' +
      'use when the user asks to reorder or move a paragraph): NO fenced ' +
      'block, just the tag. N and M are original outline numbers; the app ' +
      'adjusts for the removal. Moving pN after p(N-1) changes nothing, ' +
      'so never emit that.',
    '- [ACTION: rewrite-at pN] to REPLACE the entire paragraph [pN] from ' +
      'the outline (use this when the user asks to modify, fix or remove ' +
      'content in a specific paragraph and nothing is selected): include a ' +
      '```lyx fenced block with the complete replacement paragraph(s).', +
      ' When one request needs SEVERAL edits, apply the FIRST edit now and ' +
      'let the app ask you again with fresh paragraph numbers for the next ' +
      'one — do not try to plan later edits against the current outline.',
    '',
    'Rules for document actions:',
    '- The ```lyx block must contain just the \\begin_layout ... \\end_layout ' +
      'paragraphs (no document header).',
    '- Follow the .lyx cheat-sheet below (token-format emphasis, Formula ' +
      'insets, ...).',
    '- Match the document\'s own conventions: prefer layouts that appear in ' +
      'the outline or in the class layout list of the document context, ' +
      'never invent layout names.',
    '- For a document title or similar front matter use the Title layout ' +
      'and [ACTION: insert-top], NOT insert (insert would land wherever ' +
      'the cursor happens to be).',
    '- For rewrite: output the complete replacement, preserving references, ' +
      'labels and citations unless asked otherwise.',
    '- If nothing is selected you cannot rewrite; choose insert, ' +
      'insert-top, or none.',
    '- The action tag must be the very last line of your reply.',
    '',
    CHAT_KNOWLEDGE,
    '',
    contextText,
  ];
  if (selection.hasSelection) {
    parts.push(
      '',
      `Current LyX selection (cursor paragraph layout: ${selection.layout ?? 'unknown'}). ` +
        'The user may ask you to rewrite it:',
      '```lyx',
      selection.lyxBody ?? selection.text ?? '',
      '```',
    );
  }
  if (historyPrefix) parts.push(historyPrefix);
  parts.push('', 'User message:', message);
  parts.push(...buildAttachmentBlock(attachments));
  return parts.join('\n');
}

/**
 * Best-effort text/markdown extraction for an uploaded attachment:
 * text formats are read directly; binary formats (PDF, DOCX, XLSX, ...)
 * go through the markitdown CLI when it is installed (see
 * @acp-assist/core for the converter chain).
 */
export const extractAttachmentText = createAttachmentExtractor({
  extensions: [
    'txt', 'md', 'markdown', 'tex', 'lyx', 'csv', 'tsv', 'json', 'xml',
    'bib', 'sty', 'cls', 'log', 'htm', 'html', 'yaml', 'yml', 'py', 'js', 'ts',
  ],
  envVar: 'LYX_MARKITDOWN',
});

/** Corrective retry prompt when the ```lyx block has markup problems. */
function buildMarkupRetryPrompt(action: AgentAction, problems: string[]): string {
  return (
    `Your [ACTION: ${action}] content had problems and must be re-written in ` +
    'valid LyX internal format (.lyx):\n' +
    problems.map((p) => `- ${p}`).join('\n') +
    '\n\nReference example of valid .lyx body markup with emphasis:\n' +
    '```lyx\n\\begin_layout Standard\n\\emph on\nFuture work\n\\emph default\n' +
    ' will explore larger datasets.\n\\end_layout\n```\n' +
    'Math uses \\begin_inset Formula $x^2$\\end_inset. ' +
    'Do NOT use LaTeX inline commands like \\emph{...}.\n' +
    'Reply again with ONLY the corrected ```lyx fenced block ' +
    '(just \\begin_layout...\\end_layout paragraphs, no header), followed by ' +
    `the same action tag [ACTION: ${action}] on its own last line.`
  );
}

/**
 * Normalize text for the paragraph-targeting comparison. Only letters and
 * digits survive (case-insensitive): the .lyx file stores straight quotes
 * and ASCII dashes, while LyX's clipboard text export uses typographic
 * ones, so any punctuation- or whitespace-sensitive comparison would
 * spuriously fail on the same paragraph.
 */
export function normalizeForCompare(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Fuzzy paragraph-targeting match. LyX's UnicodeText export differs from
 * the file's text in ways we cannot normalize away: layout environment
 * labels are prepended ("Abstract", "Summary"), and math insets render
 * inline ($P$ -> "P") while the parser preview has no inset content. So
 * instead of a strict prefix compare, we slide overlapping windows over
 * the expected text and require most of them to appear in the actual
 * text. A genuinely different paragraph (disjoint text) still fails.
 */
export function isLikelyMatch(expected: string, actual: string): boolean {
  if (expected === '') return actual === '';
  const e = expected.slice(0, 160);
  const a = actual.slice(0, 400);
  const WIN = 16;
  const STRIDE = 12;
  let total = 0;
  let hits = 0;
  for (let i = 0; i + WIN <= e.length; i += STRIDE) {
    total++;
    if (a.includes(e.slice(i, i + WIN))) hits++;
  }
  if (total === 0) return a.startsWith(e);
  return hits / total >= 0.6;
}

/**
 * Structure-vs-structure paragraph verification (2026-10-10 refactor).
 *
 * The old check compared our parsed preview against LyX's RENDERED
 * UnicodeText clipboard export — two representations that can never fully
 * agree (math renders differently, typographic quotes, layout-label
 * prefixes, invisible inset properties), so formula-heavy paragraphs
 * failed targeting on the RIGHT paragraph. Now `copy` puts the raw
 * `application/x-lyx` payload of the selection on the clipboard, and we
 * compare markup against markup:
 *
 * 1. 'markup' — exact (whitespace-insensitive) comparison of the
 *    payload's first top-level layout block against the saved file's
 *    block at `index`. Lossless: formulas, notes, refs compare exactly.
 * 2. 'preview' — if LyX re-serialized the copy cosmetically, parse the
 *    payload with OUR parser and fuzzy-match its preview against the
 *    outline preview (both sides from the same parser — the rendered-
 *    text quirks are gone from the comparison).
 * 3. 'text' — legacy last resort when the clipboard holds no x-lyx
 *    payload: the old UnicodeText fuzzy match.
 */
export interface ParagraphSelectionInput {
  /** Raw .lyx clipboard payload of the copied selection, or null. */
  payload: string | null;
  /** UnicodeText clipboard flavor, used only when payload is null. */
  clipboardText: string | null;
  /** The SAVED .lyx file content (the walk addresses against the file). */
  diskRaw: string;
  /** 0-based index of the target paragraph. */
  index: number;
  /** Outline preview of the target paragraph (expected text). */
  expectedPreview: string;
}

export interface ParagraphVerification {
  ok: boolean;
  /** How the match succeeded: 'markup' | 'preview' | 'text' | 'none'. */
  via: 'markup' | 'preview' | 'text' | 'none';
  /** Normalized text of what was actually found (for the error message). */
  actual: string;
}

export function verifyParagraphSelection(
  input: ParagraphSelectionInput,
): ParagraphVerification {
  const expected = normalizeForCompare(input.expectedPreview);

  if (input.payload) {
    const diskBlocks = splitTopLevelLayouts(extractBodyLayouts(input.diskRaw) ?? '');
    const payloadBlocks = splitTopLevelLayouts(extractBodyLayouts(input.payload) ?? '');
    const diskBlock = diskBlocks[input.index] ?? null;
    const payloadBlock = payloadBlocks[0] ?? null;
    if (diskBlock && payloadBlock) {
      if (normalizeMarkupBlock(payloadBlock) === normalizeMarkupBlock(diskBlock)) {
        return { ok: true, via: 'markup', actual: expected };
      }
    }
    // Same-parser fuzzy fallback: tolerates cosmetic re-serialization by
    // LyX, still rejects a genuinely different paragraph.
    let payloadPreview = '';
    try {
      const payloadCtx = buildDocumentContext(input.payload);
      payloadPreview = payloadCtx.outline[0]?.preview ?? '';
    } catch {
      payloadPreview = '';
    }
    const actual = normalizeForCompare(payloadPreview);
    if (payloadPreview && isLikelyMatch(expected, actual)) {
      return { ok: true, via: 'preview', actual };
    }
    return {
      ok: false,
      via: 'none',
      actual: actual || normalizeForCompare(input.payload),
    };
  }

  const actual = normalizeForCompare(input.clipboardText ?? '');
  if (isLikelyMatch(expected, actual)) {
    return { ok: true, via: 'text', actual };
  }
  return { ok: false, via: 'none', actual };
}

/**
 * Layout names defined by a LyX textclass, parsed from its .layout file.
 * Search order: the user's LyX layouts dir (custom/journal classes), then
 * the installation's Resources (article, beamer, ...), then common Linux
 * paths. Returns null when the class file cannot be found.
 *
 * Results are memoized per class: layout files never change mid-session,
 * and the read chain (up to 4-deep Input includes) ran on every prompt
 * build and every continuation step.
 */
const classLayoutsCache = new Map<string, string[] | null>();

/**
 * Candidate layout directories, version-agnostic (audit B10 — the list
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
// (unsaved buffer; audit B10 reviewed the pinning: LyX UPGRADES older
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

