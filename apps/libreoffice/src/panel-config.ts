/** LibreOffice panel configuration: consumed by the shared
 * @acp-assist/panel assets via the injected index.html. */
import type { PanelConfig } from '@acp-assist/panel';

export const PANEL_CONFIG: PanelConfig = {
  appName: 'LibreOffice',
  appTitle: 'LibreOffice ACP Assist',
  fenceRe: '(?:writer|calc|impress)',
  statusKey: 'bridgeAvailable',
  statusMissing: 'Bridge not found — open LibreOffice and use menu ACP Assist > Start bridge',
  cursorTerm: 'style',
  hasSaveConsent: false,
  hasInstallFlow: true,
  composerRefreshSelection: true,
  busyText: 'talking to LibreOffice…',
  eventPush: true,
  theme: null,
};
