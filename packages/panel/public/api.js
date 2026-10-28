'use strict';

// API client + agent settings persistence.

import { cmdEl } from './state.js';

/**
 * Fetch helper for the companion API: attaches the bearer token that the
 * boot script injected same-origin, decodes JSON error bodies into
 * thrown Errors carrying body.error.
 */
export async function api(path, init) {
  const res = await fetch(path, {
    ...init,
    headers: {
      'content-type': 'application/json',
      // API bearer token, injected same-origin into index.html.
      ...(window.__ACP_TOKEN__ ? { authorization: `Bearer ${window.__ACP_TOKEN__}` } : {}),
      ...(init?.headers ?? {}),
    },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? `${res.status} ${res.statusText}`);
  return body;
}

// Agent settings persist SERVER-side: the server listens on a random port each
// launch, so the page origin changes and localStorage would be wiped on restart.
// The UI uses ONE field holding the full command line ("copilot --acp");
// the split into a spawnable command + args happens on save/connect.

/** Split the single agent command line into a spawnable command + args. */
export function parseAgentCommand(raw) {
  const tokens = raw.trim().split(/\s+/).filter(Boolean);
  return { command: tokens[0] ?? '', args: tokens.slice(1) };
}

/** Render persisted { command, args } back into the single input. */
export function formatAgentCommand(settings) {
  return [settings.command, ...(Array.isArray(settings.args) ? settings.args : [])]
    .join(' ')
    .trim();
}

export async function loadSettings() {
  try {
    const s = await api('/api/settings/agent');
    if (typeof s.command === 'string' && s.command) cmdEl.value = formatAgentCommand(s);
  } catch {
    /* keep the HTML defaults */
  }
}

export function saveSettings() {
  const { command, args } = parseAgentCommand(cmdEl.value);
  const body = JSON.stringify({ command, args });
  // Fire-and-forget; a failed save must not break the UI.
  api('/api/settings/agent', { method: 'PUT', body }).catch(() => {});
}