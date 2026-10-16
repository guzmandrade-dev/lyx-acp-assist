'use strict';

let sessionId = null;
let busy = false;
let bridgeBusy = false;
let bridgeAvailable = false;
let currentAbort = null;
let typingIndicator = null;
let generationStart = 0;
let typingTimer = null;
let typingResumeTimer = null;

const chat = document.getElementById('chat');
const statusEl = document.getElementById('status');
const statusText = document.getElementById('status-text');
const docEl = document.getElementById('doc');
const selectionEl = document.getElementById('selection');
const docSelect = document.getElementById('doc-select');
const LibreOfficeSpinner = document.getElementById('bridge-spinner');
const bridgeBusyText = document.getElementById('bridge-busy-text');
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
let emptyEl = document.getElementById('empty');
/** Document path whose conversation is currently rendered in the chat. */
let chatDocKey = null;

/** Attachment ids waiting to be sent with the next message. */
const pendingAttachments = [];

// Agent settings persist SERVER-side: the server listens on a random port each
// launch, so the page origin changes and localStorage would be wiped on restart.
async function loadSettings() {
  try {
    const s = await api('/api/settings/agent');
    if (typeof s.command === 'string' && s.command) cmdEl.value = s.command;
    if (Array.isArray(s.args)) argsEl.value = s.args.join(' ');
  } catch {
    /* keep the HTML defaults */
  }
}

function saveSettings() {
  const body = JSON.stringify({ command: cmdEl.value.trim(), args: argsEl.value.trim() });
  // Fire-and-forget; a failed save must not break the UI.
  api('/api/settings/agent', { method: 'PUT', body }).catch(() => {});
}

function escapeHtml(text) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function renderInlineFormatting(html) {
  // bold, italic, inline code — keep it simple and safe
  return html
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*]+)\*/g, '<em>$1</em>')
    .replace(/`([^`]+)`/g, '<code>$1</code>');
}

/** Render assistant text: escape first, then restore minimal inline markup. */
function renderAssistantText(full, applied) {
  let text = full.replace(/\[ACTION:\s*[^\]]*\]/gi, '').trim();
  if (applied && applied !== 'none') {
    text = text.replace(/```writer\s*\n[\s\S]*?```\s*/g, '').trim();
  }
  if (!text) return '';

  const parts = [];
  const regex = /```writer\s*\n([\s\S]*?)```/g;
  let lastIndex = 0;
  let match;
  while ((match = regex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      parts.push({ type: 'text', content: text.slice(lastIndex, match.index) });
    }
    parts.push({ type: 'code', content: match[1] });
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < text.length) {
    parts.push({ type: 'text', content: text.slice(lastIndex) });
  }

  let html = '';
  for (const part of parts) {
    if (part.type === 'code') {
      html += `<pre class="code"><code>${escapeHtml(part.content)}</code></pre>`;
    } else {
      const paragraphs = part.content.split(/\n\s*\n/);
      for (const para of paragraphs) {
        if (!para.trim()) continue;
        const lines = para.split('\n').map((l) => renderInlineFormatting(escapeHtml(l)));
        html += `<p>${lines.join('<br>')}</p>`;
      }
    }
  }
  return html;
}

/**
 * Replace the chat panel with the given (persisted) conversation, or the
 * empty state when there are no turns. Used on connect and when switching
 * documents — each document has its own history.
 */
function renderConversation(turns) {
  chat.innerHTML = '';
  typingIndicator = null;
  hideTyping();
  if (!turns || turns.length === 0) {
    showEmpty();
    return;
  }
  hideEmpty();
  for (const turn of turns) {
    const { div } = addMessage(turn.role, turn.content);
    // Restore a persisted action outcome (applied/error/cancelled) from a
    // previous app run, so failures are visible after a restart.
    if (turn.role === 'assistant' && turn.meta) {
      // Remember the outcome so copy/quote strips the ```writer block like the render does.
      div._applied = turn.meta.result === 'applied' ? turn.meta.action : null;
      renderFeedback(div, {
        applied: turn.meta.result === 'applied' && turn.meta.action !== 'none'
          ? turn.meta.action
          : turn.meta.result === 'cancelled'
            ? null
            : turn.meta.action === 'none'
              ? 'none'
              : null,
        target: turn.meta.target ?? null,
        target2: turn.meta.target2 ?? null,
        cancelled: turn.meta.result === 'cancelled',
        error: turn.meta.result === 'error' ? turn.meta.error : null,
      });
    }
  }
}

