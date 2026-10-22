# Reproduction: LyX 2.5.x LyXServer .out-pipe deafness on Windows builds with
# the 2026-10-17 update batch (Insider 26220; KB5127690/KB5127846/KB5127839).
#
# Root cause (verified 2026-10-22, see apps/lyx/AGENTS.md "Live-test debugging
# trail"): a zero-length overlapped WriteFile on a named pipe now returns
# FALSE + ERROR_IO_PENDING instead of completing with TRUE. LyX's
# LyXComm::pipeServer (src/Server.cpp) issues such a zero-length write on
# every fresh .out connection (empty reply buffer); its error logic only
# tolerates pending writes when WriteFile returned TRUE, so control falls
# to resetPipe() and the client is instantly disconnected. The .in path
# (ReadFile) is unaffected -> commands dispatch but replies never arrive.
#
# This script replicates LyX's outpipe loop verbatim (20 instances, one
# WaitForMultipleObjects thread, manual-reset events with initial state
# SIGNALED, no ResetEvent anywhere) plus a scripted client, and reproduces
# the live symptom set exactly:
#   - .out client connects -> instant 0-byte EOF (reset by the server loop)
#   - .in dispatch works (hello + LYXCMD are read and dispatched)
#   - replies accumulate in outbuf but are never delivered to any client
#
# Run:  powershell -NoProfile -ExecutionPolicy Bypass -File pipe-bug-repro.ps1
# Expected output on a broken build: "WRITE-ERROR path err=997" right after
# the client connects, then "CLIENT out read: 0 bytes: EOF".
# On a fixed/pre-update build the zero-write completes and the client
# receives "LYXSRV:rep:hello".

$code = @'
using System;
using System.Collections.Concurrent;
using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

public static class LyxReplica {
  [DllImport("kernel32.dll", CharSet=CharSet.Ansi, SetLastError=true)]
  static extern IntPtr CreateNamedPipeA(string name, uint openMode, uint pipeMode, uint maxInst, uint outBuf, uint inBuf, uint timeout, IntPtr sec);
  [DllImport("kernel32.dll", SetLastError=true)]
  static extern bool ConnectNamedPipe(IntPtr h, ref OVERLAPPED ov);
  [DllImport("kernel32.dll", SetLastError=true)]
  static extern bool ReadFile(IntPtr h, byte[] buf, uint n, out uint read, ref OVERLAPPED ov);
  [DllImport("kernel32.dll", SetLastError=true)]
  static extern bool WriteFile(IntPtr h, byte[] buf, uint n, out uint written, ref OVERLAPPED ov);
  [DllImport("kernel32.dll", SetLastError=true)]
  static extern bool GetOverlappedResult(IntPtr h, ref OVERLAPPED ov, out uint n, bool wait);
  [DllImport("kernel32.dll", SetLastError=true)]
  static extern bool DisconnectNamedPipe(IntPtr h);
  [DllImport("kernel32.dll", SetLastError=true)]
  static extern IntPtr CreateEvent(IntPtr h0, bool manual, bool initial, IntPtr name);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetEvent(IntPtr h);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool CloseHandle(IntPtr h);
  [DllImport("kernel32.dll", SetLastError=true)]
  static extern uint WaitForMultipleObjects(int n, IntPtr[] handles, bool waitAll, uint ms);
  [StructLayout(LayoutKind.Sequential)]
  public struct OVERLAPPED { public IntPtr Internal; public IntPtr InternalHigh; public uint Offset; public uint OffsetHigh; public IntPtr hEvent; }

  const int MAX_CLIENTS = 10, MAX_PIPES = 20, BUFSIZE = 512;
  const uint INBOUND = 0x1, OUTBOUND = 0x2, OVL = 0x40000000;
  enum St { CONNECTING, READING, WRITING }
  class Inst { public IntPtr h; public St state; public bool pending; public string iobuf = ""; public byte[] readbuf = new byte[BUFSIZE]; public uint nbytes; public OVERLAPPED ov; public IntPtr ev; public int resets; }
  static ConcurrentQueue<string> log = new ConcurrentQueue<string>();
  static Inst[] P = new Inst[MAX_PIPES];
  static IntPtr[] EV = new IntPtr[MAX_PIPES + 1];
  static string outbuf = "";
  static int iters = 0;

  static void L(string s) { if (iters <= 150 || s.StartsWith("!")) log.Enqueue(s); }

