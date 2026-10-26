/**
 * Cross-platform native clipboard adapter for arbitrary custom formats.
 *
 * Electron's W3C-style clipboard API cannot write RAW custom OS formats:
 * on Windows it wraps them in the Web Custom Format spec, which LyX cannot
 * parse (writes are silently ignored and `paste` inserts literal markup —
 * a live-verified failure; the osclipboard escape hatch is unreliable for
 * the same reason: read-back goes through the same wrapper).
 *
 * So we bypass Electron and talk to each platform's native clipboard:
 * - win32:  .NET WinForms via PowerShell (verified against LyX 2.5.3).
 * - linux:  wl-copy (Wayland) or xclip (X11) with `-t application/x-lyx`;
 *           custom MIME types are native there (no wrapper problem).
 * - darwin: osascript + NSPasteboard (setData:forType: accepts arbitrary
 *           type names).
 *
 * Implements the same RawClipboard interface the Electron implementation
 * used, so LyxClipboard does not change.
 */
import { spawn } from 'node:child_process';
import type { RawClipboard } from './lyx-clipboard.js';

const LYX_FORMAT = 'application/x-lyx';

export function createNativeClipboard(): RawClipboard {
  switch (process.platform) {
    case 'win32':
      return windowsClipboard();
    case 'darwin':
      return macosClipboard();
    case 'linux':
      return linuxClipboard();
    default:
      throw new Error(`No native clipboard adapter for ${process.platform}`);
  }
}

// --- shared helpers ---------------------------------------------------------

function runProcess(
  command: string,
  args: string[],
  input?: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (d: string) => (stdout += d));
    child.stderr?.on('data', (d: string) => (stderr += d));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr }));
    if (input !== undefined) child.stdin?.end(input, 'utf8');
    else child.stdin?.end();
  });
}

// --- windows ---------------------------------------------------------------

/**
 * One long-lived PowerShell host for all clipboard operations, instead of
 * a fresh `powershell -STA` + Add-Type per call (~200-600ms each; a
 * verified paste + probeSelection in write-only mode is 4+ spawns).
 *
 * Protocol: Node writes ONE JSON line per command
 * (`{"op":"write"|"readFormat"|"readText"|"clear", ...}`); the host answers
 * with one line: `OK`, `ERR <message>`, `NONE`, or `DATA <base64>`.
 *
 * Stdin is read with SYNC `[Console]::In.ReadLine()` — live-verified
 * (2026-10-26 spike): unlike the documented `ReadLineAsync()` pitfall
 * (which blocks PS 5.1's success stream when spawned from Node), the sync
 * ReadLine loop streams one response per command. The host exits by itself
 * when stdin closes (parent exit), so nothing lingers.
 */