function showEmpty() {
  if (!emptyEl) {
    emptyEl = document.createElement('div');
    emptyEl.id = 'empty';
    emptyEl.className = 'empty';
    const logo = document.createElement('img');
    logo.className = 'empty-logo';
    logo.src = 'logo.svg';
    logo.width = 72;
    logo.height = 72;
    logo.alt = '';
    const name = document.createElement('div');
    name.className = 'empty-name';
    name.textContent = 'LibreOffice ACP Assist';
    const hint = document.createElement('div');
    hint.textContent =
      'Select text in LibreOffice or type a request. the agent will reply here or write directly into the document.';
    emptyEl.append(logo, name, hint);
  }
  // Re-append so the empty state is the LAST child: with flex:1 + margin
  // removed it stretches to fill the chat area and centers itself. Any
  // stale trailing nodes (e.g. a leftover typing indicator) move above it.
  chat.appendChild(emptyEl);
  emptyEl.hidden = false;
}

function hideEmpty() {
  if (emptyEl) emptyEl.hidden = true;
}

function scrollToBottomIfNear() {
  const nearBottom = chat.scrollHeight - chat.scrollTop - chat.clientHeight < 60;
  if (nearBottom) chat.scrollTop = chat.scrollHeight;
}

const QUOTE_ICON = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
  + '<path d="M3 21c3 0 7-1 7-8V5c0-1.25-.756-2.017-2-2H4c-1.25 0-2 .75-2 1.972V11c0 1.25.75 2 2 2 1 0 1 0 1 1v1c0 1-1 2-2 2s-1 .008-1 1.031V20c0 1 0 1 1 1z"/>'
  + '<path d="M15 21c3 0 7-1 7-8V5c0-1.25-.757-2.017-2-2h-4c-1.25 0-2 .75-2 1.972V11c0 1.25.75 2 2 2h.75c0 2.25.25 4-2.75 4v3c0 1 0 1 1 1z"/>'
  + '</svg>';
const COPY_ICON = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
  + '<rect x="9" y="9" width="13" height="13" rx="2"/>'
  + '<path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>'
  + '</svg>';

/**
 * Plain-text form of a message for copy/quote: the raw turn content with
 * the action tag stripped (and, for applied write actions, the ```writer block
 * stripped too) — mirroring what renderAssistantText shows. Read from the
 * div at click time so streamed assistant messages quote their final text.
 */
function messagePlainText(div) {
  const raw = div._rawText ?? div.querySelector('.text')?.textContent ?? '';
  if (!div.classList.contains('assistant')) return raw;
  let text = raw.replace(/\[ACTION:\s*[^\]]*\]/gi, '').trim();
  if (div._applied && div._applied !== 'none') {
    text = text.replace(/```writer\s*\n[\s\S]*?```\s*/g, '').trim();
  }
  return text;
}

/** Insert text into the composer as a GitHub-style blockquote at the caret. */
function quoteIntoComposer(text) {
  const quote = text.split('\n').map((l) => `> ${l}`).join('\n');
  const start = input.selectionStart ?? input.value.length;
  const end = input.selectionEnd ?? start;
  const before = input.value.slice(0, start);
  const after = input.value.slice(end);
  const separator = before.length === 0 ? '' : before.endsWith('\n\n') ? '' : before.endsWith('\n') ? '\n' : '\n\n';
  const insertion = separator + quote + '\n\n';
  input.value = before + insertion + after;
  const caret = (before + insertion).length;
  input.focus();
  input.setSelectionRange(caret, caret);
}

async function copyTextToClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // Fallback for contexts where the async clipboard API is unavailable.
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
}

function msgActionButton(kind, label, icon, onClick) {
  const btn = document.createElement('button');
  btn.className = `msg-action ${kind}`;
  btn.title = label;
  btn.setAttribute('aria-label', label);
  btn.innerHTML = icon;
  btn.addEventListener('click', () => onClick(btn));
  return btn;
}

