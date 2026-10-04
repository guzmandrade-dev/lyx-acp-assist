# Mock LyXServer transport: real Win32 named pipes with LyX's semantics.
#
# Why this exists: Node's net.Server creates DUPLEX pipe instances; the
# client's fs.ReadStream opens read-only, which Windows registers as a
# half-close against a duplex server (connections die instantly). LyX's
# .out pipe is OUTBOUND and .in is INBOUND, and NamedPipeServerStream can
# match that exactly.
#
# LyX fidelity details:
# - MULTIPLE instances per pipe (LyX's pipes do too): the client's
#   isAvailable() probes with fs.accessSync, which opens ghost connections
#   that steal single-instance pipes (live-verified: next open gets EBUSY).
#   We keep a pool of listening instances and replace consumed ones.
# - .out replies end the connection after each write (LyX's resetPipe).
# - Ghost clients (accessSync probes) fail on write; replies then go to
#   another connected instance.
# - Control channel <base>.ctl carries "R|<reply>" / "BYE" lines from the
#   Node harness. stdin is NOT used: [Console]::In blocks the success
#   stream in Windows PowerShell 5.1 when spawned from Node.
# - NamedPipeServerStream expects the bare pipe NAME (no \\.\pipe\ prefix):
#   passing the full path creates a pipe nothing else can open.
param([string]$PipeBase)
$ErrorActionPreference = 'Stop'

$Name = $PipeBase -replace '^\\\\\.\\pipe\\', ''
$PoolSize = 4

function Send([string]$s) { Write-Output $s }

# Each pool entry: @{ Pipe; Wait (task); Reader; Task (ReadLine task); Connected }
function New-In {
  param([string]$PipeName, [string]$Direction)
  $p = [System.IO.Pipes.NamedPipeServerStream]::new($PipeName, [System.IO.Pipes.PipeDirection]::$Direction, [byte]254)
  return @{ Pipe = $p; Wait = $p.WaitForConnectionAsync(); Reader = $null; Task = $null; Connected = $false }
}

function Top-Up-Pool {
  param($Pool, [string]$PipeName, [string]$Direction)
  while ($Pool.Count -lt $PoolSize) { $Pool.Add((New-In $PipeName $Direction)) | Out-Null }
}

# --- pools -------------------------------------------------------------------
$inPool = [System.Collections.ArrayList]::new()
Top-Up-Pool $inPool "$Name.in" 'In'

$outPool = [System.Collections.ArrayList]::new()
Top-Up-Pool $outPool "$Name.out" 'Out'

$ctlPipe = [System.IO.Pipes.NamedPipeServerStream]::new("$Name.ctl", [System.IO.Pipes.PipeDirection]::In)
$ctlWait = $ctlPipe.WaitForConnectionAsync()
$ctlReader = $null
$ctlTask = $null

$script:outPending = [System.Collections.Generic.List[string]]::new()

function Write-Reply([string]$line) {
  # Try connected .out instances, newest first (ghosts fail on write).
  for ($i = $script:outPool.Count - 1; $i -ge 0; $i--) {
    $e = $script:outPool[$i]
    if (-not $e.Connected) { continue }
    try {
      $w = [System.IO.StreamWriter]::new($e.Pipe, (New-Object System.Text.UTF8Encoding $false), 1024, $true)
      $w.AutoFlush = $true
      $w.WriteLine($line)
      $e.Pipe.Disconnect()
      # NOTE: no $w.Dispose() - disposing the writer (even with leaveOpen,
      # under PS 5.1 overload resolution) closed/closed-into the disconnected
      # pipe and threw, which misclassified live clients as ghosts.
      $e.Connected = $false
      $e.Wait = $e.Pipe.WaitForConnectionAsync()
      Send "WROTE|$i"
      return
    } catch {
      # Ghost client: drop this instance and replace it.
      $msg = $_.Exception.Message
      $inner = $_.Exception
      while ($inner.InnerException) { $inner = $inner.InnerException }
      Send "GHOST-DROP|$i|$($inner.GetType().Name): $($inner.Message)"
      try { $e.Pipe.Dispose() } catch {}
      $script:outPool.RemoveAt($i) | Out-Null
      Top-Up-Pool $script:outPool "$($script:Name).out" 'Out'
    }
  }
  # No connected instance: queue until a client connects (flushed in loop).
  $script:outPending.Add($line) | Out-Null
  Send "QUEUED|$($script:outPending.Count)"
}

