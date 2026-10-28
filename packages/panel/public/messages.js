'use strict';

// Chat messages: rendering, the empty state, auto-follow scrolling, the
// question-tick rail, and the per-message quote/copy actions.

import {
  CONFIG,
  APP,
  FENCE_STRIP_SRC,
  state,
  chat,
  input,
  scrollTicks,
} from './state.js';
import { renderAssistantText } from './markdown.js';
import { hideTyping } from './typing.js';
import { renderFeedback } from './conversation.js';

const QUOTE_ICON = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
  + '<path d="M3 21c3 0 7-1 7-8V5c0-1.25-.756-2.017-2-2H4c-1.25 0-2 .75-2 1.972V11c0 1.25.75 2 2 2 1 0 1 0 1 1v1c0 1-1 2-2 2s-1 .008-1 1.031V20c0 1 0 1 1 1z"/>'
  + '<path d="M15 21c3 0 7-1 7-8V5c0-1.25-.757-2.017-2-2h-4c-1.25 0-2 .75-2 1.972V11c0 1.25.75 2 2 2h.75c0 2.25.25 4-2.75 4v3c0 1 0 1 1 1z"/>'
  + '</svg>';
const COPY_ICON = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
  + '<rect x="9" y="9" width="13" height="13" rx="2"/>'
  + '<path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>'
  + '</svg>';

function showEmpty() {
  if (!state.emptyEl) {
    const emptyEl = document.createElement('div');
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
    name.textContent = CONFIG.appTitle ?? APP + ' ACP Assist';
    const hint = document.createElement('div');
    hint.textContent =
      'Select text in ' + APP + ' or type a request. The agent will reply here or write directly into the document.';
    emptyEl.append(logo, name, hint);
    state.emptyEl = emptyEl;
  }
  // Re-append so the empty state is the LAST child: with flex:1 + margin
  // removed it stretches to fill the chat area and centers itself. Any
  // stale trailing nodes (e.g. a leftover typing indicator) move above it.
  chat.appendChild(state.emptyEl);
  state.emptyEl.hidden = false;
}

function hideEmpty() {
  if (state.emptyEl) state.emptyEl.hidden = true;
}

/**
 * Auto-follow: keep the chat pinned to the bottom while messages and
 * streamed chunks arrive, unless the user scrolled up to read. "Near
 * bottom" comes from the last scroll position, NOT re-measured after an
 * append — a single appended message (~82px: bubble + gap) is taller
 * than the old 60px post-hoc check, which silently disabled following in
 * long transcripts.
 */
chat.addEventListener('scroll', () => {
  state.followChat = chat.scrollHeight - chat.scrollTop - chat.clientHeight < 60;
});

export function scrollToBottomIfNear() {
  if (state.followChat) chat.scrollTop = chat.scrollHeight;
}

/**
 * Question ticks — small markers on a rail beside the chat, one per user
 * question (GitHub-Copilot-style), so long agent responses stay
 * navigable: hover shows the question, click scrolls it to the top.
 */