/** Hover actions under each message: quote into the composer, copy text. */
function attachMessageActions(div, role) {
  const actions = document.createElement('div');
  actions.className = 'msg-actions';
  if (role !== 'system') {
    actions.appendChild(msgActionButton('quote', 'Quote in a new message', QUOTE_ICON, () => {
      const text = messagePlainText(div);
      if (text) quoteIntoComposer(text);
    }));
  }
  actions.appendChild(msgActionButton('copy', 'Copy text', COPY_ICON, async (btn) => {
    const text = messagePlainText(div);
    if (!text) return;
    await copyTextToClipboard(text);
    const original = btn.innerHTML;
    btn.classList.add('copied');
    btn.innerHTML = '&#10003; Copied';
    setTimeout(() => {
      btn.classList.remove('copied');
      btn.innerHTML = original;
    }, 1200);
  }));
  div.appendChild(actions);
}

function addMessage(role, content, opts = {}) {
  hideEmpty();
  const div = document.createElement('div');
  div.className = `msg ${role}`;
  if (opts.assertive) div.setAttribute('aria-live', 'assertive');
  // Raw text for the copy/quote actions; streamMessage updates it as the
  // reply streams in.
  div._rawText = content;
  div._applied = opts.applied ?? null;
  const textDiv = document.createElement('div');
  textDiv.className = 'text';
  if (role === 'assistant') {
    textDiv.innerHTML = renderAssistantText(content, opts.applied);
  } else {
    textDiv.textContent = content;
  }
  div.appendChild(textDiv);
  attachMessageActions(div, role);
  chat.appendChild(div);
  scrollToBottomIfNear();
  return { div, textDiv };
}

function addSystemMessage(text, assertive = false) {
  return addMessage('system', text, { assertive });
}

function ensureTypingIndicator() {
  if (!typingIndicator) {
    typingIndicator = document.createElement('div');
    typingIndicator.className = 'typing';
    // Animated three-dot scale-pulse: a visible "the agent is still
    // working" signal during long generations (the text alone pulses
    // subtly).
    typingIndicator.innerHTML =
      '<span class="sr-only">Agent is thinking</span>' +
      '<span class="tdots" aria-hidden="true"><i></i><i></i><i></i></span>';
  }
  return typingIndicator;
}

/**
 * The indicator gets a hint line with an elapsed-time readout
 * ("Thinking… 1m 43s"), so a multi-minute generation reads as
 * deliberate rather than stuck. The clock measures the whole turn
 * (set at stream start, cleared when the turn ends), not just the
 * current indicator stint — tool activity pauses and resumes the
 * indicator without resetting it.
 */
const TYPING_HINTS = [
  { after: 0, text: 'Reading the document…' },
  { after: 15_000, text: 'Thinking…' },
  { after: 60_000, text: 'Still working…' },
];

function formatElapsed(ms) {
  const totalSec = Math.max(1, Math.round(ms / 1000));
  if (totalSec < 60) return `${totalSec}s`;
  return `${Math.floor(totalSec / 60)}m ${String(totalSec % 60).padStart(2, '0')}s`;
}

function typingHintText() {
  const elapsed = generationStart ? Date.now() - generationStart : 0;
  let text = TYPING_HINTS[0].text;
  for (const h of TYPING_HINTS) {
    if (elapsed >= h.after) text = h.text;
  }
  return `${text} ${formatElapsed(elapsed)}`;
}

function setTypingHint() {
  if (!typingIndicator || !generationStart) return;
  let hintEl = typingIndicator.querySelector('.typing-hint');
  if (!hintEl) {
    hintEl = document.createElement('span');
    hintEl.className = 'typing-hint';
    typingIndicator.appendChild(hintEl);
  }
  hintEl.textContent = typingHintText();
}

function showTyping() {
  const t = ensureTypingIndicator();
  if (!t.parentElement) chat.appendChild(t);
  t.hidden = false;
  setTypingHint();
  if (!typingTimer) {
    typingTimer = setInterval(() => {
      if (typingIndicator && !typingIndicator.hidden) setTypingHint();
    }, 1000);
  }
  scrollToBottomIfNear();
}

