'use strict';

// The typing indicator: three animated dots plus an elapsed-time hint
// line, so multi-minute generations read as deliberate rather than stuck.

import { state, chat } from './state.js';
import { scrollToBottomIfNear } from './messages.js';

function ensureTypingIndicator() {
  if (!state.typingIndicator) {
    const t = document.createElement('div');
    t.className = 'typing';
    // Animated three-dot scale-pulse: a visible "the agent is still
    // working" signal during long generations (the text alone pulses
    // subtly).
    t.innerHTML =
      '<span class="sr-only">Agent is thinking</span>' +
      '<span class="tdots" aria-hidden="true"><i></i><i></i><i></i></span>';
    state.typingIndicator = t;
  }
  return state.typingIndicator;
}

/**
 * The indicator gets a hint line with an elapsed-time readout
 * ("Thinking… 1m 43s"). The clock measures the whole turn
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
  const elapsed = state.generationStart ? Date.now() - state.generationStart : 0;
  let text = TYPING_HINTS[0].text;
  for (const h of TYPING_HINTS) {
    if (elapsed >= h.after) text = h.text;
  }
  return `${text} ${formatElapsed(elapsed)}`;
}

function setTypingHint() {
  if (!state.typingIndicator || !state.generationStart) return;
  let hintEl = state.typingIndicator.querySelector('.typing-hint');
  if (!hintEl) {
    hintEl = document.createElement('span');
    hintEl.className = 'typing-hint';
    state.typingIndicator.appendChild(hintEl);
  }
  hintEl.textContent = typingHintText();
}

export function showTyping() {
  const t = ensureTypingIndicator();
  if (!t.parentElement) chat.appendChild(t);
  t.hidden = false;
  setTypingHint();
  if (!state.typingTimer) {
    state.typingTimer = setInterval(() => {
      if (state.typingIndicator && !state.typingIndicator.hidden) setTypingHint();
    }, 1000);
  }
  scrollToBottomIfNear();
}

export function hideTyping() {
  if (state.typingIndicator) state.typingIndicator.hidden = true;
  if (state.typingTimer) {
    clearInterval(state.typingTimer);
    state.typingTimer = null;
  }
  if (state.typingResumeTimer) {
    clearTimeout(state.typingResumeTimer);
    state.typingResumeTimer = null;
  }
}

export function scheduleTypingResume() {
  if (state.typingResumeTimer) clearTimeout(state.typingResumeTimer);
  state.typingResumeTimer = setTimeout(() => {
    if (state.busy) showTyping();
  }, 1000);
}