/**
 * Prompt construction for the LyX app: the auto and continuation
 * prompts, history-replay rendering, the corrective markup-retry prompt,
 * and attachment-text extraction.
 */
import {
  MAX_ACTIONS_PER_MESSAGE,
  buildAttachmentBlock,
  createAttachmentExtractor,
  formatHistoryReplay as coreFormatHistoryReplay,
  type Attachment,
  type Turn,
  type TurnMeta,
} from '@acp-assist/core';
import { CHAT_KNOWLEDGE } from './knowledge.js';
import type { ActionOutcome, AgentAction } from './actions.js';

/**
 * Continuation prompt after a successfully applied edit. The document was
 * just edited, so the fresh context below has the NEW paragraph numbering;
 * the agent must not reuse addresses from before the edit.
 */
export function buildContinuationPrompt(
  contextText: string,
  selection: { hasSelection: boolean; lyxBody: string | null; text: string | null; layout: string | null },
  originalMessage: string,
  completed: string[],
): string {
  const parts = [
    'You are continuing the SAME user request after one edit was applied ' +
      'to the live LyX document. The document context below is FRESH: ' +
      'paragraph addresses ([pN]) may have shifted because of the edit.',
    '',
    'Original user request:', originalMessage,
    '',
    'Edits already applied (do not repeat them):',
    ...completed.map((entry) => `- ${entry}`),
    '',
    'If the request needs MORE edits, END your reply with exactly one ' +
      'document action tag from the action list (rewrite-at, insert-after, ' +
      'insert-before, insert-top, insert, rewrite, delete-at, merge, move) ' +
      'on its own last line, and include the ```lyx block when the action ' +
      'needs content.',
    `If the request is now complete, or you need the user to answer a ` +
      `question, reply in prose only and end with [ACTION: none].`,
    `If you are not sure whether more edits remain, ask one short question ` +
      `with [ACTION: none] instead of guessing.`,
    `The app enforces a safety limit of ${MAX_ACTIONS_PER_MESSAGE} document ` +
      `edits per user message; if that limit is reached it stops and tells ` +
      `the user, who can ask you to continue in a follow-up message.`,
    '',
    CHAT_KNOWLEDGE,
    '',
    contextText,
  ];
  if (selection.hasSelection) {
    parts.push(
      '',
      `Current LyX selection (cursor paragraph layout: ${selection.layout ?? 'unknown'}):`,
      '```lyx',
      selection.lyxBody ?? selection.text ?? '',
      '```',
    );
  }
  return parts.join('\n');
}

/**
 * Format the leading `unseen` turns of a conversation for replay into an
 * agent prompt: one compact line per turn (roles swapped to User/You),
 * action outcomes as short parenthetical notes, whitespace collapsed and
 * each turn truncated. `unseen` is the number of leading turns the agent
 * has not seen (restored from persisted history after an app restart);
 * later turns were produced live by this same agent process and are
 * skipped.
 */
/** Replay rendering shared by the history wrapper and the conversation store. */
export const LYX_REPLAY_OPTIONS = {
  blockPattern: /```lyx[\s\S]*?```/g,
  describeTarget: (m: TurnMeta) =>
    `${m.target ? ` p${m.target}` : ''}${m.target2 ? ` p${m.target2}` : ''}`,
};

export function formatHistoryReplay(turns: Turn[], unseen: number): string {
  return coreFormatHistoryReplay(turns, unseen, LYX_REPLAY_OPTIONS);
}