function hideTyping() {
  if (typingIndicator) typingIndicator.hidden = true;
  if (typingTimer) {
    clearInterval(typingTimer);
    typingTimer = null;
  }
  if (typingResumeTimer) {
    clearTimeout(typingResumeTimer);
    typingResumeTimer = null;
  }
}

function scheduleTypingResume() {
  if (typingResumeTimer) clearTimeout(typingResumeTimer);
  typingResumeTimer = setTimeout(() => {
    if (busy) showTyping();
  }, 1000);
}

function setStatusText(text) {
  if (statusText) statusText.textContent = text;
  else if (statusEl) statusEl.textContent = text;
}

// "talking to LibreOffice" indicator: shown while any request that dispatches into
// LibreOffice's pipe is in flight (documents, selection, switch, undo, and the
// pre-stream context read when sending a message). Counter-based so
// overlapping requests keep it visible until the last one settles.
let bridgeRequestCount = 0;
function bridgeBusyStart() {
  bridgeRequestCount++;
  if (LibreOfficeSpinner) LibreOfficeSpinner.hidden = false;
  if (bridgeBusyText) bridgeBusyText.hidden = false;
}
function bridgeBusyEnd() {
  bridgeRequestCount = Math.max(0, bridgeRequestCount - 1);
  if (bridgeRequestCount === 0) {
    if (LibreOfficeSpinner) LibreOfficeSpinner.hidden = true;
    if (bridgeBusyText) bridgeBusyText.hidden = true;
  }
}
async function withbridgeBusy(promise) {
  bridgeBusyStart();
  try {
    return await promise;
  } finally {
    bridgeBusyEnd();
  }
}

function updateStatusClass() {
  if (!statusEl) return;
  let cls = 'status';
  if (bridgeBusy) cls += ' busy';
  else if (bridgeAvailable) cls += ' ok';
  else cls += ' bad';
  statusEl.className = cls;
}

function setbridgeBusyState(state) {
  bridgeBusy = state;
  updateStatusClass();
  updateComposerState();
}

function maybeSetBusyFromError(e) {
  if (e && typeof e.message === 'string' && /timeout/i.test(e.message)) {
    setbridgeBusyState(true);
    setStatusText('LibreOffice is busy — dismiss any dialog in LibreOffice');
  }
}

function updateComposerState() {
  const canSend = sessionId && !busy && !bridgeBusy;
  sendBtn.disabled = !canSend;
  undoBtn.disabled = !sessionId || busy;
  attachBtn.disabled = !sessionId || busy;
  stopBtn.hidden = !busy;
  // textarea stays enabled for typing per spec
  if (input) input.disabled = false;
}

function setBusy(state) {
  busy = state;
  updateComposerState();
  if (state) {
    showTyping();
  } else {
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
    bridgeAvailable = st.bridgeAvailable;
    if (bridgeAvailable) {
      setbridgeBusyState(false);
      setStatusText('LibreOffice connected');
    } else {
      setStatusText('Bridge not found — open LibreOffice and use menu ACP Assist > Start bridge');
    }
    updateStatusClass();
  } catch {
    // Our own Express API is unreachable — that is not a LibreOffice dialog block.
    bridgeAvailable = false;
    bridgeBusy = false;
    updateStatusClass();
    setStatusText('server unreachable — restart the app');
  }
}

