/** LyX panel configuration (Track C): consumed by the shared
 * @acp-assist/panel assets via the injected index.html. */
import type { PanelConfig } from '@acp-assist/panel';

export const PANEL_CONFIG: PanelConfig = {
  appName: 'LyX',
  appTitle: 'LyX ACP Assist',
  fenceRe: 'lyx',
  statusKey: 'lyxPipeAvailable',
  statusMissing: 'LyX pipe not found — open LyX with a document',
  cursorTerm: 'layout',
  hasSaveConsent: true,
  hasInstallFlow: false,
  // NEVER refresh the selection on composer interaction: the selection
  // read dispatches a `copy` LFUN that clobbers the user's clipboard.
  composerRefreshSelection: false,
  theme: 'theme-lyx',
};
