/**
 * Calc module adapter: builds the agent's spreadsheet context (sheet
 * inventory, active-sheet data, selection with values AND formulas) and
 * applies cell-addressed actions through the bridge.
 *
 * Addressing is A1 ("B2"); content goes in a ```calc TSV block (one sheet
 * row per line, cells split on tabs; a cell starting with '=' is written
 * as a formula). Edits land inside one undo transaction, recorded as
 * tracked changes.
 */

import type { BridgeClient, BridgeDocument, CalcInfo, CalcSelection } from '../bridge/client.js';
import { extractContentBlock, parseTsvBlock, actionTagNote, createParseActionTag } from './markdown.js';
import type { ActionOutcome, AppliedAction, AgentAction, ModuleAdapter, SelectionInfo } from './types.js';

/** Grammar: [ACTION: name] or [ACTION: name B2] (A1 anchor). The header
 * tolerates tag typos ("[AACTION:"), reported via tagNote; the B5 layered
 * resolution lives in the core factory. */
const parseTag = createParseActionTag({
  actions: 'write-cells|insert-rows|insert-cols|rewrite|none|continue',
  targetPattern: '(?:\\s+([A-Za-z]{1,4}[1-9][0-9]{0,6}))?',
});

/** Parse an agent reply against the Calc vocabulary. */
export function parseCalcAction(reply: string): ActionOutcome {
  const tag = parseTag(reply);
  const action = tag.action as AgentAction;
  const address = tag.target ? tag.target.toUpperCase() : null;
  const contentActions: AgentAction[] = ['write-cells', 'rewrite'];
  const needsContent = contentActions.includes(action);
  const rawBlock = needsContent ? extractContentBlock(reply, 'calc') : null;
  return {
    action,
    target: null,
    address,
    block: null,
    grid: needsContent && rawBlock !== null ? parseTsvBlock(rawBlock) : null,
    tagNote: actionTagNote(tag.rawTag ?? undefined, `[ACTION: ${action}${address ? ` ${address}` : ''}]`),
  };
}

// --- A1 helpers (context rendering only; the bridge validates writes) ---

