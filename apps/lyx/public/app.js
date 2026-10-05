'use strict';

let sessionId = null;
let busy = false;
let currentAbort = null;
let docPollTimer = null;

const chat = document.getElementById('chat');
const statusEl = document.getElementById('status');
const docEl = document.getElementById('doc');
const docSelect = document.getElementById('doc-select');
const input = document.getElementById('input');
const sendBtn = document.getElementById('send');
const stopBtn = document.getElementById('stop');
const undoBtn = document.getElementById('undo');
const pinBtn = document.getElementById('pin');
const reconnectBtn = document.getElementById('reconnect');
const cmdEl = document.getElementById('agent-cmd');
const argsEl = document.getElementById('agent-args');
const attachBtn = document.getElementById('attach');
const fileInput = document.getElementById('file-input');
const chipsEl = document.getElementById('chips');

/** Attachment ids waiting to be sent with the next message. */
const pendingAttachments = [];

const SETTINGS_KEY = 'lyx-acp-agent-settings';

function loadSettings() {
  try {
    const s = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}');
    if (typeof s.command === 'string' && s.command) cmdEl.value = s.command;
    if (typeof s.args === 'string' && s.args) argsEl.value = s.args;
  } catch {
    /* ignore corrupted settings */
  }
}

function saveSettings() {
  localStorage.setItem(
    SETTINGS_KEY,
    JSON.stringify({ command: cmdEl.value.trim(), args: argsEl.value.trim() }),
  );
}

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
  return { div, bubble };
}

function showTyping() {
  hideTyping();
  const t = document.createElement('div');
  t.id = 'typing';
  t.className = 'msg assistant';
  t.innerHTML = '<span class="bubble"><span class="dot"></span>' +
    '<span class="dot"></span><span class="dot"></span></span>';
  chat.appendChild(t);
  chat.scrollTop = chat.scrollHeight;
}

function hideTyping() {
  document.getElementById('typing')?.remove();
}

function setBusy(state) {
  busy = state;
  sendBtn.disabled = state;
  undoBtn.disabled = state;
  attachBtn.disabled = state || !sessionId;
  stopBtn.style.display = state ? '' : 'none';
  document.body.classList.toggle('busy', state);
  if (state) showTyping();
  else {
    hideTyping();
    currentAbort = null;
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
  saveSettings();
  const cmd = cmdEl.value.trim() || 'opencode';
  const rawArgs = argsEl.value.trim() || 'acp';
  const args = rawArgs.split(/\s+/);
  const info = await api('/api/session', {
    method: 'POST',
    body: JSON.stringify({ agent: { command: cmd, args } }),
  });
  sessionId = info.sessionId;
  attachBtn.disabled = false;
  docEl.textContent = info.documentPath ?? '(unsaved document)';
  updateDocSelector(info.documentPath, info.documents ?? []);
  for (const turn of info.conversation ?? []) {
    addMessage(turn.role, turn.content);
  }
  addMessage(
    'assistant',
    info.outline
      ? `Connected. Cursor layout: ${info.layout}. The agent decides itself whether to reply or write into the document.`
      : 'Connected to LyX (document unsaved \u2014 outline unavailable).',
  );
  // Keep the selector in sync when the user switches tabs in LyX — but
  // ONLY while our window is focused. While blurred (e.g. the user is
  // typing in LyX), polling would dispatch a pipe LFUN into LyX every 2s,
  // which visibly disturbs the caret there.
  if (docPollTimer) clearInterval(docPollTimer);
  docPollTimer = setInterval(refreshDocuments, 2000);
}

window.addEventListener('blur', () => {
  if (docPollTimer) {
    clearInterval(docPollTimer);
    docPollTimer = null;
  }
});
window.addEventListener('focus', () => {
  if (sessionId && !docPollTimer) {
    docPollTimer = setInterval(refreshDocuments, 2000);
    refreshDocuments();
  }
});

/** Tear down the current session (agent process included) and start a new one. */
async function reconnect() {
  if (busy) return;
  reconnectBtn.disabled = true;
  try {
    if (sessionId) {
      try {
        await api(`/api/session/${sessionId}`, { method: 'DELETE' });
      } catch {
        /* session already gone */
      }
      sessionId = null;
    }
    chat.innerHTML = '';
    pendingAttachments.length = 0;
    renderChips();
    await connect();
  } catch (e) {
    statusEl.textContent = `failed to connect: ${e.message}`;
    statusEl.className = 'status bad';
  } finally {
    reconnectBtn.disabled = false;
  }
}

/** Strip the [ACTION: ...] tag; when applied, also strip the applied lyx block. */
function displayText(full, applied) {
  let text = full.replace(/\[ACTION:\s*[^\]]*\]/gi, '').trim();
  if (applied) {
    text = text.replace(/```lyx\s*\n[\s\S]*?```\s*/g, '').trim();
  }
  return text;
}

/**
 * One unified streaming request. The agent decides whether to reply in prose
 * or write into the document ([ACTION: none|insert|rewrite]).
 */