async function refreshSelection() {
  if (!sessionId || !selectionEl) return;
  try {
    const r = await withbridgeBusy(api(`/api/session/${sessionId}/selection`));
    if (r.hasSelection && r.stats && r.stats[0] > 0) {
      selectionEl.textContent = `${r.stats[0]} words selected`;
      selectionEl.hidden = false;
    } else {
      selectionEl.hidden = true;
    }
  } catch (e) {
    selectionEl.hidden = true;
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
  docSelect.hidden = documents.length === 0;
}

docSelect.addEventListener('change', async () => {
  if (!sessionId || busy) return;
  try {
    const r = await withbridgeBusy(
      api(`/api/session/${sessionId}/documents/switch`, {
        method: 'POST',
        body: JSON.stringify({ path: docSelect.value }),
      }),
    );
    docEl.textContent = r.active ?? '(unsaved document)';
    docEl.title = r.active ?? '';
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
 * conversation is rendered; when LibreOffice's active document changes (dropdown
 * switch, tab change in LibreOffice, file open), reload that document's history.
 * A no-op when the active document hasn't changed.
 */
async function refreshChatForDocument(active) {
  const key = active ?? '(unsaved)';
  if (key === chatDocKey) return;
  const info = await withbridgeBusy(api(`/api/session/${sessionId}`));
  // The fetch re-reads the active document — trust its answer over the
  // caller's (possibly stale) snapshot.
  chatDocKey = info.documentPath ?? '(unsaved)';
  renderConversation(info.conversation ?? []);
}

async function refreshDocuments() {
  if (!sessionId) return;
  try {
    const r = await withbridgeBusy(api(`/api/session/${sessionId}/documents`));
    updateDocSelector(r.active, r.documents);
    if (r.active) {
      docEl.textContent = r.active;
      docEl.title = r.active;
    }
    await refreshChatForDocument(r.active);
  } catch (e) {
    /* ignore */
  }
}

async function connect() {
  await refreshStatus();
  saveSettings();
  const cmd = cmdEl.value.trim() || 'opencode';
  const rawArgs = argsEl.value.trim();
  const args = rawArgs ? rawArgs.split(/\s+/) : [];
  const info = await api('/api/session', {
    method: 'POST',
    body: JSON.stringify({ agent: { command: cmd, args } }),
  });
  sessionId = info.sessionId;
  chatDocKey = info.documentPath ?? '(unsaved)';
  docEl.textContent = info.documentPath ?? '(unsaved document)';
  docEl.title = info.documentPath ?? '';
  updateDocSelector(info.documentPath, info.documents ?? []);
  const turns = info.conversation ?? [];
  renderConversation(turns);
  if (turns.length === 0) {
    // Fresh conversation: show the quiet empty state, not a chat message.
    showEmpty();
  } else {
    addMessage(
      'assistant',
      info.outline
        ? `Connected. Cursor style: ${info.layout}. The agent decides itself whether to reply or write into the document.`
        : 'Connected to LibreOffice (document unsaved — outline unavailable).',
    );
    hideEmpty();
  }
  updateComposerState();
}

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
    showEmpty();
    await connect();
  } catch (e) {
    maybeSetBusyFromError(e);
    if (!bridgeBusy) {
      setStatusText(`failed to connect: ${e.message}`);
      statusEl.className = 'status bad';
    }
    const details = document.querySelector('.agent-settings');
    if (details && typeof details.open === 'boolean') details.open = true;
  } finally {
    reconnectBtn.disabled = false;
  }
}

function renderFeedback(msgDiv, { applied, target, target2, cancelled, error }) {
  const feedback = document.createElement('div');
  let prefix = '';
  let undoLabel = 'Undo edit';
  let showUndo = false;

  if (error) {
    feedback.className = 'feedback error';
    prefix = `Not applied: ${error}`;
  } else if (cancelled) {
    feedback.className = 'feedback stopped';
    prefix = 'Stopped before applying';
  } else if (applied === 'none') {
    feedback.className = 'feedback none';
    prefix = 'Replied in chat — document unchanged';
  } else if (applied) {
    feedback.className = 'feedback applied';
    showUndo = true;
    switch (applied) {
      case 'insert':
        prefix = 'Inserted at the cursor in LibreOffice';
        break;
      case 'insert-top':
        prefix = 'Inserted at the top of the document';
        undoLabel = 'Undo edit (×2)';
        break;
      case 'insert-after':
        prefix = `Inserted after [p${target ?? '?'}] in LibreOffice`;
        break;
      case 'insert-before':
        prefix = `Inserted before [p${target ?? '?'}] in LibreOffice`;
        break;
      case 'rewrite':
        prefix = 'Replaced the selection in LibreOffice';
        break;
      case 'rewrite-at':
        prefix = `Replaced [p${target ?? '?'}] in LibreOffice`;
        break;
      case 'delete-at':
        prefix = `Deleted [p${target ?? '?'}] from LibreOffice`;
        break;
      case 'merge':
        prefix = `Merged [p${target ?? '?'}] with [p${target2 ?? '?'}] in LibreOffice`;
        break;
      case 'move':
        prefix = `Moved [p${target ?? '?'}] to after [p${target2 ?? '?'}] in LibreOffice`;
        break;
      default:
        prefix = `Applied ${applied}`;
    }
  } else {
    feedback.className = 'feedback none';
    prefix = 'Replied in chat — document unchanged';
  }

  feedback.appendChild(document.createTextNode(prefix));
  if (showUndo) {
    feedback.appendChild(document.createTextNode(' · '));
    const btn = document.createElement('button');
    btn.className = 'link';
    btn.textContent = undoLabel;
    btn.addEventListener('click', async () => {
      if (!sessionId || busy) return;
      try {
        await withbridgeBusy(api(`/api/session/${sessionId}/undo`, { method: 'POST' }));
        addSystemMessage('Undo sent to LibreOffice');
      } catch (e) {
        addSystemMessage(`Undo failed: ${e.message}`, true);
      }
    });
    feedback.appendChild(btn);
  }
  msgDiv.appendChild(feedback);
}

async function streamMessage(message) {
  let { div, textDiv } = addMessage('assistant', '');
  const ctrl = new AbortController();
  currentAbort = ctrl;
  setBusy(true);
  generationStart = Date.now();
  showTyping();

  let res;
  try {
    // The response headers arrive only after the server has finished reading
    // the document context from LibreOffice (save + outline + selection), so this
    // fetch window is exactly the "talking to LibreOffice" phase.
    res = await withbridgeBusy(
      fetch(`/api/session/${sessionId}/message/stream`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ message }),
        signal: ctrl.signal,
      }),
    );
  } catch (e) {
    maybeSetBusyFromError(e);
    hideTyping();
    generationStart = 0;
    setBusy(false);
    throw e;
  }

  if (!res.ok || !res.body) {
    const body = await res.json().catch(() => ({}));
    const err = new Error(body.error ?? `${res.status} ${res.statusText}`);
    maybeSetBusyFromError(err);
    hideTyping();
    generationStart = 0;
    setBusy(false);
    throw err;
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
  let stopReason = null;
  let started = false;
  const usedTools = [];
  let toolLine = null;
  // Multi-action runs: close one assistant bubble per applied edit and
  // start a fresh bubble for the next agent step in the same request.
  const streamSteps = [];

  const setToolLine = (text) => {
    if (!toolLine) {
      toolLine = document.createElement('div');
      toolLine.className = 'tools';
      div.appendChild(toolLine);
    }
    toolLine.textContent = text;
  };

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buffer.indexOf('\n\n')) >= 0) {
        const frame = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        if (!frame.startsWith('data: ')) continue;
        let payload;
        try {
          payload = JSON.parse(frame.slice(6));
        } catch {
          continue;
        }
        if (payload.error) {
          error = payload.error;
          maybeSetBusyFromError({ message: error });
        } else if (payload.text) {
          full += payload.text;
          started = true;
          hideTyping();
          div._rawText = full; // for the copy/quote actions
          textDiv.innerHTML = renderAssistantText(full, applied);
          scrollToBottomIfNear();
          scheduleTypingResume();
        } else if (payload.tool) {
          const t = payload.tool;
          if (t.status === 'completed') {
            if (!usedTools.includes(t.title)) usedTools.push(t.title);
            setToolLine(`Used ${usedTools.join(', ')}`);
          } else {
            setToolLine(`Using ${t.title}…`);
          }
          hideTyping();
          scheduleTypingResume();
          scrollToBottomIfNear();
        } else if (payload.applied) {
          applied = payload.applied;
          target = payload.target ?? null;
          target2 = payload.target2 ?? null;
          div._applied = applied; // quote strips the ```writer block like the render does
        } else if (payload.appliedStep) {
          // Boundary between two edits of one multi-action run: close the
          // current bubble (with its feedback) and start a fresh one below
          // for the next agent step.
          div._rawText = full;
          div._applied = applied;
          textDiv.innerHTML =
            renderAssistantText(full, applied) || (started ? '' : '<p>(no response)</p>');
          renderFeedback(div, { applied, target, target2, cancelled, error });
          streamSteps.push({ div, textDiv, text: full, applied, target, target2, error, cancelled });
          const next = addMessage('assistant', '');
          div = next.div;
          textDiv = next.textDiv;
          toolLine = null;
          usedTools.length = 0;
          applied = null;
          target = null;
          target2 = null;
          error = null;
          cancelled = false;
          full = '';
          started = false;
        } else if (payload.action === 'none') {
          applied = 'none';
        } else if (payload.cancelled) {
          cancelled = true;
        } else if (payload.stopped) {
          stopReason = payload.stopped;
        }
      }
    }
  } catch (e) {
    maybeSetBusyFromError(e);
    hideTyping();
    generationStart = 0;
    setBusy(false);
    throw e;
  }

  hideTyping();
  generationStart = 0;
  if (toolLine) {
    if (usedTools.length > 0) setToolLine(`Used ${usedTools.join(', ')}`);
    else toolLine.remove();
  }
  div._rawText = full; // final raw text for the copy/quote actions
  div._applied = applied;
  textDiv.innerHTML = renderAssistantText(full, applied) || (started ? '' : '<p>(no response)</p>');
  renderFeedback(div, { applied, target, target2, cancelled, error });
  if (stopReason) {
    const appliedCount = streamSteps.filter((s) => s.applied && s.applied !== 'none').length + (applied && applied !== 'none' ? 1 : 0);
    const note = document.createElement('div');
    note.className = 'feedback none';
    const labels = {
      done: null,
      none: appliedCount > 0
        ? `Finished after ${appliedCount} edit${appliedCount === 1 ? '' : 's'}`
        : null,
      cancelled: `Stopped by user after ${appliedCount} edit${appliedCount === 1 ? '' : 's'}`,
      error: `Stopped because an edit failed (${appliedCount} earlier edit${appliedCount === 1 ? '' : 's'} applied)`,
      limit: `Stopped after the safety limit of ${appliedCount} edit${appliedCount === 1 ? '' : 's'} — send "continue" for more`,
    };
    const text = labels[stopReason] ?? `Stopped (${stopReason})`;
    if (text) {
      note.textContent = text;
      div.appendChild(note);
    }
  }
  scrollToBottomIfNear();
  setBusy(false);
  return { full, applied, cancelled, error };
}

