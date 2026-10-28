'use strict';

// Server-push refresh channel (apps with a push source — LibreOffice's
// bridge /events feed). Instead of the composer-typing/focus heuristics,
// the server watches the editor and pushes {refresh} frames over a
// per-session SSE channel whenever the selection changed or a document
// was edited — live feedback without any panel interaction.
// EventSource cannot send the Authorization header, so this is a
// fetch-stream parse like streamMessage().

import { CONFIG, state } from './state.js';
import { refreshStatus } from './status.js';
import { refreshDocuments, refreshSelection } from './documents.js';

export function closeEventChannel() {
  if (state.eventStreamController) {
    state.eventStreamController.abort();
    state.eventStreamController = null;
  }
}

export function openEventChannel() {
  closeEventChannel();
  if (!CONFIG.eventPush || !state.sessionId) return;
  const id = state.sessionId;
  const controller = new AbortController();
  state.eventStreamController = controller;
  (async () => {
    while (!controller.signal.aborted && state.sessionId === id) {
      try {
        const res = await fetch(`/api/session/${id}/events`, {
          headers: {
            ...(window.__ACP_TOKEN__ ? { authorization: `Bearer ${window.__ACP_TOKEN__}` } : {}),
          },
          signal: controller.signal,
        });
        if (!res.ok || !res.body) throw new Error(`${res.status} ${res.statusText}`);
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buf = '';
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          let idx;
          while ((idx = buf.indexOf('\n\n')) !== -1) {
            const chunk = buf.slice(0, idx);
            buf = buf.slice(idx + 2);
            for (const line of chunk.split('\n')) {
              if (!line.startsWith('data: ')) continue;
              try {
                const frame = JSON.parse(line.slice(6));
                if (frame.refresh) scheduleEventRefresh();
              } catch {
                /* partial frame */
              }
            }
          }
        }
      } catch {
        if (controller.signal.aborted) return;
        /* session gone or channel error: reconnect below unless gone */
      }
      if (controller.signal.aborted || state.sessionId !== id) return;
      // The channel closed (server restart / teardown): reconnect shortly.
      await new Promise((r) => setTimeout(r, 2000));
    }
  })();
}

/** One debounced editor-context refresh per burst of pushed events. */
function scheduleEventRefresh() {
  if (state.eventRefreshTimer) return;
  state.eventRefreshTimer = setTimeout(() => {
    state.eventRefreshTimer = null;
    if (!state.sessionId || state.busy) return;
    Promise.allSettled([refreshStatus(), refreshDocuments(), refreshSelection()]);
  }, 300);
}