/**
 * Shared types for the ACP companion apps (LyX ACP Assist, LibreOffice
 * ACP Assist). Kept as a superset: TurnMeta carries every app's optional
 * fields (target, target2, address, module) so persisted histories from
 * either app type-check against it.
 */

import type { ContentBlock } from '@agentclientprotocol/sdk';

export interface AgentSettings {
  command: string;
  args: string[];
  env: Record<string, string>;
}

export interface Turn {
  role: 'user' | 'assistant';
  content: string;
  timestamp: string;
  /**
   * Outcome of the action the assistant proposed in this turn, recorded
   * after the action was applied (or failed). Absent on older histories
   * and on turns before this feature existed.
   */
  meta?: TurnMeta;
}

/** How the action a turn proposed was resolved against the document. */
export interface TurnMeta {
  /** The action tag the agent emitted, e.g. "insert", "move", "none". */
  action: string;
  /** Paragraph address for addressed actions ([pN]). */
  target?: number | null;
  /** Destination address for move/merge ([pM]). Writer (LyX) only. */
  target2?: number | null;
  /** Calc: A1 anchor address, when the tag carried one. */
  address?: string | null;
  /** Active bridge module (writer/calc/impress/draw) for UI labels. */
  module?: string | null;
  /** "applied" when the action landed in the document, "error" otherwise. */
  result: 'applied' | 'error' | 'cancelled';
  /** The error message when result is "error". */
  error?: string;
  /** Which edit of a multi-action run this turn is (1-based). */
  step?: number;
}

/** Minimal agent surface the server needs (AcpClient satisfies this). */
export interface AgentRunner {
  start(): Promise<void>;
  stop(): void;
  createSession(sessionId: string): Promise<void>;
  cancel(sessionId: string): void;
  prompt(
    sessionId: string,
    content: ContentBlock[],
    options?: {
      onChunk?: (chunk: string) => void;
      onToolCall?: (tool: { title: string; status: string; kind: string }) => void;
      timeoutMs?: number;
    },
  ): Promise<string>;
}

/** A file the user attached to the next message. */
export interface Attachment {
  id: string;
  name: string;
  /** Absolute path of the stored file (agents with file tools can read it). */
  path: string;
  /** Extracted markdown/plain text, when conversion succeeded. */
  text: string | null;
}