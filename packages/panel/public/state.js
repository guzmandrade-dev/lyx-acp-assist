'use strict';

// Shared panel state: the injected config, the DOM element references,
// and the mutable session/UI state both companion apps' panels run on.
// The `state` object exists so the modules under public/ can share
// mutable values without cycles of live bindings.

// --- panel config ------------------------------------------------------------
// Injected same-origin into index.html together with the API token (see
// @acp-assist/panel). Everything app-specific hangs off this object; the
// files below are shared verbatim by both companion apps.
//   appName:        'LyX' | 'LibreOffice' — user-facing strings
//   appTitle:       window/empty-state title
//   fenceRe:        fenced content-block language(s) the agent writes
//   statusKey:      /api/status field reporting the editor connection
//   statusMissing:  status line text when the editor is unreachable
//   cursorTerm:     'layout' (LyX) | 'style' (LibreOffice)
//   hasSaveConsent: LyX-only save-consent modal + VCS warning
//   hasInstallFlow: LO-only one-click bridge installer
//   composerRefreshSelection: refresh the selection on composer
//                   interaction (LO: yes; LyX: NO — the selection read
//                   clobbers the user's clipboard)
export const CONFIG = window.__ACP_PANEL_CONFIG__ ?? {};
export const APP = CONFIG.appName ?? 'LibreOffice';
export const FENCE_RE = CONFIG.fenceRe ?? '(?:writer|calc|impress)';
export const FENCE_STRIP_SRC = '```' + FENCE_RE + '\\s*\\n[\\s\\S]*?```\\s*';
export const FENCE_BLOCK_SRC = '```' + FENCE_RE + '\\s*\\n([\\s\\S]*?)```';

/**
 * Live-render throttle for streamed replies: re-rendering the WHOLE
 * accumulated reply on every {"text"} chunk is O(n²) over the stream, so
 * chunks coalesce into one full markdown render at most this often. Turn
 * boundaries (appliedStep / done) always render immediately and cancel
 * any pending throttled render. Indistinguishable from per-chunk
 * rendering in practice — chunks arrive faster than the eye can follow.
 */
export const LIVE_RENDER_MS = 100;

// --- DOM elements -------------------------------------------------------------

export const chat = document.getElementById('chat');
export const statusEl = document.getElementById('status');
export const statusText = document.getElementById('status-text');
export const docEl = document.getElementById('doc');
export const selectionEl = document.getElementById('selection');
export const docSelect = document.getElementById('doc-select');
export const editorSpinner = document.getElementById('bridge-spinner');
export const bridgeBusyText = document.getElementById('bridge-busy-text');
export const input = document.getElementById('input');
export const sendBtn = document.getElementById('send');
export const stopBtn = document.getElementById('stop');
export const undoBtn = document.getElementById('undo');
export const pinBtn = document.getElementById('pin');
export const reconnectBtn = document.getElementById('reconnect');
export const installBtn = document.getElementById('install-btn');
export const cmdEl = document.getElementById('agent-cmd');
export const attachBtn = document.getElementById('attach');
export const fileInput = document.getElementById('file-input');
export const chipsEl = document.getElementById('chips');
export const vcsWarnEl = document.getElementById('vcs-warn');
export const consentBackdrop = document.getElementById('save-consent-backdrop');
export const consentPathEl = document.getElementById('save-consent-path');
export const consentAcceptBtn = document.getElementById('save-consent-accept');
export const consentCancelBtn = document.getElementById('save-consent-cancel');
export const scrollTicks = document.getElementById('scroll-ticks');

// The "talking to the editor" label is per-app (panel config): the
// shared HTML ships a placeholder, the boot config overrides it.
if (bridgeBusyText && CONFIG.busyText) bridgeBusyText.textContent = CONFIG.busyText;

// --- mutable shared state -------------------------------------------------

export const state = {
  /** Active session id (null until the first connect succeeds). */
  sessionId: null,
  /** A generation is streaming (composer locked, Stop visible). */
  busy: false,
  /** The editor is blocked (e.g. a modal dialog is open). */
  bridgeBusy: false,
  /** The editor connection reported by /api/status. */
  bridgeAvailable: false,
  /** AbortController of the running stream. */
  currentAbort: null,
  /** The typing-indicator element (lazily created). */
  typingIndicator: null,
  /** When the current turn started (0 = no turn). */
  generationStart: 0,
  typingTimer: null,
  typingResumeTimer: null,
  /** Document path whose conversation is currently rendered in the chat. */
  chatDocKey: null,
  /** The empty-state element (recreated on demand). */
  emptyEl: document.getElementById('empty'),
  /** Auto-follow: pin the chat to the bottom unless the user scrolled up. */
  followChat: true,
  /** User-message elements currently shown as scroll ticks. */
  tickMsgs: [],
  /** Save-consent state (server-enforced; mirrored here to warn early). */
  activeDocPath: null,
  /** null = unknown/unsaved; otherwise whether the active doc is in a VCS. */
  docVersionControlled: null,
  /** Document paths the user already accepted this session (client mirror). */
  saveConsentPaths: new Set(),
  /** Resolver of the open save-consent modal, null while closed. */
  consentResolver: null,
  /** One-click bridge install in flight. */
  installBusy: false,
  /** Open "talking to the editor" requests (counter-based indicator). */
  bridgeRequestCount: 0,
  /** AbortController of the server-push event channel. */
  eventStreamController: null,
  eventRefreshTimer: null,
  editorContextRefreshTimer: null,
  /** Floating-on-top pin state. */
  followMode: false,
  /** Attachment ids waiting to be sent with the next message. */
  pendingAttachments: [],
};