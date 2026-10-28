'use strict';

// File attachments: upload to the session, chips below the composer,
// removal. Attachment ids wait in state.pendingAttachments until the
// next message consumes them.

import {
  state,
  attachBtn,
  fileInput,
  chipsEl,
  input,
} from './state.js';
import { api } from './api.js';
import { addSystemMessage } from './messages.js';

export function renderChips() {
  chipsEl.innerHTML = '';
  for (const att of state.pendingAttachments) {
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
  const i = state.pendingAttachments.findIndex((a) => a.id === id);
  if (i >= 0) state.pendingAttachments.splice(i, 1);
  renderChips();
  try {
    await api(`/api/session/${state.sessionId}/attachments/${id}`, { method: 'DELETE' });
  } catch {
    /* already gone */
  }
}

function uploadFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const base64 = String(reader.result).split(',')[1] ?? '';
      api(`/api/session/${state.sessionId}/attachments`, {
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
  if (!state.sessionId || state.busy) return;
  fileInput.value = '';
  fileInput.click();
});

fileInput.addEventListener('change', async () => {
  if (!state.sessionId || state.busy) return;
  for (const file of fileInput.files ?? []) {
    const tempId = `pending-${Math.random().toString(36).slice(2)}`;
    state.pendingAttachments.push({ id: tempId, name: file.name, converting: true });
    renderChips();
    try {
      const att = await uploadFile(file);
      const idx = state.pendingAttachments.findIndex((a) => a.id === tempId);
      if (idx >= 0) state.pendingAttachments[idx] = { ...att, converting: false };
      renderChips();
      if (att.converted === false) {
        addSystemMessage(`Could not read text from ${file.name}. It was still attached; the agent can try to read it itself.`, true);
      }
    } catch (e) {
      const idx = state.pendingAttachments.findIndex((a) => a.id === tempId);
      if (idx >= 0) state.pendingAttachments.splice(idx, 1);
      renderChips();
      addSystemMessage(`attachment "${file.name}" failed: ${e.message}`, true);
    }
  }
  input.focus();
});