<#
.SYNOPSIS
  Installs the radarwake pc-agent on the Windows workstation.

.DESCRIPTION
  - Copies the agent to C:\Program Files\radarwake-agent (config.json is readable by
    Administrators and SYSTEM only).
  - Asks for the server address and agent secret if no config.json exists yet.
  - Registers a scheduled task that starts the agent at boot as SYSTEM (before login),
    restarting it on failure.
  - Opens TCP 8765 for the server IP only (Private profile).

  Uses radarwake-agent.exe when present (release zip), otherwise agent.py + pythonw.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\install.ps1
.EXAMPLE
  .\install.ps1 -ServerIp 192.168.1.146 -Secret <PC_AGENT_SECRET> -PowerButtonDoNothing -DisableHibernate
#>
param(
    [Alias("LaptopIp")][string]$ServerIp,
    [string]$Secret,
    [int]$Port = 8765,
    [string]$InstallDir = (Join-Path $env:ProgramFiles "radarwake-agent"),
    [switch]$PowerButtonDoNothing,
    [switch]$DisableHibernate
)

$ErrorActionPreference = "Stop"

$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole(
    [Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
    # Yonetici olarak yeniden baslat, ayni parametrelerle
    $argList = @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", "`"$PSCommandPath`"")
    foreach ($kv in $PSBoundParameters.GetEnumerator()) {
        if ($kv.Value -is [switch]) { if ($kv.Value) { $argList += "-$($kv.Key)" } }
        else { $argList += "-$($kv.Key)", "`"$($kv.Value)`"" }
    }
    Start-Process powershell -Verb RunAs -ArgumentList $argList -Wait
    exit
}

$src = $PSScriptRoot
$taskName = "radarwake-agent"

# Calisan ajani durdur ki exe uzerine yazilabilsin
if (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue) {
    Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 1
}

New-Item -ItemType Directory -Force $InstallDir | Out-Null
foreach ($f in "radarwake-agent.exe", "agent.py", "config.example.json", "uninstall.ps1") {
    $p = Join-Path $src $f
    if ((Test-Path $p) -and ((Resolve-Path $src).Path -ne (Resolve-Path $InstallDir).Path)) {
        Copy-Item $p $InstallDir -Force
    }
}

# --- config.json ---
$configPath = Join-Path $InstallDir "config.json"
$localConfig = Join-Path $src "config.json"
if (-not (Test-Path $configPath) -and (Test-Path $localConfig)) {
    Copy-Item $localConfig $configPath
}
if (Test-Path $configPath) {
    $cfg = Get-Content $configPath -Raw | ConvertFrom-Json
    if (-not $ServerIp) { $ServerIp = ([Uri]$cfg.backend_url).Host }
    if ($Secret) { $cfg.secret = $Secret }
} else {
    if (-not $ServerIp) { $ServerIp = Read-Host "Server LAN IP (e.g. 192.168.1.146)" }
    if (-not $Secret) {
        $sec = Read-Host "PC_AGENT_SECRET (from the server's backend/.env)" -AsSecureString
        $Secret = [Runtime.InteropServices.Marshal]::PtrToStringAuto(
            [Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec))
    }
    $cfg = [ordered]@{
        backend_url          = "http://${ServerIp}:8001"
        secret               = $Secret
        listen_host          = "0.0.0.0"
        listen_port          = $Port
        allowed_ips          = @($ServerIp)
        heartbeat_interval_s = 30
    }
}
if (-not $cfg.secret -or $cfg.secret -like "*PC_AGENT_SECRET*") { throw "config.json: secret is empty" }
($cfg | ConvertTo-Json) | Set-Content -Path $configPath -Encoding ascii

# Secret sadece Administrators + SYSTEM tarafindan okunabilsin
icacls $configPath /inheritance:r /grant:r "*S-1-5-32-544:F" "*S-1-5-18:F" | Out-Null

# --- calistirilacak dosya ---
$exe = Join-Path $InstallDir "radarwake-agent.exe"
if (Test-Path $exe) {
    $action = New-ScheduledTaskAction -Execute $exe -WorkingDirectory $InstallDir
} else {
    $pythonw = (Get-Command pythonw.exe -ErrorAction SilentlyContinue).Source
    if (-not $pythonw) { throw "radarwake-agent.exe not found and pythonw.exe not on PATH (install python.org Python for all users)" }
    if ($pythonw -like "*WindowsApps*") { throw "Microsoft Store Python does not run under SYSTEM; install the python.org build" }
    $action = New-ScheduledTaskAction -Execute $pythonw -Argument "`"$(Join-Path $InstallDir 'agent.py')`"" -WorkingDirectory $InstallDir
}

$trigger = New-ScheduledTaskTrigger -AtStartup
$principal = New-ScheduledTaskPrincipal -UserId "SYSTEM" -LogonType ServiceAccount -RunLevel Highest
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero)
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Principal $principal `
    -Settings $settings -Force | Out-Null
Write-Host "[ok] Scheduled task: $taskName"

$ruleName = "radarwake-agent-$Port"
Get-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue | Remove-NetFirewallRule
New-NetFirewallRule -DisplayName $ruleName -Direction Inbound -Protocol TCP -LocalPort $Port `
    -RemoteAddress $ServerIp -Action Allow -Profile Private | Out-Null
Write-Host "[ok] Firewall: TCP $Port <- $ServerIp (Private profile)"

if ($PowerButtonDoNothing) {
    powercfg /setacvalueindex SCHEME_CURRENT SUB_BUTTONS PBUTTONACTION 0
    powercfg /setdcvalueindex SCHEME_CURRENT SUB_BUTTONS PBUTTONACTION 0
    powercfg /setactive SCHEME_CURRENT
    Write-Host "[ok] Power button action: do nothing"
}

if ($DisableHibernate) {
    powercfg /h off
    Write-Host "[ok] Hibernation off (sleep is real S3 sleep; Fast Startup disabled)"
}

$publicNet = Get-NetConnectionProfile -ErrorAction SilentlyContinue | Where-Object { $_.NetworkCategory -eq "Public" }
if ($publicNet) {
    Write-Warning "Network '$($publicNet.Name)' is Public; the firewall rule only applies to Private networks. Set it to Private in Windows settings."
}

Start-ScheduledTask -TaskName $taskName
Write-Host "[ok] Agent running from $InstallDir (log: agent.log)"