const WIN_HOST_PS = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
function Invoke-WithClipRetry([scriptblock]$action) {
  # Opening the clipboard fails transiently while another process holds it
  # (the editor mid-copy, a clipboard manager, another LyX instance). The
  # contention window is short — retry briefly before surfacing an error
  # (live-reported 2026-10-26: GetText failed the whole message with
  # "Requested Clipboard operation did not succeed").
  $last = $null
  for ($i = 0; $i -lt 10; $i++) {
    try { return & $action } catch { $last = $_; Start-Sleep -Milliseconds 30 }
  }
  throw $last
}
while($true){
  $line = [Console]::In.ReadLine()
  if ($line -eq $null) { break }
  try {
    $req = $line | ConvertFrom-Json
    switch ($req.op) {
      'write' {
        $doc = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($req.lyx))
        $data = New-Object System.Windows.Forms.DataObject
        $bytes = [Text.Encoding]::UTF8.GetBytes($doc)
        $stream = New-Object System.IO.MemoryStream
        $stream.Write($bytes, 0, $bytes.Length)
        $stream.Position = 0
        $data.SetData('${LYX_FORMAT}', $stream)
        if ($req.text) {
          $data.SetText([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($req.text)))
        }
        Invoke-WithClipRetry { [System.Windows.Forms.Clipboard]::SetDataObject($data, $true) }
        Write-Output 'OK'
      }
      'writeText' {
        $data = New-Object System.Windows.Forms.DataObject
        if ($req.text) {
          $data.SetText([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($req.text)))
        }
        Invoke-WithClipRetry { [System.Windows.Forms.Clipboard]::SetDataObject($data, $true) }
        Write-Output 'OK'
      }
      'readFormat' {
        $d = Invoke-WithClipRetry { [System.Windows.Forms.Clipboard]::GetDataObject() }
        if ($d -eq $null -or -not $d.GetDataPresent('${LYX_FORMAT}')) {
          Write-Output 'NONE'
        } else {
          $stream = $d.GetData('${LYX_FORMAT}')
          $stream.Position = 0
          $reader = New-Object System.IO.StreamReader($stream, [Text.Encoding]::UTF8)
          $doc = $reader.ReadToEnd()
          Write-Output ('DATA ' + [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($doc)))
        }
      }
      'readText' {
        $t = Invoke-WithClipRetry { [System.Windows.Forms.Clipboard]::GetText() }
        Write-Output ('DATA ' + [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($t)))
      }
      'clear' {
        Invoke-WithClipRetry { [System.Windows.Forms.Clipboard]::Clear() }
        Write-Output 'OK'
      }
      default { Write-Output ('ERR unknown op ' + $req.op) }
    }
  } catch {
    Write-Output ('ERR ' + $_.Exception.Message)
  }
  [Console]::Out.Flush()
}
`;

interface HostState {
  child: import('node:child_process').ChildProcess;
  stdoutBuffer: string;
  pending: ((line: string) => void) | null;
  startup: Promise<void>;
}

/** Lazily spawned, crash-resilient PowerShell host (one per app process). */
const psHost: { state: HostState | null } = { state: null };

function startPsHost(): HostState {
  const child = spawn('powershell', ['-NoProfile', '-STA', '-Command', WIN_HOST_PS], {
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  // Never keep the app alive for an idle clipboard host; the host also
  // exits on its own when stdin closes at process exit.
  child.unref();
  // The stdio streams are net.Socket when piped; unref them so an idle
  // host cannot hold the parent's event loop open either.
  const unrefStream = (s: unknown) => (s as { unref?: () => void } | null)?.unref?.();
  unrefStream(child.stdin);
  unrefStream(child.stdout);
  unrefStream(child.stderr);
  const state: HostState = {
    child,
    stdoutBuffer: '',
    pending: null,
    startup: new Promise<void>((resolve, reject) => {
      child.once('error', reject);
      // The host signals readiness implicitly: Add-Type completes before
      // the first ReadLine. Resolve once the process is alive.
      if (child.pid) resolve();
      else child.once('spawn', () => resolve());
    }),
  };
  child.stdout?.setEncoding('utf8');
  child.stdout?.on('data', (chunk: string) => {
    state.stdoutBuffer += chunk;
    let idx: number;
    while ((idx = state.stdoutBuffer.indexOf('\n')) >= 0) {
      const line = state.stdoutBuffer.slice(0, idx).replace(/\r$/, '');
      state.stdoutBuffer = state.stdoutBuffer.slice(idx + 1);
      const resolve = state.pending;
      if (resolve) {
        state.pending = null;
        resolve(line);
      }
    }
  });
  child.on('close', () => {
    const resolve = state.pending;
    state.pending = null;
    if (psHost.state === state) psHost.state = null;
    resolve?.('ERR host exited');
  });
  child.on('error', () => {
    const resolve = state.pending;
    state.pending = null;
    if (psHost.state === state) psHost.state = null;
    resolve?.('ERR host failed');
  });
  return state;
}

/** Ref/unref the host + its stdio (see psHostCommand for why). */
function setHostRefs(state: HostState, active: boolean): void {
  const op = active ? 'ref' : 'unref';
  (state.child as unknown as { ref?: () => void; unref?: () => void })[op]?.();
  for (const s of [state.child.stdin, state.child.stdout, state.child.stderr]) {
    (s as unknown as { ref?: () => void; unref?: () => void })?.[op]?.();
  }
}

/**
 * Send one command to the persistent host and await its response line.
 * Serialized (one in flight) — clipboard operations are sequential by
 * nature. Respawn transparently if the host died.
 *
 * While a command is pending the host handles are ref'd (the in-flight
 * operation keeps the process alive until it settles); when idle they are
 * unref'd again so a persistent host never holds the app open at exit.
 * The host exits by itself when stdin closes at process exit.
 */
async function psHostCommand(request: Record<string, unknown>): Promise<string> {
  let state = psHost.state;
  if (!state) {
    state = startPsHost();
    psHost.state = state;
  }
  await state.startup;
  if (state.pending) {
    throw new Error('PowerShell clipboard host is busy (concurrent clipboard operations)');
  }
  return new Promise<string>((resolve, reject) => {
    setHostRefs(state!, true);
    const settle = (fn: () => void) => {
      state!.pending = null;
      setHostRefs(state!, false);
      fn();
    };
    state!.pending = (line) => {
      settle(() => {
        if (line.startsWith('ERR ')) reject(new Error(line.slice(4).slice(0, 300)));
        else resolve(line);
      });
    };
    state!.child.stdin?.write(`${JSON.stringify(request)}\n`, 'utf8', (e) => {
      if (e) settle(() => reject(e as Error));
    });
  });
}

function windowsClipboard(): RawClipboard {
  return {
    async hasFormat(format) {
      if (format !== LYX_FORMAT) return false;
      return (await this.readFormat(format)) !== null;
    },
    async readFormat(format) {
      if (format !== LYX_FORMAT) return null;
      const line = await psHostCommand({ op: 'readFormat' });
      if (line === 'NONE') return null;
      if (!line.startsWith('DATA ')) throw new Error(`Unexpected host reply: ${line.slice(0, 100)}`);
      return Buffer.from(line.slice(5), 'base64');
    },
    async write(formats) {
      const lyx = formats[LYX_FORMAT];
      if (typeof lyx === 'string' || !lyx) {
        throw new Error(`Windows adapter writes raw bytes for ${LYX_FORMAT}`);
      }
      const request: Record<string, unknown> = { op: 'write', lyx: lyx.toString('base64') };
      if (formats['text/plain'] !== undefined) {
        request['text'] = Buffer.from(String(formats['text/plain']), 'utf8').toString('base64');
      }
      const line = await psHostCommand(request);
      if (line !== 'OK') throw new Error(`Unexpected host reply: ${line.slice(0, 100)}`);
    },
    async readText() {
      const line = await psHostCommand({ op: 'readText' });
      if (!line.startsWith('DATA ')) throw new Error(`Unexpected host reply: ${line.slice(0, 100)}`);
      return Buffer.from(line.slice(5), 'base64').toString('utf8');
    },
    async writeText(text) {
      const line = await psHostCommand({ op: 'writeText', text: Buffer.from(text, 'utf8').toString('base64') });
      if (line !== 'OK') throw new Error(`Unexpected host reply: ${line.slice(0, 100)}`);
    },
    async clear() {
      const line = await psHostCommand({ op: 'clear' });
      if (line !== 'OK') throw new Error(`Unexpected host reply: ${line.slice(0, 100)}`);
    },
  };
}

// --- linux -----------------------------------------------------------------

/** True when running under a Wayland session (wl-copy needed). */
function isWayland(): boolean {
  return Boolean(process.env.WAYLAND_DISPLAY || process.env.WAYLAND_SOCKET);
}

function linuxClipboard(): RawClipboard {
  const tool = isWayland() ? 'wl-copy' : 'xclip';
  return {
    async hasFormat(format) {
      return (await this.readFormat(format)) !== null;
    },
    async readFormat(format) {
      // wl-paste / xclip both list and output by target type.
      const cmd = isWayland()
        ? runProcess('wl-paste', ['--type', format])
        : runProcess('xclip', ['-selection', 'clipboard', '-o', '-t', format]);
      try {
        const r = await cmd;
        if (r.code !== 0) return null;
        return Buffer.from(r.stdout, 'utf8');
      } catch {
        return null;
      }
    },
    async write(formats) {
      // Custom MIME types are native on Linux: write the x-lyx flavor with
      // the platform tool (it serves the clipboard from a forked process).
      const lyx = formats[LYX_FORMAT];
      const text = formats['text/plain'];
      if (typeof lyx !== 'string' && lyx) {
        const input = lyx.toString('utf8');
        const args = isWayland()
          ? ['--type', LYX_FORMAT]
          : ['-selection', 'clipboard', '-t', LYX_FORMAT];
        await runProcess(tool, args, input);
      } else if (typeof text === 'string') {
        const args = isWayland() ? [] : ['-selection', 'clipboard'];
        await runProcess(tool, args, text);
      }
    },
    async readText() {
      const r = isWayland()
        ? await runProcess('wl-paste', ['--no-newline'])
        : await runProcess('xclip', ['-selection', 'clipboard', '-o']);
      return r.code === 0 ? r.stdout : '';
    },
    async writeText(text) {
      // Same mechanism as clear(): replace the selection with the text
      // (empty text empties the clipboard).
      const args = isWayland() ? [] : ['-selection', 'clipboard'];
      await runProcess(tool, args, text);
    },
    async clear() {
      // wl-copy has a dedicated --clear; xclip replaces the selection with
      // whatever is piped in, so empty stdin empties the clipboard.
      if (isWayland()) await runProcess('wl-copy', ['--clear']);
      else await runProcess('xclip', ['-selection', 'clipboard'], '');
    },
  };
}

// --- macos -----------------------------------------------------------------

function osascript(script: string): Promise<string> {
  return runProcess('osascript', ['-e', script]).then((r) => {
    if (r.code !== 0) throw new Error(`osascript exit ${r.code}: ${r.stderr.slice(0, 300)}`);
    return r.stdout;
  });
}

function macosClipboard(): RawClipboard {
  return {
    async hasFormat(format) {
      return (await this.readFormat(format)) !== null;
    },
    async readFormat(format) {
      try {
        const out = await osascript(
          `use framework "AppKit"\n` +
            `set pb to current application's class NSPasteboard's generalPasteboard()\n` +
            `set theData to (pb's dataForType:"${format}")\n` +
            `if theData is equal to (current application's missing value) then return "NONE"\n` +
            `return (theData's base64EncodedStringWithOptions:0) as text`,
        );
        const trimmed = out.trim();
        if (trimmed === 'NONE') return null;
        return Buffer.from(trimmed, 'base64');
      } catch {
        return null;
      }
    },
    async write(formats) {
      const lyx = formats[LYX_FORMAT];
      const b64 = typeof lyx === 'string' ? Buffer.from(lyx, 'utf8') : lyx;
      if (!b64) throw new Error('macOS adapter requires the x-lyx payload');
      const payload = b64.toString('base64');
      const text = formats['text/plain'];
      const textB64 = typeof text === 'string' ? Buffer.from(text, 'utf8').toString('base64') : '';
      await osascript(
        `set b64 to "${payload}"\n` +
          `set textB64 to "${textB64}"\n` +
          `use framework "AppKit"\n` +
          `set pb to current application's class NSPasteboard's generalPasteboard()\n` +
          `pb's clearContents()\n` +
          `set xlyxData to current application's class NSData's alloc()'s ` +
          `initWithBase64EncodedString:(b64) options:0\n` +
          `pb's setData:xlyxData forType:"${LYX_FORMAT}"\n` +
          `if textB64 is not equal to "" then\n` +
          `set textData to current application's class NSString's alloc()'s ` +
          `initWithData:(current application's class NSData's alloc()'s ` +
          `initWithBase64EncodedString:(textB64) options:0) ` +
          `encoding:(current application's currentApplication's NSUTF8StringEncoding)\n` +
          `pb's setString:textData forType:"public.utf8-plain-text"\n` +
          `end if\n`,
      );
    },
    async readText() {
      const out = await osascript('return the clipboard as text');
      return out.trimEnd();
    },
    async writeText(text) {
      // AppleScript sets the clipboard to text (empty string clears it).
      await osascript(`set the clipboard to ${JSON.stringify(text)}`);
    },
    async clear() {
      await osascript(
        'use framework "AppKit"\n' +
          'set pb to current application\'s class NSPasteboard\'s generalPasteboard()\n' +
          'pb\'s clearContents()\n' +
          'return "OK"',
      );
    },
  };
}