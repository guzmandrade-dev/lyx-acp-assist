'use strict';

// Save consent (documents outside version control; LyX-only feature).
//
// The server saves the live document to disk on every message. When the
// file is not inside a VCS working tree that overwrite is unrecoverable,
// so the server refuses the message (409 save-consent-required) until
// the user accepts the conditions for that document path, once per
// session. Inert when CONFIG.hasSaveConsent is false (LibreOffice never
// writes the file — its edits are tracked changes in the live buffer).

import {
  CONFIG,
  state,
  vcsWarnEl,
  consentBackdrop,
  consentPathEl,
  consentAcceptBtn,
  consentCancelBtn,
} from './state.js';
import { api } from './api.js';

export const HAS_SAVE_CONSENT = Boolean(CONFIG.hasSaveConsent) && Boolean(consentBackdrop);

/** Track the active document + its VCS status; toggle the warning badge. */
export function setDocInfo(docPath, versionControlled) {
  if (!HAS_SAVE_CONSENT) return;
  state.activeDocPath = docPath || null;
  state.docVersionControlled = versionControlled ?? null;
  if (vcsWarnEl) vcsWarnEl.hidden = !(state.activeDocPath && state.docVersionControlled === false);
}

/** Show the save-consent modal; resolves true when the user accepts. */
function showSaveConsent(docPath) {
  return new Promise((resolve) => {
    if (consentPathEl) consentPathEl.textContent = docPath;
    if (consentBackdrop) consentBackdrop.hidden = false;
    consentAcceptBtn?.focus();
    state.consentResolver = (accepted) => {
      if (consentBackdrop) consentBackdrop.hidden = true;
      state.consentResolver = null;
      resolve(accepted);
    };
  });
}

consentAcceptBtn?.addEventListener('click', () => state.consentResolver?.(true));
consentCancelBtn?.addEventListener('click', () => state.consentResolver?.(false));
consentBackdrop?.addEventListener('mousedown', (e) => {
  if (e.target === consentBackdrop) state.consentResolver?.(false);
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && state.consentResolver) state.consentResolver(false);
});

/** Ask + register consent for a document path; false when declined. */
export async function requestSaveConsent(docPath) {
  const accepted = await showSaveConsent(docPath);
  if (!accepted) return false;
  state.saveConsentPaths.add(docPath);
  try {
    await api(`/api/session/${state.sessionId}/save-consent`, {
      method: 'POST',
      body: JSON.stringify({ path: docPath }),
    });
  } catch {
    /* stale session: the server re-asks via the stream's 409 */
  }
  return true;
}

/** Pre-send gate: warn before the user bubble, when the state is known. */
export async function ensureSaveConsent() {
  if (!HAS_SAVE_CONSENT) return true;
  if (!state.activeDocPath || state.docVersionControlled !== false) return true;
  if (state.saveConsentPaths.has(state.activeDocPath)) return true;
  return requestSaveConsent(state.activeDocPath);
}