function updateScrollTicks() {
  if (!scrollTicks) return;
  const msgs = Array.from(chat.querySelectorAll('.msg.user'));
  const rebuilt =
    msgs.length !== state.tickMsgs.length || msgs.some((m, i) => m !== state.tickMsgs[i]);
  if (rebuilt) {
    scrollTicks.replaceChildren();
    for (const m of msgs) {
      const tick = document.createElement('button');
      tick.type = 'button';
      tick.className = 'scroll-tick';
      const preview = (m.querySelector('.text')?.textContent ?? '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 120);
      tick.title = preview;
      tick.setAttribute('aria-label', `Jump to question: ${preview}`);
      tick.addEventListener('click', () => {
        // offsetTop is relative to main's padding box (main is the
        // positioned offsetParent) — the same coordinate space scrollTop
        // uses. Leave a small breathing gap above the question.
        chat.scrollTo({ top: Math.max(0, m.offsetTop - 12), behavior: 'smooth' });
      });
      tick._msg = m;
      scrollTicks.appendChild(tick);
    }
    state.tickMsgs = msgs;
  }
  // No scrollbar, no rail: ticks are navigation for long transcripts.
  scrollTicks.hidden = chat.scrollHeight <= chat.clientHeight;
  const total = chat.scrollHeight;
  const railH = scrollTicks.clientHeight;
  for (const tick of scrollTicks.children) {
    const m = tick._msg;
    const center = m.offsetTop + m.offsetHeight / 2;
    const y = total > 0 ? (center / total) * railH : 0;
    tick.style.top = `${Math.max(7, Math.min(railH - 7, y))}px`;
  }
}

// Track new messages, history replays, and the typing indicator's
// visibility without touching the streaming hot path (childList of chat's
// direct children only — streamed text lives deeper in the subtree). The
// observer batches records, so the synchronous update runs once per
// change batch — rAF is deliberately avoided because it is paused while
// the panel window is hidden (user switched to the editor), which would
// leave stale ticks behind.
new MutationObserver(updateScrollTicks).observe(chat, {
  childList: true,
  attributes: true,
  attributeFilter: ['hidden'],
});
window.addEventListener('resize', updateScrollTicks);

/**
 * Plain-text form of a message for copy/quote: the raw turn content with
 * the action tag stripped (and, for applied write actions, the fenced
 * content block stripped too) — mirroring what renderAssistantText
 * shows. Read from the div at click time so streamed assistant messages
 * quote their final text.
 */
function messagePlainText(div) {
  const raw = div._rawText ?? div.querySelector('.text')?.textContent ?? '';
  if (!div.classList.contains('assistant')) return raw;
  let text = raw.replace(/\[ACTION:\s*[^\]]*\]/gi, '').trim();
  if (div._applied && div._applied !== 'none') {
    text = text.replace(new RegExp(FENCE_STRIP_SRC, 'g'), '').trim();
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

export function addMessage(role, content, opts = {}) {
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

export function addSystemMessage(text, assertive = false) {
  return addMessage('system', text, { assertive });
}

/**
 * Replace the chat panel with the given (persisted) conversation, or the
 * empty state when there are no turns. Used on connect and when switching
 * documents — each document has its own history.
 */
export function renderConversation(turns) {
  chat.innerHTML = '';
  state.typingIndicator = null;
  hideTyping();
  if (!turns || turns.length === 0) {
    showEmpty();
    return;
  }
  hideEmpty();
  for (let i = 0; i < turns.length; i++) {
    const turn = turns[i];
    // Applied write actions strip their content block in the render (the
    // live stream does the same); pass the persisted outcome through.
    const appliedAction =
      turn.role === 'assistant' && turn.meta?.result === 'applied' && turn.meta.action !== 'none'
        ? turn.meta.action
        : undefined;
    const { div } = addMessage(turn.role, turn.content, { applied: appliedAction });
    // Restore a persisted action outcome (applied/error/cancelled) from a
    // previous app run, so failures are visible after a restart.
    if (turn.role === 'assistant' && turn.meta) {
      // Remember the outcome so copy/quote strips the ```writer block like the render does.
      div._applied = turn.meta.result === 'applied' ? turn.meta.action : null;
      // The [ACTION: none] summary step that closed a multi-action run is
      // persisted with result "applied", action "none"; replaying it with
      // "document unchanged" under the applied edit right before it would
      // be misleading — skip the label there, like the live stream.
      const prev = turns[i - 1];
      const summaryContinuation =
        turn.meta.result === 'applied' && turn.meta.action === 'none'
        && prev?.role === 'assistant' && prev.meta?.result === 'applied'
        && !!prev.meta?.action && prev.meta.action !== 'none';
      if (!summaryContinuation) {
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
          address: turn.meta.address ?? null,
          module: turn.meta.module ?? null,
          cancelled: turn.meta.result === 'cancelled',
          error: turn.meta.result === 'error' ? turn.meta.error : null,
        });
      }
    }
  }
}

export { showEmpty, hideEmpty };