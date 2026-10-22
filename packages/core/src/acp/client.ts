import { client } from '@agentclientprotocol/sdk';
import type {
  ClientApp,
  ContentBlock,
  ActiveSession,
  ClientConnection,
} from '@agentclientprotocol/sdk';
import fs from 'node:fs/promises';
import { spawnAgentProcess, type AgentProcess } from './agent-process.js';

export interface AcpClientOptions {
  /** App name used in the ACP handshake (e.g. "lyx-acp-assist"). */
  appName: string;
  /** Editor name for user-facing messages (e.g. "LyX", "LibreOffice"). */
  writerName: string;
  command: string;
  args: string[];
  env: Record<string, string>;
  cwd?: string;
}

export interface PromptOptions {
  /** Called with each text chunk as it streams in. */
  onChunk?: (chunk: string) => void;
  /** Called with each tool-call lifecycle update the agent emits. */
  onToolCall?: (tool: { title: string; status: string; kind: string }) => void;
  /** Abort with an error if the agent takes longer than this. */
  timeoutMs?: number;
}

export class AcpClient {
  private app: ClientApp;
  private process: AgentProcess | null = null;
  private connection: ClientConnection | null = null;
  private options: AcpClientOptions;
  private sessions = new Map<string, ActiveSession>();

  constructor(options: AcpClientOptions) {
    this.options = options;
    this.app = client({ name: options.appName });
    this.registerClientHandlers();
  }

  /**
   * Client-side handlers the agent may call mid-turn:
   * - fs/read_text_file: serve file reads (lazy document access).
   * - fs/write_text_file: REFUSED. The editor is the single writer of the
   *   document; agents must not write behind its back (see AGENTS.md).
   * - session/request_permission: auto-approve the agent's tool calls.
   *   This app deliberately delegates all work to the agent process.
   */
  private registerClientHandlers(): void {
    this.app.onRequest('fs/read_text_file', async (context) => {
      const { path, line, limit } = context.params as {
        path: string;
        line?: number | null;
        limit?: number | null;
      };
      const raw = await fs.readFile(path, 'utf8');
      const lines = raw.split('\n');
      const start = line && line > 0 ? line - 1 : 0;
      const slice =
        limit && limit > 0 ? lines.slice(start, start + limit) : lines.slice(start);
      return { content: slice.join('\n') };
    });

    this.app.onRequest('fs/write_text_file', () => {
      throw new Error(
        `Writing files is not allowed: ${this.options.writerName} is the single ` +
          'writer of the document. Reply with content and an [ACTION: ...] tag instead.',
      );
    });

    this.app.onRequest('session/request_permission', (context) => {
      const params = context.params as {
        toolCall?: {
          name?: string | null;
          title?: string;
          locations?: Array<{ path: string }>;
        };
        options: Array<{ optionId: string; kind: string }>;
      };
      const tool = params.toolCall;
      const name = tool?.name ?? tool?.title ?? 'unknown';
      const parts = [`[acp] allowing tool call: ${name}`];
      if (tool?.title && tool.title !== name) parts.push(`— ${tool.title}`);
      const paths = tool?.locations?.map((l) => l.path).filter(Boolean) ?? [];
      if (paths.length > 0) parts.push(`(${[...new Set(paths)].join(', ')})`);
      console.log(parts.join(' '));
      const best =
        params.options.find((o) => o.kind === 'allow_once') ??
        params.options.find((o) => o.kind === 'allow_always') ??
        params.options[0];
      if (!best) return { outcome: { outcome: 'cancelled' as const } };
      return { outcome: { outcome: 'selected' as const, optionId: best.optionId } };
    });
  }

  async start(): Promise<void> {
    if (this.process) return;
    this.process = spawnAgentProcess(this.options.command, this.options.args, this.options.env);
    this.connection = this.app.connect(this.process.stream);
    this.connection.closed.catch((err) => {
      console.error('ACP connection closed:', err);
      this.stop();
    });
  }

  stop(): void {
    this.sessions.forEach((session) => session.dispose());
    this.sessions.clear();
    this.connection?.close();
    this.connection = null;
    this.process?.kill();
    this.process = null;
  }

  async createSession(sessionId: string): Promise<void> {
    if (!this.connection) throw new Error('ACP agent not started');
    const builder = this.connection.agent.buildSession(this.options.cwd ?? process.cwd());
    const active = await builder.start();
    this.sessions.set(sessionId, active);
  }

  /** Cancel the ongoing prompt turn (session/cancel notification). */
  cancel(sessionId: string): void {
    const active = this.sessions.get(sessionId);
    if (!active || !this.connection) return;
    this.connection.agent
      .notify('session/cancel', { sessionId: active.sessionId })
      .catch((e: unknown) =>
        console.error('ACP cancel failed:', e instanceof Error ? e.message : e),
      );
  }

  /** Send content blocks and return the agent's full text response. */
  async prompt(
    sessionId: string,
    content: ContentBlock[],
    options: PromptOptions = {},
  ): Promise<string> {
    const active = this.sessions.get(sessionId);
    if (!active) throw new Error('Session not found');

    const timeoutMs = options.timeoutMs ?? 180_000;

    const nextWithTimeout = async (): Promise<Awaited<ReturnType<ActiveSession['nextUpdate']>>> => {
      let timer: NodeJS.Timeout | undefined;
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`Agent did not finish within ${timeoutMs}ms.`)),
          timeoutMs,
        );
      });
      try {
        return await Promise.race([active.nextUpdate(), timeout]);
      } finally {
        clearTimeout(timer);
      }
    };

    await active.prompt(content);
    let text = '';
    for (;;) {
      const message = await nextWithTimeout();
      if (message.kind === 'stop') return text;
      const update = message.update;
      if (update.sessionUpdate === 'agent_message_chunk' && update.content.type === 'text') {
        text += update.content.text;
        options.onChunk?.(update.content.text);
      } else if (update.sessionUpdate === 'tool_call') {
        const tool = update as unknown as {
          toolCallId: string;
          title?: string;
          kind?: string;
          status?: string;
        };
        options.onToolCall?.({
          title: tool.title ?? tool.toolCallId,
          status: tool.status ?? 'in_progress',
          kind: tool.kind ?? 'execute',
        });
      }
    }
  }
}