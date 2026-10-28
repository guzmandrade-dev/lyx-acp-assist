'use strict';

// One-click bridge extension install (LibreOffice-only feature; the
// whole section is inert when hasInstallFlow is false — the button stays
// hidden and no preflight is ever sent).

import {
  CONFIG,
  state,
  installBtn,
} from './state.js';
import { api } from './api.js';
import { setStatusText } from './status.js';

/** Show the install button only when the server can actually run it. */
export async function refreshInstallable() {
  if (!installBtn || !CONFIG.hasInstallFlow) return;
  try {
    const pre = await api('/api/bridge/install/preflight');
    installBtn.hidden = !pre.canInstall;
  } catch {
    installBtn.hidden = true;
  }
}

export function hideInstallButton() {
  if (installBtn) installBtn.hidden = true;
}

async function installBridgeExtension() {
  if (state.installBusy || !installBtn || !CONFIG.hasInstallFlow) return;
  // This touches the user's REAL LibreOffice profile — confirm first,
  // stating the full blast radius: the cache wipe is profile-wide, not
  // extension-specific.
  const okToRun = window.confirm(
    'Install the ACP Assist bridge extension into your LibreOffice?\n' +
    'This modifies your LibreOffice profile. Only the ACP Assist extension ' +
    'is removed and re-added, but the extension-cache clear (uno_packages/cache ' +
    'and uno_packages.pmap) covers ALL extensions in this profile — ' +
    'LibreOffice rebuilds it on the next launch and re-registers them. ' +
    'Close LibreOffice first if it is running.',
  );
  if (!okToRun) return;
  state.installBusy = true;
  installBtn.disabled = true;
  setStatusText('Installing bridge extension…');
  try {
    const r = await api('/api/bridge/install', { method: 'POST' });
    setStatusText(r.message || 'Extension installed. Restart LibreOffice, then use menu ACP Assist > Start bridge.');
    hideInstallButton();
  } catch (e) {
    setStatusText(`Install failed: ${e.message ?? e}`);
  } finally {
    state.installBusy = false;
    installBtn.disabled = false;
  }
}

if (installBtn) {
  installBtn.addEventListener('click', installBridgeExtension);
}