async function streamMessage(message) {
  const { bubble } = addMessage('assistant', '');
  const ctrl = new AbortController();
  currentAbort = ctrl;
  const res = await fetch(`/api/session/${sessionId}/message/stream`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ message }),
    signal: ctrl.signal,
  });
  if (!res.ok || !res.body) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? `${res.status} ${res.statusText}`);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let full = '';
  let applied = null;
  let target = null;
  let target2 = null;
  let cancelled = false;
  let error = null;
  let started = false;
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
        hideTyping();
        bubble.textContent = full;
        chat.scrollTop = chat.scrollHeight;
      } else if (payload.applied) {
        applied = payload.applied;
        target = payload.target;
        target2 = payload.target2 ?? null;
      } else if (payload.cancelled) {
        cancelled = true;
      }
      // {done: true} ends the stream naturally
    }
  }
  if (error) throw new Error(error);
  bubble.textContent = displayText(full, applied) || (started ? '' : '(no response)');
  const note = document.createElement('span');
  if (applied) {
    note.className = 'applied';
    note.textContent =
      applied === 'rewrite'
        ? '\u2713 selection replaced in the LyX document'
        : applied === 'rewrite-at'
          ? `\u2713 paragraph [${target ? 'p' + target : '?'}] replaced in the LyX document`
          : applied === 'insert-after'
            ? `\u2713 inserted after paragraph [${target ? 'p' + target : '?'}] in LyX`
            : applied === 'insert-before'
              ? `\u2713 inserted before paragraph [${target ? 'p' + target : '?'}] in LyX`
              : applied === 'delete-at'
              ? `\u2713 paragraph [${target ? 'p' + target : '?'}] deleted from LyX`
              : applied === 'move'
                ? `\u2713 paragraph [${target ? 'p' + target : '?'}] moved` +
                  (target2 !== null ? ` to after [p${target2}]` : '')
                : applied === 'insert-top'
                ? '\u2713 inserted at the top of the document'
                : '\u2713 inserted at the cursor in LyX';
  } else if (cancelled) {
    note.className = 'stopped';
    note.textContent = '(stopped)';
  }
  if (note.textContent) bubble.parentElement.appendChild(note);
  chat.scrollTop = chat.scrollHeight;
  return { full, applied, cancelled };
}

async function send() {
  if (busy || !sessionId) return;
  const message = input.value.trim();
  if (!message) return;
  input.value = '';
  addMessage('user', message);
  setBusy(true);
  try {
    await streamMessage(message);
    // Attachments were consumed by this message.
    pendingAttachments.length = 0;
    renderChips();
  } catch (e) {
    if (e.name === 'AbortError') {
      addMessage('assistant', '(stopped)');
    } else {
      addMessage('assistant', `error: ${e.message}`);
    }
  } finally {
    setBusy(false);
    await refreshStatus();
    await refreshDocuments();
  }
}

function renderChips() {
  chipsEl.innerHTML = '';
  for (const att of pendingAttachments) {
    const chip = document.createElement('span');
    chip.className = 'chip';
    const label = document.createElement('span');
    label.textContent = att.name + (att.converted ? '' : ' (no text extracted)');
    const x = document.createElement('button');
    x.textContent = '\u2715';
    x.title = 'Remove attachment';
    x.addEventListener('click', () => removeAttachment(att.id));
    chip.appendChild(label);
    chip.appendChild(x);
    chipsEl.appendChild(chip);
  }
}

async function removeAttachment(id) {
  const i = pendingAttachments.findIndex((a) => a.id === id);
  if (i >= 0) pendingAttachments.splice(i, 1);
  renderChips();
  try {
    await api(`/api/session/${sessionId}/attachments/${id}`, { method: 'DELETE' });
  } catch {
    /* already gone */
  }
}

function uploadFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const base64 = String(reader.result).split(',')[1] ?? '';
      api(`/api/session/${sessionId}/attachments`, {
        method: 'POST',
        body: JSON.stringify({ name: file.name, mime: file.type, data: base64 }),
      })
        .then((r) => resolve({ id: r.id, name: r.name, converted: r.converted }))
        .catch(reject);
    };
    reader.onerror = () => reject(new Error(`could not read ${file.name}`));
    reader.readAsDataURL(file);
  });
}

attachBtn.addEventListener('click', () => {
  if (!sessionId || busy) return;
  fileInput.value = '';
  fileInput.click();
});

fileInput.addEventListener('change', async () => {
  if (!sessionId || busy) return;
  for (const file of fileInput.files ?? []) {
    try {
      const att = await uploadFile(file);
      pendingAttachments.push(att);
    } catch (e) {
      addMessage('assistant', `attachment "${file.name}" failed: ${e.message}`);
    }
  }
  renderChips();
  input.focus();
});

sendBtn.addEventListener('click', send);
input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
    e.preventDefault();
    send();
  }
});

stopBtn.addEventListener('click', async () => {
  if (!busy || !sessionId) return;
  currentAbort?.abort();
  try {
    await api(`/api/session/${sessionId}/cancel`, { method: 'POST' });
  } catch {
    /* the stream ends with the abort anyway */
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

reconnectBtn.addEventListener('click', reconnect);

let lyxFollowMode = true;
pinBtn.addEventListener('click', () => {
  lyxFollowMode = !lyxFollowMode;
  pinBtn.classList.toggle('off', !lyxFollowMode);
  pinBtn.title = lyxFollowMode
    ? 'Float on top while LyX is focused'
    : 'Floating disabled';
  window.electron?.toggleAlwaysOnTop?.();
});

loadSettings();
connect().catch((e) => {
  statusEl.textContent = `failed to connect: ${e.message}`;
  statusEl.className = 'status bad';
});
