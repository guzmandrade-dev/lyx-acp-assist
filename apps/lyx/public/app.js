'use strict';

let sessionId = null;
let busy = false;

const chat = document.getElementById('chat');
const statusEl = document.getElementById('status');
const docEl = document.getElementById('doc');
const input = document.getElementById('input');
const sendBtn = document.getElementById('send');
const undoBtn = document.getElementById('undo');

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
  return div;
}

function setBusy(state, label) {
  busy = state;
  sendBtn.disabled = state;
  undoBtn.disabled = state;
  document.body.classList.toggle('busy', state);
  if (state) {
    const div = addMessage('assistant', label ?? 'thinking\u2026');
    div.id = 'busy-indicator';
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

async function connect() {
  await refreshStatus();
  const info = await api('/api/session', { method: 'POST', body: '{}' });
  sessionId = info.sessionId;
  docEl.textContent = info.documentPath ?? '(unsaved document)';
  addMessage(
    'assistant',
    info.outline
      ? `Connected to:\n${info.documentPath}\n\nDocument outline:\n${info.outline}`
      : 'Connected to LyX (document unsaved \u2014 outline unavailable).'
  );
}

function selectedMode() {
  return document.querySelector('input[name=mode]:checked')?.value ?? 'chat';
}

async function send() {
  if (busy || !sessionId) return;
  const message = input.value.trim();
  if (!message) return;
  input.value = '';
  addMessage('user', message);
  setBusy(true);
  try {
    let result;
    let path;
    if (selectedMode() === 'rewrite') {
      path = `/api/session/${sessionId}/rewrite-selection`;
    } else if (selectedMode() === 'insert') {
      path = `/api/session/${sessionId}/insert`;
    } else {
      path = `/api/session/${sessionId}/chat`;
    }
    result = await api(path, { method: 'POST', body: JSON.stringify({ message }) });
    const note = result.pasted
      ? { ok: true, text: '\u2713 applied to the LyX document' }
      : undefined;
    addMessage('assistant', stripLyxBlock(result.reply), note);
  } catch (e) {
    addMessage('assistant', `error: ${e.message}`, { ok: false, text: '' });
  } finally {
    setBusy(false);
    await refreshStatus();
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

connect().catch((e) => {
  statusEl.textContent = `failed to connect: ${e.message}`;
  statusEl.className = 'status bad';
});