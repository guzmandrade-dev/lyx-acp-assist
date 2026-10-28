/**
 * Barrel for the LyX app's extracted backend modules (re-exported from
 * src/server.ts for tests and dev tools).
 */
export {
  parseAction,
  describeAction,
  type ActionOutcome,
  type AgentAction,
} from './actions.js';
export {
  buildAutoPrompt,
  buildContinuationPrompt,
  buildMarkupRetryPrompt,
  extractAttachmentText,
  formatHistoryReplay,
} from './prompts.js';
export {
  normalizeForCompare,
  isLikelyMatch,
  verifyParagraphSelection,
  type ParagraphSelectionInput,
  type ParagraphVerification,
} from './verification.js';
export { findClassLayouts } from './layouts.js';