async function send() {
  if (busy || !sessionId || bridgeBusy) return;
  const message = input.value.trim();
  if (!message) return;
  input.value = '';
  addMessage('user', message);
  try {
    await streamMessage(message);
    // Attachments were consumed by this message.
    pendingAttachments.length = 0;
    renderChips();
  } catch (e) {
    if (e.name !== 'AbortError') {
      addSystemMessage(`error: ${e.message}`, true);
    }
  } finally {
    await refreshStatus();
    await refreshDocuments();
    await refreshSelection();
  }
}

function renderChips() {
  chipsEl.innerHTML = '';
  for (const att of pendingAttachments) {
    const chip = document.createElement('div');
    chip.className = 'chip';
    if (att.converting) chip.classList.add('converting');
    else if (att.converted === false) chip.classList.add('warn');
    const nameSpan = document.createElement('span');
    nameSpan.className = 'chip-name';
    if (att.converting) {
      nameSpan.textContent = `Reading ${att.name}…`;
    } else if (att.converted === false) {
      nameSpan.textContent = `${att.name} (could not read text)`;
    } else {
      nameSpan.textContent = att.name;
    }
    const removeBtn = document.createElement('button');
    removeBtn.className = 'chip-remove';
    removeBtn.setAttribute('aria-label', 'Remove attachment');
    removeBtn.textContent = '×';
    removeBtn.addEventListener('click', () => removeAttachment(att.id));
    chip.appendChild(nameSpan);
    chip.appendChild(removeBtn);
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
    const tempId = `pending-${Math.random().toString(36).slice(2)}`;
    pendingAttachments.push({ id: tempId, name: file.name, converting: true });
    renderChips();
    try {
      const att = await uploadFile(file);
      const idx = pendingAttachments.findIndex((a) => a.id === tempId);
      if (idx >= 0) pendingAttachments[idx] = { ...att, converting: false };
      renderChips();
      if (att.converted === false) {
        addSystemMessage(`Could not read text from ${file.name}. It was still attached; the agent can try to read it itself.`, true);
      }
    } catch (e) {
      const idx = pendingAttachments.findIndex((a) => a.id === tempId);
      if (idx >= 0) pendingAttachments.splice(idx, 1);
      renderChips();
      addSystemMessage(`attachment "${file.name}" failed: ${e.message}`, true);
    }
  }
  input.focus();
});