function colToIndex(letters: string): number {
  let n = 0;
  for (const ch of letters.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

/** "A1:B3" -> {c0, r0, c1, r1} 0-based inclusive; null when malformed. */
function parseRange(a1: string): { c0: number; r0: number; c1: number; r1: number } | null {
  const m = a1.match(/^([A-Za-z]{1,4})([0-9]+):([A-Za-z]{1,4})([0-9]+)$/);
  if (!m || !m[1] || !m[2] || !m[3] || !m[4]) return null;
  return {
    c0: colToIndex(m[1]),
    r0: Number.parseInt(m[2], 10) - 1,
    c1: colToIndex(m[3]),
    r1: Number.parseInt(m[4], 10) - 1,
  };
}

/** "Sheet1!A1:B3" -> "A1:B3". */
function stripSheet(range: string): string {
  const i = range.indexOf('!');
  return i === -1 ? range : range.slice(i + 1);
}

/** True when the selection is fully covered by the shown sheet data. */
function coveredByData(calc: CalcInfo | null): boolean {
  const sel = calc?.selection;
  const data = calc?.data;
  if (!sel || !data || data.truncated || sel.truncated) return false;
  if (sel.sheet !== data.sheet) return false;
  const d = parseRange(data.range);
  const s = parseRange(stripSheet(sel.ranges[0] ?? ''));
  if (!d || !s) return false;
  return s.c0 >= d.c0 && s.c1 <= d.c1 && s.r0 >= d.r0 && s.r1 <= d.r1;
}

function toTsv(grid: string[][]): string {
  return grid.map((row) => row.join('\t')).join('\n');
}

function renderGrid(title: string, grid: { values: string[][]; formulas: string[][] | null; truncated: boolean }): string {
  const lines: string[] = [title];
  lines.push('```tsv');
  lines.push(toTsv(grid.values));
  if (grid.truncated) lines.push('…(truncated)');
  lines.push('```');
  if (grid.formulas) {
    lines.push('', `${title} — formulas (plain values where no formula):`, '```tsv');
    lines.push(toTsv(grid.formulas));
    if (grid.truncated) lines.push('…(truncated)');
    lines.push('```');
  }
  return lines.join('\n');
}

export const calcAdapter: ModuleAdapter = {
  id: 'calc',

  buildActionInstructions(): string {
    return [
      'Decide yourself what the user wants, and END your reply with exactly one',
      'of these action tags on its own last line:',
      '- [ACTION: none] to reply in prose only (questions, explanations,',
      '  discussion, planning).',
      '- [ACTION: write-cells] to write a block of cells with the selection\'s',
      '  top-left cell as the anchor, or [ACTION: write-cells B2] with an',
      '  explicit A1 anchor: include a ```calc block.',
      '- [ACTION: rewrite] to REPLACE the selected cells: include a ```calc',
      '  block with the complete replacement grid (anchored at the',
      '  selection\'s top-left cell).',
      '- [ACTION: insert-rows] to insert one empty row ABOVE the selection\'s',
      '  anchor row, or [ACTION: insert-rows A5] above a given cell.',
      '- [ACTION: insert-cols] to insert one empty column LEFT of the',
      '  selection\'s anchor column, or [ACTION: insert-cols C1].',
      '',
      'Content format (```calc block): tab-separated cells, one sheet row per',
      'line. A cell starting with "=" is written as a formula (e.g.',
      '=SUM(B2:B10)). An empty cell clears the target cell. Use column',
      'letters in formulas exactly as shown in the document context.',
      '',
      'Rules for document actions:',
      '- The action tag must be the very last line of your reply.',
      '- The action is applied to the LIVE document, recorded as a tracked',
      '  change the user can accept or reject in Edit > Track Changes.',
      '- Cell contents you cannot see in the context are still there: the',
      '  context shows the active sheet\'s used range (capped) and the',
      '  selection. Never overwrite cells outside what the user asked for.',
      '- When one request needs SEVERAL edits, apply the FIRST edit now and',
      '  end with its action tag; the app re-prompts you with fresh context',
      '  for the next edit.',
    ].join('\n');
  },

  buildContextBlock(doc: BridgeDocument, filePath: string | null): string {
    const calc = doc.calc;
    if (doc.module !== 'calc' || !calc) {
      return `Document context\n================\nActive document is not a Calc document (module: ${doc.module}).`;
    }
    const head = [
      'Document context',
      '================',
      `File: ${filePath ?? '(unsaved document)'}`,
      `Title: ${doc.title}`,
      `Sheets: ${calc.sheets.map((s) => `${s.name} (used ${s.usedRange})${s.active ? ' [active]' : ''}`).join(', ')}`,
      '',
    ].join('\n');
    const parts: string[] = [head];
    if (calc.data && calc.data.values.length > 0) {
      parts.push(renderGrid(`Active sheet "${calc.data.sheet}" (${calc.data.range}) — values:`, calc.data));
      parts.push('');
    } else if (calc.data) {
      parts.push(`Active sheet "${calc.data.sheet}" is empty (used range ${calc.data.range}).`, '');
    }
    if (calc.selection && !coveredByData(calc)) {
      parts.push(renderGrid(`Selected cells (${calc.selection.ranges.join(', ')}, anchor ${calc.selection.anchor}):`, calc.selection));
      parts.push('');
    }
    return parts.join('\n');
  },

  buildSelectionBlock(sel: SelectionInfo): string {
    const cs = sel.calc?.selection;
    if (!cs) return '';
    const lines = ['', `Current selection: ${cs.ranges.join(', ')} (anchor ${cs.anchor})`];
    if (!coveredByData(sel.calc)) {
      lines.push('```tsv');
      lines.push(toTsv(cs.values));
      lines.push('```');
    }
    return lines.join('\n');
  },

  renderOutline(doc: BridgeDocument): string {
    const calc = doc.calc;
    if (!calc) return '';
    return calc.sheets.map((s) => `${s.name} (used ${s.usedRange})${s.active ? ' *' : ''}`).join('\n');
  },

  async applyAction(
    bridge: BridgeClient,
    doc: BridgeDocument,
    sel: SelectionInfo,
    outcome: ActionOutcome,
  ): Promise<AppliedAction> {
    if (outcome.action === 'write-cells' || outcome.action === 'rewrite') {
      if (!outcome.grid || outcome.grid.length === 0) {
        throw new Error(
          `[ACTION: ${outcome.action}] needs a \`\`\`calc TSV content block; the reply contained none.`,
        );
      }
      if (outcome.action === 'rewrite' && !sel.calc?.selection) {
        throw new Error('[ACTION: rewrite] but the spreadsheet has no selection.');
      }
      const r = await bridge.edit({
        mode: 'write-cells',
        anchor: outcome.address ?? undefined,
        tracked: true,
        rows: outcome.grid,
      });
      const at = r.anchor ?? outcome.address ?? 'selection';
      return { description: `[ACTION: write-cells at ${at}]` };
    }
    if (outcome.action === 'insert-rows' || outcome.action === 'insert-cols') {
      const r = await bridge.edit({
        mode: outcome.action,
        anchor: outcome.address ?? undefined,
        count: 1,
        tracked: true,
      });
      const at = r.anchor ?? outcome.address ?? 'selection';
      return { description: `[ACTION: ${outcome.action} at ${at}]` };
    }
    throw new Error(`[ACTION: ${outcome.action}] is not a Calc document action.`);
  },
};
