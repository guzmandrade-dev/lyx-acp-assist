import { client } from '@agentclientprotocol/sdk';
import type {
  ClientApp,
  ContentBlock,
  ActiveSession,
  ClientConnection,
} from '@agentclientprotocol/sdk';
import { spawnAgentProcess, type AgentProcess } from './agent-process.js';

export interface AcpClientOptions {
  command: string;
  args: string[];
  env: Record<string, string>;
  cwd?: string;
}

export class AcpClient {
  private app: ClientApp;
  private process: AgentProcess | null = null;
  private connection: ClientConnection | null = null;
  private options: AcpClientOptions;
  private sessions = new Map<string, ActiveSession>();

  constructor(options: AcpClientOptions) {
    this.options = options;
    this.app = client({ name: 'lyx-acp-assist' });
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

  /** Send content blocks and return the agent's full text response. */
  async prompt(sessionId: string, content: ContentBlock[]): Promise<string> {
    const active = this.sessions.get(sessionId);
    if (!active) throw new Error('Session not found');
    await active.prompt(content);
    return this.readTextFromResponse(active);
  }

  private async readTextFromResponse(active: ActiveSession): Promise<string> {
    let text = '';
    for (;;) {
      const message = await active.nextUpdate();
      if (message.kind === 'stop') return text;
      const update = message.update;
      if (update.sessionUpdate === 'agent_message_chunk' && update.content.type === 'text') {
        text += update.content.text;
      }
    }
  }
}