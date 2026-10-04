import { spawn, type ChildProcess } from 'node:child_process';
import { Readable, Writable } from 'node:stream';
import type { Stream } from '@agentclientprotocol/sdk';
import { ndJsonStream } from '@agentclientprotocol/sdk';

export interface AgentProcess {
  process: ChildProcess;
  stream: Stream;
  kill(): void;
}

export function spawnAgentProcess(
  command: string,
  args: string[],
  env: Record<string, string>,
): AgentProcess {
  // On Windows, PATH shims are usually .cmd/.ps1/.bat files which Node's
  // spawn cannot execute directly (and refuses .cmd/.bat with EINVAL).
  // Route bare command names through cmd.exe; explicit paths keep direct
  // execution so users can point at the real binary if they prefer.
  const isWindows = process.platform === 'win32';
  const isBareName = !command.includes('\\') && !command.includes('/');
  const useShell = isWindows && isBareName && !command.endsWith('.exe');

  const child = useShell
    ? spawn(command, args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, ...env },
        shell: true,
        windowsHide: true,
      })
    : spawn(command, args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, ...env },
        shell: false,
      });

  if (!child.stdin || !child.stdout) {
    throw new Error(`Failed to spawn agent: ${command}`);
  }

  const writable = Writable.toWeb(child.stdin);
  const readable = Readable.toWeb(child.stdout);
  const stream = ndJsonStream(writable, readable as ReadableStream<Uint8Array>);

  child.stderr?.on('data', (chunk: Buffer) => {
    console.error(`[agent stderr] ${chunk.toString('utf-8')}`);
  });
  child.on('error', (err) => {
    console.error('Agent process error:', err);
  });
  child.on('exit', (code) => {
    if (code !== 0 && code !== null) {
      console.warn(`Agent process exited with code ${code}`);
    }
  });

  return {
    process: child,
    stream,
    kill() {
      if (!child.killed) child.kill('SIGTERM');
    },
  };
}