// Refresh the LibreOffice context (active document tab + selection indicator) only
// when the user interacts with the composer — never on a timer. Every pipe
// LFUN dispatched into LibreOffice makes LibreOffice snap its view back to the cursor, so
// even a 2s `server-get-filename` poll breaks wheel-scrolling an unfocused
// LibreOffice window (Windows scrolls inactive windows under the cursor). The
// authoritative context is re-read server-side when a message is sent.
function refreshLibreOfficeContext() {
  if (!sessionId || busy) return;
  refreshDocuments();
  refreshSelection();
}
let LibreOfficeContextRefreshTimer = null;
input.addEventListener('input', () => {
  if (LibreOfficeContextRefreshTimer) clearTimeout(LibreOfficeContextRefreshTimer);
  LibreOfficeContextRefreshTimer = setTimeout(refreshLibreOfficeContext, 400);
});
input.addEventListener('focus', refreshLibreOfficeContext);

// One document refresh per window focus: the pipe has no "list open
// buffers" LFUN, so this is how tabs opened/switched in LibreOffice get discovered
// after an app restart. A single LFUN on a deliberate focus change — unlike
// the old 2s poll, it never fires while the user scrolls an unfocused LibreOffice // window (scrolling does not change focus). Documents only: refreshing the
// selection dispatches a `copy` LFUN that overwrites the system clipboard,
// which we don't want on a passive window focus.
window.addEventListener('focus', () => {
  if (!sessionId || busy) return;
  refreshDocuments();
});

