/**
 * Fallback adapter for modules without edit support yet (Calc, Impress,
 * Draw, …). The agent can still chat about the document, but every
 * document action is refused with a clear message.
 */

import type { BridgeClient, BridgeDocument } from '../bridge/client.js';
import type { ActionOutcome, AppliedAction, ModuleAdapter, SelectionInfo } from './types.js';

export const genericAdapter: ModuleAdapter = {
  id: 'generic',

  buildActionInstructions(): string {
    return [
      'This document type is not yet supported for direct edits.',
      'You can still discuss, plan, summarize, and answer questions about',
      'the document. End every reply with [ACTION: none].',
    ].join('\n');
  },

  buildContextBlock(doc: BridgeDocument, _filePath: string | null): string {
    return [
      'Document context',
      '================',
      `Title: ${doc.title}`,
      `Module: ${doc.module} (no edit support yet)`,
    ].join('\n');
  },

  buildSelectionBlock(sel: SelectionInfo): string {
    if (!sel.hasSelection) return '';
    return ['', 'Current selection:', '```text', sel.text ?? '', '```'].join('\n');
  },

  async applyAction(
    _bridge: BridgeClient,
    _doc: BridgeDocument,
    _sel: SelectionInfo,
    outcome: ActionOutcome,
  ): Promise<AppliedAction> {
    throw new Error(
      `Document edits are not supported for this module yet ([ACTION: ${outcome.action}] refused). ` +
        'Reply in prose with [ACTION: none].',
    );
  },
};