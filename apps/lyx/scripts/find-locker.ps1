param([string]$Path = "$PSScriptRoot\..\release\win-unpacked\resources\app.asar")
$src = @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class RmFind {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct RM_UNIQUE_PROCESS { public int dwProcessId; public System.Runtime.InteropServices.ComTypes.FILETIME ProcessStartTime; }
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct RM_PROCESS_INFO {
    public RM_UNIQUE_PROCESS Process;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 256)] public string strAppName;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 64)] public string strServiceShortName;
    public int ApplicationType; public uint AppStatus; public uint TSSessionId;
    [MarshalAs(UnmanagedType.Bool)] public bool bRestartable;
  }
  [DllImport("rstrtmgr.dll", CharSet = CharSet.Unicode)]
  public static extern int RmRegisterResources(uint pSessionHandle, uint nFiles, string[] rgsFilenames, uint nApplications, RM_UNIQUE_PROCESS[] rgApplications, uint nServices, string[] rgsServiceNames);
  [DllImport("rstrtmgr.dll", CharSet = CharSet.Unicode)]
  public static extern int RmStartSession(out uint pSessionHandle, int dwSessionFlags, string strSessionKey);
  [DllImport("rstrtmgr.dll", CharSet = CharSet.Unicode)]
  public static extern int RmEndSession(uint pSessionHandle);
  [DllImport("rstrtmgr.dll", CharSet = CharSet.Unicode)]
  public static extern int RmGetList(uint dwSessionHandle, out uint pnProcInfoNeeded, ref uint pnProcInfo, [In, Out] RM_PROCESS_INFO[] rgAffectedApps, ref uint lpdwRebootReasons);
}
'@
Add-Type -TypeDefinition $src
$sessionKey = [Guid]::NewGuid().ToString()
$handle = 0
[void][RmFind]::RmStartSession([ref]$handle, 0, $sessionKey)
[void][RmFind]::RmRegisterResources($handle, 1, @($Path), 0, $null, 0, $null)
$needed = 0; $count = 10; $reasons = 0
$apps = New-Object RmFind+RM_PROCESS_INFO[] $count
$res = [RmFind]::RmGetList($handle, [ref]$needed, [ref]$count, $apps, [ref]$reasons)
for ($i = 0; $i -lt $count; $i++) {
  $pid = $apps[$i].Process.dwProcessId
  $proc = Get-Process -Id $pid -ErrorAction SilentlyContinue
  "{0} pid={1} exe={2}" -f $apps[$i].strAppName, $pid, $proc.Path
}
[void][RmFind]::RmEndSession($handle)
if ($count -eq 0) { "no lockers found" }