  static bool StartPipe(int i) {
    P[i].pending = false;
    P[i].ov.Offset = 0; P[i].ov.OffsetHigh = 0;
    if (ConnectNamedPipe(P[i].h, ref P[i].ov)) return false;
    int e = Marshal.GetLastWin32Error();
    if (e == 997) { P[i].pending = true; return true; }
    if (e == 535) { SetEvent(P[i].ev); return true; }
    return false;
  }

  static void ResetPipe(int i, bool closeHandle) {
    bool ok = DisconnectNamedPipe(P[i].h);
    int de = Marshal.GetLastWin32Error();
    P[i].resets++;
    L(string.Format("!resetPipe({0}, close={1}) disc_ok={2} err={3} resets={4}", i, closeHandle, ok, de, P[i].resets));
    if (closeHandle) {
      bool isOut = i >= MAX_CLIENTS;
      CloseHandle(P[i].h);
      P[i].iobuf = "";
      P[i].h = CreateNamedPipeA(isOut ? "\\\\.\\pipe\\acprep.out" : "\\\\.\\pipe\\acprep.in",
        (isOut ? OUTBOUND : INBOUND) | OVL, 0, MAX_CLIENTS, BUFSIZE, BUFSIZE, 5000, (IntPtr)0);
      P[i].ov = new OVERLAPPED { hEvent = P[i].ev };
    }
    if (!StartPipe(i)) { L("!startPipe failed " + i); return; }
    P[i].state = P[i].pending ? St.CONNECTING : (i >= MAX_CLIENTS ? St.WRITING : St.READING);
  }

  static void Process(int i) {
    string data = Encoding.UTF8.GetString(P[i].readbuf, 0, (int)P[i].nbytes).TrimEnd(new char[]{(char)13});
    L("!dispatch[" + i + "]: " + data);
    if (data.StartsWith("LYXSRV:")) {
      string[] parts = data.Split(new char[]{(char)58});
      string client = parts.Length > 1 ? parts[1] : "?";
      if (parts.Length > 2 && parts[2] == "hello") outbuf += "LYXSRV:" + client + ":hello\n";
    } else if (data.StartsWith("LYXCMD:")) {
      string[] parts = data.Split(new char[]{(char)58}, 4);
      string client = parts.Length > 1 ? parts[1] : "?";
      string func = parts.Length > 2 ? parts[2] : "?";
      outbuf += "INFO:" + client + ":" + func + ":OK\n";
    }
    P[i].nbytes = 0;
  }

