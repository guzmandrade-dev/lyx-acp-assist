/**
 * Module adapter contract: everything the server needs to serve one
 * LibreOffice module (Writer, Calc, Impress). The bridge reports the
 * active module type; the server picks the adapter. Calc and Impress are
 * new adapters, not new architectures.
 */

import type { BridgeClient, BridgeDocument, BlockParagraph } from '../bridge/client.js';

/** Writer action vocabulary (see README / writer adapter). */
export type AgentAction =
  | 'none'
  | 'continue'
  | 'insert'
  | 'insert-top'
  | 'insert-after'
  | 'rewrite'
  | 'rewrite-at'
  | 'delete-at';

/** A parsed agent action tag plus its content block. */
export interface ActionOutcome {
  action: AgentAction;
  /** Parsed content paragraphs; null for none/continue/delete-at or missing block. */
  block: BlockParagraph[] | null;
  /** 1-based paragraph address for insert-after / rewrite-at / delete-at. */
  target: number | null;
}

/** What the server knows about the selection right now. */
export interface SelectionInfo {
  hasSelection: boolean;
  /** The selection's plain text (first range), or null. */
  text: string | null;
  /** Style name of the paragraph containing the cursor. */
  cursorStyle: string | null;
}

/** Result of applying one action. */
export interface AppliedAction {
  /** Compact description for the continuation prompt + UI meta. */
  description: string;
}

export interface ModuleAdapter {
  /** Bridge module id this adapter serves ("writer", "calc", ...). */
  id: string;

  /** Prompt instructions: action vocabulary + ```writer block format. */
  buildActionInstructions(): string;

  /** Agent-facing document context block. */
  buildContextBlock(doc: BridgeDocument, filePath: string | null): string;

  /** Selection block for the prompt (empty string when nothing selected). */
  buildSelectionBlock(sel: SelectionInfo): string;

  /** Optional: compact outline for the UI (Writer: [pN] lines). */
  renderOutline?(doc: BridgeDocument): string;

  /**
   * Apply one action. Validates preconditions (target exists, content
   * present, selection present) and throws with a user-facing message
   * when the action cannot be applied — nothing is written then.
   */
  applyAction(bridge: BridgeClient, doc: BridgeDocument, sel: SelectionInfo, outcome: ActionOutcome): Promise<AppliedAction>;
}

/** The built-in Writer adapter (Phase 1). */
export { writerAdapter } from './writer.js';