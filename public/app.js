'use strict';

let sessionId = null;
let busy = false;

const chat = document.getElementById('chat');
const statusEl = document.getElementById('status');
const docEl = document.getElementById('doc');
const docSelect = document.getElementById('doc-select');
const input = document.getElementById('input');
const sendBtn = document.getElementById('send');
const undoBtn = document.getElementById('undo');
const pinBtn = document.getElementById('pin');
const closeBtn = document.getElementById('close');

function addMessage(role, content, note) {
  const div = document.createElement('div');
  div.className = `msg ${role}`;
  const bubble = document.createElement('span');
  bubble.className = 'bubble';
  bubble.textContent = content;
  div.appendChild(bubble);
  if (note) {
    const n = document.createElement('span');
    n.className = note.ok ? 'applied' : 'failed';
    n.textContent = note.text;
    div.appendChild(n);
  }
  chat.appendChild(div);
  chat.scrollTop = chat.scrollHeight;
  return bubble;
}

function setBusy(state, label) {
  busy = state;
  sendBtn.disabled = state;
  undoBtn.disabled = state;
  document.body.classList.toggle('busy', state);
  if (state) {
    addMessage('assistant', label ?? 'thinking\u2026');
  } else {
    const indicator = document.getElementById('busy-indicator');
    if (indicator) indicator.remove();
  }
}

async function api(path, init) {
  const res = await fetch(path, {
    headers: { 'content-type': 'application/json' },
    ...init,
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? `${res.status} ${res.statusText}`);
  return body;
}

async function refreshStatus() {
  try {
    const st = await api('/api/status');
    statusEl.textContent = st.lyxPipeAvailable
      ? 'LyX connected (LyXServer pipe)'
      : 'LyX pipe not found \u2014 open LyX with a document';
    statusEl.className = `status ${st.lyxPipeAvailable ? 'ok' : 'bad'}`;
  } catch (e) {
    statusEl.textContent = `server error: ${e.message}`;
    statusEl.className = 'status bad';
  }
}

function updateDocSelector(active, documents) {
  docSelect.innerHTML = '';
  for (const p of documents) {
    const opt = document.createElement('option');
    opt.value = p;
    opt.textContent = p.split(/[\\/]/).pop();
    opt.title = p;
    if (p === active) opt.selected = true;
    docSelect.appendChild(opt);
  }
  docSelect.style.display = documents.length > 0 ? '' : 'none';
}

docSelect.addEventListener('change', async () => {
  if (!sessionId || busy) return;
  try {
    const r = await api(`/api/session/${sessionId}/documents/switch`, {
      method: 'POST',
      body: JSON.stringify({ path: docSelect.value }),
    });
    docEl.textContent = r.active ?? '(unsaved document)';
  } catch (e) {
    addMessage('assistant', `error: ${e.message}`);
  }
});

async function refreshDocuments() {
  if (!sessionId) return;
  try {
    const r = await api(`/api/session/${sessionId}/documents`);
    updateDocSelector(r.active, r.documents);
    if (r.active) docEl.textContent = r.active;
  } catch (e) {
    /* ignore */
  }
}

async function connect() {
  await refreshStatus();
  const cmd = document.getElementById('agent-cmd').value.trim() || 'opencode';
  const rawArgs = document.getElementById('agent-args').value.trim() || 'acp';
  const args = rawArgs.split(/\s+/);
  const info = await api('/api/session', {
    method: 'POST',
    body: JSON.stringify({ agent: { command: cmd, args } }),
  });
  sessionId = info.sessionId;
  docEl.textContent = info.documentPath ?? '(unsaved document)';
  updateDocSelector(info.documentPath, info.documents ?? []);
  for (const turn of info.conversation ?? []) {
    addMessage(turn.role, turn.content);
  }
  addMessage(
    'assistant',
    info.outline
      ? `Connected. Cursor layout: ${info.layout}`
      : 'Connected to LyX (document unsaved \u2014 outline unavailable).'
  );
  // Keep the selector in sync when the user switches tabs in LyX.
  setInterval(refreshDocuments, 2000);
}

function selectedMode() {
  return document.querySelector('input[name=mode]:checked')?.value ?? 'chat';
}

async function streamChat(message) {
  const bubble = addMessage('assistant', '');
  let started = false;
  const res = await fetch(`/api/session/${sessionId}/chat/stream`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ message }),
  });
  if (!res.ok || !res.body) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? `${res.status} ${res.statusText}`);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let full = '';
  let error = null;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buffer.indexOf('\n\n')) >= 0) {
      const frame = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      if (!frame.startsWith('data: ')) continue;
      const payload = JSON.parse(frame.slice(6));
      if (payload.error) {
        error = payload.error;
      } else if (payload.text) {
        full += payload.text;
        started = true;
        bubble.textContent = full;
        chat.scrollTop = chat.scrollHeight;
      } else if (payload.done) {
        // handled below
      }
    }
  }
  if (error) throw new Error(error);
  if (!started) bubble.textContent = '(no response)';
  return full;
}

async function send() {
  if (busy || !sessionId) return;
  const message = input.value.trim();
  if (!message) return;
  input.value = '';
  addMessage('user', message);
  setBusy(true);
  try {
    if (selectedMode() === 'chat') {
      await streamChat(message);
    } else {
      const path = selectedMode() === 'rewrite'
        ? `/api/session/${sessionId}/rewrite-selection`
        : `/api/session/${sessionId}/insert`;
      const result = await api(path, {
        method: 'POST',
        body: JSON.stringify({ message }),
      });
      const note = result.pasted
        ? { ok: true, text: '\u2713 applied to the LyX document' }
        : undefined;
      addMessage('assistant', stripLyxBlock(result.reply), note);
    }
  } catch (e) {
    addMessage('assistant', `error: ${e.message}`);
  } finally {
    setBusy(false);
    await refreshStatus();
    await refreshDocuments();
  }
}

function stripLyxBlock(reply) {
  // The fenced .lyx payload was applied to the document; show only prose.
  return reply.replace(/```lyx\s*\n[\s\S]*?```\s*/g, '').trim();
}

sendBtn.addEventListener('click', send);
input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
    e.preventDefault();
    send();
  }
});

undoBtn.addEventListener('click', async () => {
  if (busy || !sessionId) return;
  try {
    await api(`/api/session/${sessionId}/undo`, { method: 'POST' });
    addMessage('assistant', '(undo sent to LyX)');
  } catch (e) {
    addMessage('assistant', `error: ${e.message}`);
  }
});

pinBtn.addEventListener('click', () => {
  // Toggle always-on-top through the Electron window.
  window.electron?.toggleAlwaysOnTop?.();
});

closeBtn.addEventListener('click', () => {
  window.electron?.close?.();
});

connect().catch((e) => {
  statusEl.textContent = `failed to connect: ${e.message}`;
  statusEl.className = 'status bad';
});