/**
 * Module adapter contract: everything the server needs to serve one
 * LibreOffice module (Writer, Calc, Impress). The bridge reports the
 * active module type; the server picks the adapter. Calc and Impress are
 * new adapters, not new architectures.
 */

import type { BridgeClient, BridgeDocument, BlockParagraph, CalcInfo, SlidesSelectionShape } from '../bridge/client.js';

/** Action vocabulary (Writer tags first, then Calc, then Impress). */
export type AgentAction =
  | 'none'
  | 'continue'
  // Writer
  | 'insert'
  | 'insert-top'
  | 'insert-after'
  | 'rewrite'
  | 'rewrite-at'
  | 'delete-at'
  // Calc
  | 'write-cells'
  | 'insert-rows'
  | 'insert-cols'
  // Impress / Draw
  | 'rewrite-slide'
  | 'insert-after'
  | 'rewrite-frame';

/** A parsed agent action tag plus its content block. */
export interface ActionOutcome {
  action: AgentAction;
  /** Writer: parsed content paragraphs; null for actions without content. */
  block: BlockParagraph[] | null;
  /** Calc: parsed TSV rows; null for actions without content. */
  grid: string[][] | null;
  /** Writer: 1-based paragraph address for insert-after/rewrite-at/delete-at.
   * Impress: the [sN] slide number (rewrite-slide, insert-after; s0 = start). */
  target: number | null;
  /** Calc: A1 anchor address (e.g. "B2"), when the tag carries one. */
  address: string | null;
  /** Raw tag text when a near-miss tag (typo, missing colon) was
   *  auto-corrected by the tolerant parser; null when the tag was
   *  canonical or no tag matched. */
  tagNote?: string | null;
}

/** What the server knows about the selection right now. */
export interface SelectionInfo {
  hasSelection: boolean;
  /** The selection's plain text (first range), or null. */
  text: string | null;
  /** Style name of the paragraph containing the cursor. */
  cursorStyle: string | null;
  /** Calc only: sheets, selection grid, active-sheet data. */
  calc: CalcInfo | null;
  /** Impress/Draw only: the selected frames with (slide, shape) indices. */
  slidesSelection: SlidesSelectionShape[] | null;
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

/** The built-in module adapters: Writer, Calc, Impress. */
export { writerAdapter } from './writer.js';
export { calcAdapter } from './calc.js';
export { impressAdapter } from './impress.js';