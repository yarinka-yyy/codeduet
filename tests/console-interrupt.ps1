param([Parameter(Mandatory)][int]$TargetProcess)
$ErrorActionPreference = 'Stop'
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class DuetConsole {
  [DllImport("kernel32.dll", SetLastError=true)] public static extern bool FreeConsole();
  [DllImport("kernel32.dll", SetLastError=true)] public static extern bool AttachConsole(uint id);
  [DllImport("kernel32.dll")] public static extern uint GetConsoleProcessList(uint[] ids, uint size);
  [DllImport("kernel32.dll")] public static extern bool SetConsoleCtrlHandler(IntPtr handler, bool ignore);
  [DllImport("kernel32.dll")] public static extern bool GenerateConsoleCtrlEvent(uint kind, uint group);
}
'@
[void][DuetConsole]::FreeConsole()
if (![DuetConsole]::AttachConsole($TargetProcess)) { throw 'Cannot attach isolated child console' }
try {
  $duetConsoleIds = New-Object uint32[] 8
  $duetCount = [DuetConsole]::GetConsoleProcessList($duetConsoleIds, 8)
  if ($duetCount -ne 2 -or $duetConsoleIds[0..1] -notcontains $TargetProcess -or
      $duetConsoleIds[0..1] -notcontains $PID) { throw 'Console is not exclusively the disposable child and generator' }
  if (![DuetConsole]::SetConsoleCtrlHandler([IntPtr]::Zero, $true)) { throw 'Cannot protect generator' }
  if (![DuetConsole]::GenerateConsoleCtrlEvent(0, 0)) { throw 'Cannot deliver Ctrl+C' }
  Start-Sleep -Milliseconds 100
} finally { [void][DuetConsole]::FreeConsole() }
