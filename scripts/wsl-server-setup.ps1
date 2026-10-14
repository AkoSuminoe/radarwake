<#
.SYNOPSIS
  Windows-side setup for a radarwake server running in WSL2 (Docker inside WSL).

.DESCRIPTION
  One line, in an elevated PowerShell:
    irm https://github.com/AkoSuminoe/radarwake/releases/latest/download/wsl-server-setup.ps1 | iex

  - Sets networkingMode=mirrored in %UserProfile%\.wslconfig so the container ports are
    reachable on the Windows host's LAN IP.
  - Allows TCP 8000/8001 into WSL (Hyper-V firewall) and from the local subnet only
    (Windows Firewall, Private profile).
  - Registers a startup task that keeps the WSL distro (and Docker) running without
    anyone logging in.
#>
param(
    [string]$Distro = "",
    [int[]]$Ports = @(8000, 8001),
    [switch]$NoAutostart
)

$ErrorActionPreference = "Stop"

$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole(
    [Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) { throw "Run this in an elevated PowerShell (Run as administrator)." }

# --- 1) mirrored networking ---
$wslconfig = Join-Path $env:USERPROFILE ".wslconfig"
$lines = if (Test-Path $wslconfig) { @(Get-Content $wslconfig) } else { @() }
$out = New-Object System.Collections.Generic.List[string]
$inWsl2 = $false; $sawSection = $false; $done = $false
foreach ($l in $lines) {
    if ($l -match '^\s*\[(.+)\]\s*$') {
        if ($inWsl2 -and -not $done) { $out.Add("networkingMode=mirrored"); $done = $true }
        $inWsl2 = $Matches[1].Trim() -eq "wsl2"
        if ($inWsl2) { $sawSection = $true }
        $out.Add($l); continue
    }
    if ($inWsl2 -and $l -match '^\s*networkingMode\s*=') { $out.Add("networkingMode=mirrored"); $done = $true; continue }
    $out.Add($l)
}
if ($inWsl2 -and -not $done) { $out.Add("networkingMode=mirrored"); $done = $true }
if (-not $sawSection) { $out.Add("[wsl2]"); $out.Add("networkingMode=mirrored") }
$changed = (($lines -join "`n") -ne ($out -join "`n"))
if ($changed) {
    Set-Content -Path $wslconfig -Value $out -Encoding ascii
    Write-Host "[ok] $wslconfig -> networkingMode=mirrored (WSL restart needed)"
} else {
    Write-Host "[ok] mirrored networking already set"
}

# --- 2) firewalls ---
$wslVmCreatorId = "{40E0AC32-46A5-438A-A0B2-2B479E8F2E90}"
if (Get-Command New-NetFirewallHyperVRule -ErrorAction SilentlyContinue) {
    Get-NetFirewallHyperVRule -Name "radarwake-wsl" -ErrorAction SilentlyContinue | Remove-NetFirewallHyperVRule
    New-NetFirewallHyperVRule -Name "radarwake-wsl" -DisplayName "radarwake (WSL)" -Direction Inbound `
        -VMCreatorId $wslVmCreatorId -Protocol TCP -LocalPorts $Ports -Action Allow | Out-Null
    Write-Host "[ok] Hyper-V firewall: TCP $($Ports -join ',') -> WSL"
} else {
    Write-Warning "Hyper-V firewall cmdlets not found (older Windows); skipping"
}

Get-NetFirewallRule -DisplayName "radarwake-server" -ErrorAction SilentlyContinue | Remove-NetFirewallRule
New-NetFirewallRule -DisplayName "radarwake-server" -Direction Inbound -Protocol TCP -LocalPort $Ports `
    -RemoteAddress LocalSubnet -Action Allow -Profile Private | Out-Null
Write-Host "[ok] Windows Firewall: TCP $($Ports -join ',') from the local subnet (Private profile)"

$publicNet = Get-NetConnectionProfile -ErrorAction SilentlyContinue | Where-Object { $_.NetworkCategory -eq "Public" }
if ($publicNet) {
    Write-Warning "Network '$($publicNet.Name)' is Public; set it to Private or the rule does not apply."
}

# --- 3) keep WSL running at boot ---
if (-not $NoAutostart) {
    if (-not $Distro) {
        $Distro = (wsl.exe -l -q | ForEach-Object { ($_ -replace "`0", "").Trim() } | Where-Object { $_ } | Select-Object -First 1)
    }
    $user = "$env:USERDOMAIN\$env:USERNAME"
    $action = New-ScheduledTaskAction -Execute "wsl.exe" -Argument "-d `"$Distro`" --exec sleep infinity"
    $trigger = New-ScheduledTaskTrigger -AtStartup
    $principal = New-ScheduledTaskPrincipal -UserId $user -LogonType S4U -RunLevel Highest
    $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
        -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero)
    Register-ScheduledTask -TaskName "radarwake-wsl" -Action $action -Trigger $trigger -Principal $principal `
        -Settings $settings -Force | Out-Null
    Write-Host "[ok] Startup task 'radarwake-wsl' keeps '$Distro' running (no login needed)"
}

if ($changed) {
    Write-Host ""
    Write-Host "Restart WSL to apply mirrored networking:  wsl --shutdown   (then open your distro again)"
}