  public static string Run() {
    IntPtr NULL = (IntPtr)0;
    var stopEv = CreateEvent(NULL, true, false, NULL);
    for (int i = 0; i < MAX_PIPES; i++) {
      bool isOut = i >= MAX_CLIENTS;
      P[i] = new Inst();
      P[i].ev = CreateEvent(NULL, true, true, NULL);
      P[i].ov = new OVERLAPPED { hEvent = P[i].ev };
      P[i].h = CreateNamedPipeA(isOut ? "\\\\.\\pipe\\acprep.out" : "\\\\.\\pipe\\acprep.in",
        (isOut ? OUTBOUND : INBOUND) | OVL, 0, MAX_CLIENTS, BUFSIZE, BUFSIZE, 5000, NULL);
      if (!StartPipe(i)) return "startPipe failed at " + i;
      P[i].state = P[i].pending ? St.CONNECTING : (isOut ? St.WRITING : St.READING);
      EV[i] = P[i].ev;
    }
    EV[MAX_PIPES] = stopEv;

    var server = new Thread(() => {
      uint status = 0; bool success = false;
      var wHandles = new IntPtr[MAX_PIPES + 1];
      for (int k = 0; k <= MAX_PIPES; k++) wHandles[k] = EV[k];
      while (true) {
        iters++;
        uint wait = WaitForMultipleObjects(MAX_PIPES + 1, wHandles, false, 0xFFFFFFFF);
        int i = (int)wait;
        if (i == MAX_PIPES) break;
        if (i < 0 || i > MAX_PIPES) { L("!WFMO weird: " + wait); continue; }
        bool isOut = i >= MAX_CLIENTS;
        L(string.Format("iter={0} woke i={1} ({2}) state={3} pending={4}", iters, i, isOut ? "OUT" : "IN", P[i].state, P[i].pending));
        if (P[i].pending) {
          success = GetOverlappedResult(P[i].h, ref P[i].ov, out status, false);
          int gorErr = Marshal.GetLastWin32Error();
          L(string.Format("  GOR ret={0} status={1} err={2}", success, status, gorErr));
          switch (P[i].state) {
            case St.CONNECTING:
              if (!success) { L("  CONNECTING !success -> reset"); ResetPipe(i, true); continue; }
              P[i].state = isOut ? St.WRITING : St.READING;
              break;
            case St.READING:
              if (!success || status == 0) { ResetPipe(i, !success); continue; }
              P[i].nbytes = status; P[i].state = St.WRITING;
              break;
            case St.WRITING:
              if (outbuf != "") { for (int j = MAX_CLIENTS; j < MAX_PIPES; j++) P[j].iobuf = outbuf; outbuf = ""; }
              if (P[i].iobuf == "") P[i].pending = false;
              break;
          }
        }
        switch (P[i].state) {
          case St.READING: {
            uint nb;
            success = ReadFile(P[i].h, P[i].readbuf, BUFSIZE - 1, out nb, ref P[i].ov);
            int re = Marshal.GetLastWin32Error();
            if (success && nb != 0) { P[i].pending = false; P[i].nbytes = nb; P[i].state = St.WRITING; continue; }
            if (!success && re == 997) { P[i].pending = true; continue; }
            success = re == 109;
            L(string.Format("  ReadFile ret={0} err={1} -> reset(close={2})", success, re, !success));
            ResetPipe(i, !success);
            break;
          }
          case St.WRITING: {
            if (!isOut) { Process(i); P[i].pending = false; P[i].state = St.READING; continue; }
            uint nb = 0; bool wsuccess = false;
            if (P[i].pending) {
              byte[] payload = Encoding.UTF8.GetBytes(P[i].iobuf == "" ? " " : P[i].iobuf);
              uint len = (uint)Encoding.UTF8.GetByteCount(P[i].iobuf);
              wsuccess = WriteFile(P[i].h, payload, len, out nb, ref P[i].ov);
            }
            int we = Marshal.GetLastWin32Error();
            uint ilen = (uint)Encoding.UTF8.GetByteCount(P[i].iobuf);
            L(string.Format("  Write(out) ret={0} err={1} wrote={2} iolen={3} pending_before={4}", wsuccess, we, nb, ilen, P[i].pending));
            if (wsuccess && ilen != 0 && nb == ilen) {
              P[i].iobuf = ""; P[i].pending = false;
              L("  reply delivered -> normal reset");
              ResetPipe(i, false);
              continue;
            }
            if (wsuccess && (we == 997 || we == 0)) { Thread.Sleep(100); P[i].pending = true; continue; }
            bool succ2 = we == 232;
            L(string.Format("  WRITE-ERROR path err={0} -> reset(close={1})", we, !succ2));
            ResetPipe(i, !succ2);
            break;
          }
          case St.CONNECTING: L("  wrong state CONNECTING"); break;
        }
      }
      L("!server loop exited");
    });
    server.Start();

    var client = new Thread(() => {
      Thread.Sleep(800);
      try {
        var co = new NamedPipeClientStream(".", "acprep.out", PipeDirection.In);
        co.Connect(3000);
        var buf = new byte[512];
        var readT = new Thread(() => {
          try { int n = co.Read(buf, 0, 512); L("!CLIENT out read: " + n + " bytes: " + (n > 0 ? Encoding.UTF8.GetString(buf,0,n).Trim() : "EOF")); }
          catch (Exception e) { L("!CLIENT out err: " + e.Message); }
        });
        readT.Start();
        var ci = new NamedPipeClientStream(".", "acprep.in", PipeDirection.Out);
        ci.Connect(3000);
        var b = Encoding.UTF8.GetBytes("LYXSRV:rep:hello\n");
        ci.Write(b, 0, b.Length); ci.Flush();
        L("!CLIENT sent hello");
        Thread.Sleep(500);
        var b2 = Encoding.UTF8.GetBytes("LYXCMD:rep:server-get-filename:\n");
        ci.Write(b2, 0, b2.Length); ci.Flush();
        L("!CLIENT sent command");
        readT.Join(3000);
      } catch (Exception e) { L("!CLIENT fatal: " + e.Message); }
    });
    client.Start();
    client.Join(10000);
    Thread.Sleep(1500);
    SetEvent(stopEv);
    server.Join(3000);

    var sb = new StringBuilder();
    sb.AppendLine("total iterations: " + iters);
    string line; int c = 0;
    while (log.TryDequeue(out line) && c < 400) { sb.AppendLine(line); c++; }
    return sb.ToString();
  }
}
'@
Add-Type -TypeDefinition $code
Write-Output ([LyxReplica]::Run())