export function buildAutoPrompt(
  contextText: string,
  selection: {
    hasSelection: boolean;
    lyxBody: string | null;
    text: string | null;
    layout: string | null;
  },
  message: string,
  attachments: Attachment[] = [],
  historyPrefix = '',
): string {
  const parts: string[] = [
    'You are assisting an author writing a document in LyX. Your reply is shown ' +
      'in a chat panel, and you can also write content directly into the live ' +
      'LyX document.',
    '',
    'Decide yourself what the user wants, and END your reply with exactly one ' +
      'of these action tags on its own last line:',
    '- [ACTION: none] to reply in prose only (questions, explanations, ' +
      'discussion, outlines, planning).',
    '- [ACTION: insert] to insert NEW content at the CURSOR (its current ' +
      'position, which you do not control): include a ```lyx fenced block. ' +
      'CAREFUL: the paste happens INSIDE the cursor\'s paragraph, so the ' +
      'first pasted paragraph merges into it and takes that paragraph\'s ' +
      'layout — only use this when the user clearly wants the content at ' +
      'the cursor.',
    '- [ACTION: insert-top] to insert NEW content at the VERY BEGINNING of ' +
      'the document (titles, abstracts, anything that belongs above the ' +
      'first paragraph): include a ```lyx fenced block.',
    '- [ACTION: insert-after pN] to insert NEW content as its own ' +
      'paragraph(s) right AFTER paragraph [pN] from the outline (use this ' +
      'when the user asks to add a section/paragraph to the document and ' +
      'the position follows from the outline): include a ```lyx fenced block.',
    '- [ACTION: insert-before pN] to insert NEW content as its own ' +
      'paragraph(s) right BEFORE paragraph [pN] from the outline (e.g. an ' +
      'intro paragraph in front of [pN], or a heading above [pN]; use ' +
      'insert-top for the very beginning of the document): include a ```lyx ' +
      'fenced block.',
    '- [ACTION: rewrite] to REPLACE the currently selected text (given ' +
      'below): include a ```lyx fenced block with the complete replacement.',
    '- [ACTION: delete-at pN] to DELETE the entire paragraph [pN] from the ' +
      'outline (use when the user asks to remove a specific paragraph): ' +
      'NO fenced block, just the tag.',
    '- [ACTION: merge pN pM] to merge two ADJACENT paragraphs [pN] and ' +
      '[pM] into ONE paragraph (M must be N+1; the merged paragraph keeps ' +
      '[pN]\'s layout): NO fenced block, just the tag. To SPLIT one ' +
      'paragraph instead, use [ACTION: rewrite-at pN] with two (or more) ' +
      '```lyx paragraphs in the fenced block — the paragraph is replaced ' +
      'by them, splitting it at the point you choose.',
    '- [ACTION: move pN pM] to MOVE the entire paragraph [pN] so it ends ' +
      'up right AFTER paragraph [pM] (p0 = the very top of the document; ' +
      'use when the user asks to reorder or move a paragraph): NO fenced ' +
      'block, just the tag. N and M are original outline numbers; the app ' +
      'adjusts for the removal. Moving pN after p(N-1) changes nothing, ' +
      'so never emit that.',
    '- [ACTION: rewrite-at pN] to REPLACE the entire paragraph [pN] from ' +
      'the outline (use this when the user asks to modify, fix or remove ' +
      'content in a specific paragraph and nothing is selected): include a ' +
      '```lyx fenced block with the complete replacement paragraph(s).', +
      ' When one request needs SEVERAL edits, apply the FIRST edit now and ' +
      'let the app ask you again with fresh paragraph numbers for the next ' +
      'one — do not try to plan later edits against the current outline.',
    '',
    'Rules for document actions:',
    '- The ```lyx block must contain just the \\begin_layout ... \\end_layout ' +
      'paragraphs (no document header).',
    '- Follow the .lyx cheat-sheet below (token-format emphasis, Formula ' +
      'insets, ...).',
    '- Match the document\'s own conventions: prefer layouts that appear in ' +
      'the outline or in the class layout list of the document context, ' +
      'never invent layout names.',
    '- For a document title or similar front matter use the Title layout ' +
      'and [ACTION: insert-top], NOT insert (insert would land wherever ' +
      'the cursor happens to be).',
    '- For rewrite: output the complete replacement, preserving references, ' +
      'labels and citations unless asked otherwise.',
    '- If nothing is selected you cannot rewrite; choose insert, ' +
      'insert-top, or none.',
    '- The action tag must be the very last line of your reply.',
    '',
    CHAT_KNOWLEDGE,
    '',
    contextText,
  ];
  if (selection.hasSelection) {
    parts.push(
      '',
      `Current LyX selection (cursor paragraph layout: ${selection.layout ?? 'unknown'}). ` +
        'The user may ask you to rewrite it:',
      '```lyx',
      selection.lyxBody ?? selection.text ?? '',
      '```',
    );
  }
  if (historyPrefix) parts.push(historyPrefix);
  parts.push('', 'User message:', message);
  parts.push(...buildAttachmentBlock(attachments));
  return parts.join('\n');
}

/**
 * Best-effort text/markdown extraction for an uploaded attachment:
 * text formats are read directly; binary formats (PDF, DOCX, XLSX, ...)
 * go through the markitdown CLI when it is installed (see
 * @acp-assist/core for the converter chain).
 */
export const extractAttachmentText = createAttachmentExtractor({
  extensions: [
    'txt', 'md', 'markdown', 'tex', 'lyx', 'csv', 'tsv', 'json', 'xml',
    'bib', 'sty', 'cls', 'log', 'htm', 'html', 'yaml', 'yml', 'py', 'js', 'ts',
  ],
  envVar: 'LYX_MARKITDOWN',
});

/** Corrective retry prompt when the ```lyx block has markup problems. */
export function buildMarkupRetryPrompt(action: AgentAction, problems: string[]): string {
  return (
    `Your [ACTION: ${action}] content had problems and must be re-written in ` +
    'valid LyX internal format (.lyx):\n' +
    problems.map((p) => `- ${p}`).join('\n') +
    '\n\nReference example of valid .lyx body markup with emphasis:\n' +
    '```lyx\n\\begin_layout Standard\n\\emph on\nFuture work\n\\emph default\n' +
    ' will explore larger datasets.\n\\end_layout\n```\n' +
    'Math uses \\begin_inset Formula $x^2$\\end_inset. ' +
    'Do NOT use LaTeX inline commands like \\emph{...}.\n' +
    'Reply again with ONLY the corrected ```lyx fenced block ' +
    '(just \\begin_layout...\\end_layout paragraphs, no header), followed by ' +
    `the same action tag [ACTION: ${action}] on its own last line.`
  );
}