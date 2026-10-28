'use strict';

// Panel entry point: composer wiring, window-level event hooks, and the
// boot sequence. The real logic lives in the modules next to this file
// (state, api, markdown, messages, typing, status, save-consent,
// install, documents, events, conversation, attachments).

import {
  CONFIG,
  APP,
  state,
  input,
  sendBtn,
  stopBtn,
  undoBtn,
  pinBtn,
  reconnectBtn,
  cmdEl,
  fileInput,
  selectionEl,
} from './state.js';
import { api, loadSettings, saveSettings } from './api.js';
import { addSystemMessage, showEmpty } from './messages.js';
import {
  maybeSetBusyFromError,
  setStatusText,
  updateComposerState,
  withbridgeBusy,
} from './status.js';
import { connect, reconnect, send } from './conversation.js';
import { refreshDocuments, refreshSelection } from './documents.js';

// Refresh the editor context (active document tab + selection indicator) only
// when the user interacts with the composer — never on a timer. Every pipe
// command dispatched into the editor makes it snap its view back to the cursor, so
// even a 2s status poll breaks wheel-scrolling an unfocused
// editor window (Windows scrolls inactive windows under the cursor). The
// authoritative context is re-read server-side when a message is sent.
// With CONFIG.eventPush (LO) this whole heuristic is REPLACED by the
// server-push refresh channel (events.js).
function refreshEditorContext() {
  if (!state.sessionId || state.busy) return;
  refreshDocuments();
  // LyX deliberately does NOT refresh the selection on composer
  // interaction: the selection read dispatches a `copy` LFUN that
  // clears/overwrites the system clipboard — wiping whatever the user
  // copied to paste into the composer.
  if (CONFIG.composerRefreshSelection) refreshSelection();
}
if (!CONFIG.eventPush) {
  input.addEventListener('input', () => {
    if (state.editorContextRefreshTimer) clearTimeout(state.editorContextRefreshTimer);
    state.editorContextRefreshTimer = setTimeout(refreshEditorContext, 400);
  });
  input.addEventListener('focus', refreshEditorContext);

  // One document refresh per window focus: the pipe has no "list open
  // buffers" LFUN, so this is how tabs opened/switched in the editor get discovered
  // after an app restart. A single LFUN on a deliberate focus change — unlike
  // a poll, it never fires while the user scrolls an unfocused editor window (scrolling does not change focus). Documents only: refreshing the
  // selection dispatches a `copy` LFUN that overwrites the system clipboard,
  // which we don't want on a passive window focus.
  window.addEventListener('focus', () => {
    if (!state.sessionId || state.busy) return;
    refreshDocuments();
  });
}

sendBtn.addEventListener('click', send);
input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    send();
  }
});

stopBtn.addEventListener('click', async () => {
  if (!state.busy || !state.sessionId) return;
  state.currentAbort?.abort();
  try {
    await api(`/api/session/${state.sessionId}/cancel`, { method: 'POST' });
  } catch {
    /* the stream ends with the abort anyway */
  }
});

undoBtn.addEventListener('click', async () => {
  if (state.busy || !state.sessionId) return;
  try {
    await withbridgeBusy(api(`/api/session/${state.sessionId}/undo`, { method: 'POST' }));
    addSystemMessage(`Undo sent to ${APP}`);
  } catch (e) {
    addSystemMessage(`Undo failed: ${e.message}`, true);
  }
});

reconnectBtn.addEventListener('click', reconnect);

pinBtn.addEventListener('click', () => {
  state.followMode = !state.followMode;
  pinBtn.setAttribute('aria-pressed', String(state.followMode));
  pinBtn.title = state.followMode
    ? `Float on top while ${APP} is focused`
    : 'Floating disabled';
  window.electron?.toggleAlwaysOnTop?.();
});

function start() {
  input.placeholder = 'Ask the agent. It reads the document and your selection, then decides: reply here, insert at the cursor, or rewrite what you selected.';
  if (selectionEl) selectionEl.hidden = true;
  showEmpty();
  stopBtn.style.display = '';
  fileInput.style.display = '';
  sendBtn.title = 'Send message (Enter)';
  reconnectBtn.title = 'Reconnect: restart the agent session and re-read the document';
  pinBtn.setAttribute('aria-pressed', 'false');
  pinBtn.title = 'Floating disabled';
  cmdEl.addEventListener('blur', saveSettings);
  const settingsDetails = document.querySelector('.agent-settings');
  document.addEventListener('pointerdown', (e) => {
    if (settingsDetails instanceof HTMLDetailsElement && settingsDetails.open
        && !settingsDetails.contains(e.target)) {
      settingsDetails.open = false;
    }
  });
  updateComposerState();
  connect().catch((e) => {
    maybeSetBusyFromError(e);
    if (!state.bridgeBusy) {
      setStatusText(`failed to connect: ${e.message}`);
      const statusEl = document.getElementById('status');
      statusEl.className = 'status bad';
    }
    const details = document.querySelector('.agent-settings');
    if (details && typeof details.open === 'boolean') details.open = true;
  });
}

// Settings load is async (server round-trip); connect must wait for it so the
// first session uses the persisted agent command instead of the HTML defaults.
loadSettings().finally(start);