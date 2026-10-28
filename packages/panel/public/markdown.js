'use strict';

// Minimal markdown rendering for assistant replies: escape first, then
// restore safe inline markup, with the app's fenced content blocks as
// real code blocks.

import { FENCE_STRIP_SRC, FENCE_BLOCK_SRC } from './state.js';

export function escapeHtml(text) {
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
export function renderAssistantText(full, applied) {
  let text = full.replace(/\[ACTION:\s*[^\]]*\]/gi, '').trim();
  if (applied && applied !== 'none') {
    text = text.replace(new RegExp(FENCE_STRIP_SRC, 'g'), '').trim();
  }
  if (!text) return '';

  const parts = [];
  const regex = new RegExp(FENCE_BLOCK_SRC, 'g');
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