Send 'READY'

try {
while ($true) {
  # .in: accept + read. Any per-entry failure recycles that instance only.
  for ($i = 0; $i -lt $inPool.Count; $i++) {
    $e = $inPool[$i]
    try {
      if (-not $e.Connected -and $e.Wait.IsCompleted) {
        $e.Wait.Wait() | Out-Null
        $e.Connected = $true
      }
      if ($e.Connected -and $null -eq $e.Task) {
        $e.Reader = [System.IO.StreamReader]::new($e.Pipe, (New-Object System.Text.UTF8Encoding $false), $false, 1024, $true)
        $e.Task = $e.Reader.ReadLineAsync()
      }
      if ($e.Task -and $e.Task.IsCompleted) {
        $line = $e.Task.Result
        if ($null -ne $line -and $line.Length -gt 0) {
          Send "IN|$line"
          $e.Task = $e.Reader.ReadLineAsync()
        } else {
          # EOF: recycle this instance (reader has leaveOpen; pipe survives).
          try { $e.Reader.Dispose() } catch {}
          $e.Connected = $false
          $e.Reader = $null
          $e.Task = $null
          try { $e.Pipe.Disconnect() } catch {}
          try { $e.Wait = $e.Pipe.WaitForConnectionAsync() } catch { throw }
        }
      }
    } catch {
      # Instance is broken (e.g. ghost closed the pipe): replace it.
      try { $e.Pipe.Dispose() } catch {}
      $inPool.RemoveAt($i) | Out-Null
      $i--
      Top-Up-Pool $inPool "$Name.in" 'In'
    }
  }

  # .out: accepts + flush pending replies
  for ($i = 0; $i -lt $outPool.Count; $i++) {
    $e = $outPool[$i]
    try {
      if (-not $e.Connected -and $e.Wait.IsCompleted) {
        $e.Wait.Wait() | Out-Null
        $e.Connected = $true
        Send "OUTACCEPT|$i"
      }
    } catch {
      try { $e.Pipe.Dispose() } catch {}
      $outPool.RemoveAt($i) | Out-Null
      $i--
      Top-Up-Pool $outPool "$Name.out" 'Out'
    }
  }
  if ($script:outPending.Count -gt 0) {
    foreach ($line in @($script:outPending)) {
      $script:outPending.Remove($line) | Out-Null
      Write-Reply $line
    }
  }

  # .ctl
  if ($null -eq $ctlTask -and $ctlWait.IsCompleted) {
    $ctlWait.Wait() | Out-Null
    $ctlReader = [System.IO.StreamReader]::new($ctlPipe, (New-Object System.Text.UTF8Encoding $false))
    $ctlTask = $ctlReader.ReadLineAsync()
  }
  if ($ctlTask -and $ctlTask.IsCompleted) {
    $cmd = $ctlTask.Result
    if ($null -eq $cmd -or $cmd -eq 'BYE') { break }
    if ($cmd.StartsWith('R|')) { Write-Reply $cmd.Substring(2) }
    $ctlTask = $ctlReader.ReadLineAsync()
  }

  Start-Sleep -Milliseconds 5
}
} catch {
  $inner = $_.Exception
  while ($inner.InnerException) { $inner = $inner.InnerException }
  Send "TRANSPORT-ERROR: $($inner.GetType().Name): $($inner.Message)"
} finally {
  Send 'TRANSPORT-EXIT'
}