sendBtn.addEventListener('click', send);
input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
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
    await withbridgeBusy(api(`/api/session/${sessionId}/undo`, { method: 'POST' }));
    addSystemMessage('Undo sent to LibreOffice');
  } catch (e) {
    addSystemMessage(`Undo failed: ${e.message}`, true);
  }
});

reconnectBtn.addEventListener('click', reconnect);

let LibreOfficeFollowMode = false;
pinBtn.addEventListener('click', () => {
  LibreOfficeFollowMode = !LibreOfficeFollowMode;
  pinBtn.setAttribute('aria-pressed', String(LibreOfficeFollowMode));
  pinBtn.title = LibreOfficeFollowMode
    ? 'Float on top while LibreOffice is focused'
    : 'Floating disabled';
  window.electron?.toggleAlwaysOnTop?.();
});

function start() {
  input.placeholder = 'Ask the agent. It reads the document and your selection, then decides: reply here, insert at the cursor, or rewrite what you selected.';
  if (selectionEl) selectionEl.hidden = true;
  showEmpty();
  stopBtn.style.display = '';
  fileInput.style.display = '';
  sendBtn.title = 'Send message (Enter)';
  reconnectBtn.title = 'Reconnect: restart the agent session and re-read the document';
  pinBtn.setAttribute('aria-pressed', 'false');
  pinBtn.title = 'Floating disabled';
  cmdEl.addEventListener('blur', saveSettings);
  argsEl.addEventListener('blur', saveSettings);
  const settingsDetails = document.querySelector('.agent-settings');
  document.addEventListener('pointerdown', (e) => {
    if (settingsDetails instanceof HTMLDetailsElement && settingsDetails.open
        && !settingsDetails.contains(e.target)) {
      settingsDetails.open = false;
    }
  });
  updateComposerState();
  connect().catch((e) => {
    maybeSetBusyFromError(e);
    if (!bridgeBusy) {
      setStatusText(`failed to connect: ${e.message}`);
      statusEl.className = 'status bad';
    }
    const details = document.querySelector('.agent-settings');
    if (details && typeof details.open === 'boolean') details.open = true;
  });
}

// Settings load is async (server round-trip); connect must wait for it so the
// first session uses the persisted agent command instead of the HTML defaults.
loadSettings().finally(start);
