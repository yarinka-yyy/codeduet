$ErrorActionPreference = 'Stop'
$Root = '<RUN>'
$PgBin = '<BIN>'
$PgCtl = Join-Path $PgBin 'pg_ctl.exe'
$PgData = Join-Path $Root 'data'
$PgLog = Join-Path $Root 'logs\postgres.log'
$Port = 65428

function Invoke-PgCtl {
    param([string[]]$PgCtlArgs, [int]$TimeoutMs = 90000)
    $argLine = ($PgCtlArgs | ForEach-Object { if ($_ -match '\s') { '"' + $_ + '"' } else { $_ } }) -join ' '
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = $PgCtl
    $psi.Arguments = $argLine
    $psi.UseShellExecute = $false
    $psi.CreateNoWindow = $true
    $psi.RedirectStandardInput = $true
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $proc = [System.Diagnostics.Process]::Start($psi)
    try {
        if (-not $proc.WaitForExit($TimeoutMs)) {
            try { $proc.Kill() } catch { }
            throw "pg_ctl did not exit within ${TimeoutMs}ms"
        }
        $proc.StandardOutput.ReadToEnd() | Out-Null
        $proc.StandardError.ReadToEnd() | Out-Null
        return $proc.ExitCode
    } finally { $proc.Dispose() }
}

function Get-ClusterStatus {
    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        & $PgCtl -D $PgData status *> $null
        return $LASTEXITCODE
    } finally { $ErrorActionPreference = $previous }
}

function Get-PortListeners {
    param([int]$Port)
    return @([Net.NetworkInformation.IPGlobalProperties]::GetIPGlobalProperties().GetActiveTcpListeners() |
        Where-Object { $_.Port -eq $Port })
}
