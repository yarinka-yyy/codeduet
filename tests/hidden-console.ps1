param([Parameter(Mandatory)][string]$NodeExe, [Parameter(Mandatory)][string]$ArgumentsBase64)
$ErrorActionPreference = 'Stop'
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class DuetHiddenConsole {
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
  public struct Startup {
    public uint cb; public string reserved, desktop, title;
    public uint x,y,xSize,ySize,xChars,yChars,fill,flags;
    public ushort show, reservedSize; public IntPtr reservedBytes, input, output, error;
  }
  [StructLayout(LayoutKind.Sequential)] public struct Info {
    public IntPtr process, thread; public uint pid, tid;
  }
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  public static extern bool CreateProcess(string app, string command, IntPtr pa, IntPtr ta,
    bool inherit, uint flags, IntPtr env, string cwd, ref Startup startup, out Info info);
  [DllImport("kernel32.dll")] public static extern IntPtr GetStdHandle(int id);
  [DllImport("kernel32.dll")] public static extern uint WaitForSingleObject(IntPtr handle, uint time);
  [DllImport("kernel32.dll")] public static extern bool GetExitCodeProcess(IntPtr handle, out uint code);
  [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr handle);
}
'@
$duetArguments = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($ArgumentsBase64)) | ConvertFrom-Json
$duetQuoted = @($NodeExe) + @($duetArguments) | ForEach-Object {
  if ($_ -match '["\r\n]' -or $_.EndsWith('\')) { throw 'Unexpected disposable test argument' }
  '"' + $_ + '"'
}
$duetStartup = New-Object DuetHiddenConsole+Startup
$duetStartup.cb = [Runtime.InteropServices.Marshal]::SizeOf($duetStartup)
$duetStartup.flags = 0x101 # STARTF_USESHOWWINDOW | STARTF_USESTDHANDLES
$duetStartup.show = 0 # SW_HIDE, including the newly allocated test console
$duetStartup.input = [DuetHiddenConsole]::GetStdHandle(-10)
$duetStartup.output = [DuetHiddenConsole]::GetStdHandle(-11)
$duetStartup.error = [DuetHiddenConsole]::GetStdHandle(-12)
$duetInfo = New-Object DuetHiddenConsole+Info
if (![DuetHiddenConsole]::CreateProcess($NodeExe, ($duetQuoted -join ' '), [IntPtr]::Zero,
  [IntPtr]::Zero, $true, 0x10, [IntPtr]::Zero, (Get-Location).Path, [ref]$duetStartup, [ref]$duetInfo)) {
  throw 'Cannot create hidden disposable console'
}
[void][DuetHiddenConsole]::CloseHandle($duetInfo.thread)
try {
  [void][DuetHiddenConsole]::WaitForSingleObject($duetInfo.process, 45000)
  [uint32]$duetCode = 1
  if (![DuetHiddenConsole]::GetExitCodeProcess($duetInfo.process, [ref]$duetCode)) { throw 'Cannot read child exit' }
} finally { [void][DuetHiddenConsole]::CloseHandle($duetInfo.process) }
exit $duetCode
