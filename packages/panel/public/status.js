'use strict';

// Status line, the busy/composer state machine, and the "talking to the
// editor" indicator.

import {
  CONFIG,
  APP,
  state,
  statusEl,
  statusText,
  editorSpinner,
  bridgeBusyText,
  sendBtn,
  stopBtn,
  undoBtn,
  attachBtn,
  input,
} from './state.js';
import { api } from './api.js';
import { showTyping, hideTyping } from './typing.js';
import { hideInstallButton, refreshInstallable } from './install.js';

export function setStatusText(text) {
  if (statusText) statusText.textContent = text;
  else if (statusEl) statusEl.textContent = text;
}

// "talking to the editor" indicator: shown while any request that dispatches into
// the editor's pipe is in flight (documents, selection, switch, undo, and the
// pre-stream context read when sending a message). Counter-based so
// overlapping requests keep it visible until the last one settles.
function bridgeBusyStart() {
  state.bridgeRequestCount++;
  if (editorSpinner) editorSpinner.hidden = false;
  if (bridgeBusyText) bridgeBusyText.hidden = false;
}
function bridgeBusyEnd() {
  state.bridgeRequestCount = Math.max(0, state.bridgeRequestCount - 1);
  if (state.bridgeRequestCount === 0) {
    if (editorSpinner) editorSpinner.hidden = true;
    if (bridgeBusyText) bridgeBusyText.hidden = true;
  }
}
export async function withbridgeBusy(promise) {
  bridgeBusyStart();
  try {
    return await promise;
  } finally {
    bridgeBusyEnd();
  }
}

function updateStatusClass() {
  if (!statusEl) return;
  let cls = 'status';
  if (state.bridgeBusy) cls += ' busy';
  else if (state.bridgeAvailable) cls += ' ok';
  else cls += ' bad';
  statusEl.className = cls;
}

export function updateComposerState() {
  const canSend = state.sessionId && !state.busy && !state.bridgeBusy;
  sendBtn.disabled = !canSend;
  undoBtn.disabled = !state.sessionId || state.busy;
  attachBtn.disabled = !state.sessionId || state.busy;
  stopBtn.hidden = !state.busy;
  // textarea stays enabled for typing per spec
  if (input) input.disabled = false;
}

export function setbridgeBusyState(busyState) {
  state.bridgeBusy = busyState;
  updateStatusClass();
  updateComposerState();
}

export function maybeSetBusyFromError(e) {
  if (e && typeof e.message === 'string' && /timeout/i.test(e.message)) {
    setbridgeBusyState(true);
    setStatusText(`${APP} is busy — dismiss any dialog in ${APP}`);
  }
}

export function setBusy(busyState) {
  state.busy = busyState;
  updateComposerState();
  if (busyState) {
    showTyping();
  } else {
    hideTyping();
    state.currentAbort = null;
  }
}

export async function refreshStatus() {
  try {
    const st = await api('/api/status');
    state.bridgeAvailable = Boolean(st[CONFIG.statusKey ?? 'bridgeAvailable']);
    if (state.bridgeAvailable) {
      setbridgeBusyState(false);
      setStatusText(`${APP} connected`);
      hideInstallButton();
    } else {
      setStatusText(CONFIG.statusMissing ?? 'Bridge not found — open the editor and start it');
      await refreshInstallable();
    }
    updateStatusClass();
  } catch {
    // Our own Express API is unreachable — that is not an editor dialog block.
    state.bridgeAvailable = false;
    state.bridgeBusy = false;
    updateStatusClass();
    setStatusText('server unreachable — restart the app');
  }
}