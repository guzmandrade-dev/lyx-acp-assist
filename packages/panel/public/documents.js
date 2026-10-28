'use strict';

// Editor context: active document (tab selector) and selection readout.

import {
  state,
  docEl,
  docSelect,
  selectionEl,
} from './state.js';
import { api } from './api.js';
import { addSystemMessage, renderConversation } from './messages.js';
import { maybeSetBusyFromError, withbridgeBusy, refreshStatus } from './status.js';
import { setDocInfo } from './save-consent.js';

export async function refreshSelection() {
  if (!state.sessionId || !selectionEl) return;
  try {
    const r = await withbridgeBusy(api(`/api/session/${state.sessionId}/selection`));
    if (r.hasSelection && r.stats && r.stats[0] > 0) {
      selectionEl.textContent = `${r.stats[0]} words selected`;
      selectionEl.hidden = false;
    } else {
      selectionEl.hidden = true;
    }
  } catch {
    selectionEl.hidden = true;
  }
}

export function updateDocSelector(active, documents) {
  docSelect.innerHTML = '';
  for (const p of documents) {
    const opt = document.createElement('option');
    opt.value = p;
    opt.textContent = p.split(/[\\/]/).pop();
    opt.title = p;
    if (p === active) opt.selected = true;
    docSelect.appendChild(opt);
  }
  docSelect.hidden = documents.length === 0;
}

docSelect.addEventListener('change', async () => {
  if (!state.sessionId || state.busy) return;
  try {
    const r = await withbridgeBusy(
      api(`/api/session/${state.sessionId}/documents/switch`, {
        method: 'POST',
        body: JSON.stringify({ path: docSelect.value }),
      }),
    );
    docEl.textContent = r.active ?? '(unsaved document)';
    docEl.title = r.active ?? '';
    setDocInfo(r.active, r.versionControlled);
    // Each document has its own conversation history — after switching,
    // re-render the chat from the newly active document's history.
    await refreshChatForDocument(r.active);
    await refreshStatus();
    await refreshDocuments();
    await refreshSelection();
  } catch (e) {
    maybeSetBusyFromError(e);
    addSystemMessage(`error: ${e.message}`, true);
  }
});

/**
 * Each document has its own conversation history. Track which document's
 * conversation is rendered; when the editor's active document changes (dropdown
 * switch, tab change in the editor, file open), reload that document's history.
 * A no-op when the active document hasn't changed.
 */
export async function refreshChatForDocument(active) {
  const key = active ?? '(unsaved)';
  if (key === state.chatDocKey) return;
  const info = await withbridgeBusy(api(`/api/session/${state.sessionId}`));
  // The fetch re-reads the active document — trust its answer over the
  // caller's (possibly stale) snapshot.
  state.chatDocKey = info.documentPath ?? '(unsaved)';
  renderConversation(info.conversation ?? []);
}

export async function refreshDocuments() {
  if (!state.sessionId) return;
  try {
    const r = await withbridgeBusy(api(`/api/session/${state.sessionId}/documents`));
    updateDocSelector(r.active, r.documents);
    setDocInfo(r.active, r.versionControlled);
    if (r.active) {
      docEl.textContent = r.active;
      docEl.title = r.active;
    }
    await refreshChatForDocument(r.active);
  } catch {
    /* ignore */
  }
}