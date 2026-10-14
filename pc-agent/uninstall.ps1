<#
.SYNOPSIS
  Removes the radarwake pc-agent (scheduled task, firewall rule, install folder).
#>
param(
    [string]$InstallDir = (Join-Path $env:ProgramFiles "radarwake-agent"),
    [switch]$KeepConfig
)

$ErrorActionPreference = "Stop"

$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole(
    [Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
    $argList = @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", "`"$PSCommandPath`"")
    if ($KeepConfig) { $argList += "-KeepConfig" }
    Start-Process powershell -Verb RunAs -ArgumentList $argList -Wait
    exit
}

$taskName = "radarwake-agent"
if (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue) {
    Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
    Write-Host "[ok] Scheduled task removed"
}

Get-NetFirewallRule -DisplayName "radarwake-agent-*" -ErrorAction SilentlyContinue | Remove-NetFirewallRule
Write-Host "[ok] Firewall rule removed"

if (Test-Path $InstallDir) {
    Start-Sleep -Seconds 1
    if ($KeepConfig) {
        Get-ChildItem $InstallDir | Where-Object { $_.Name -ne "config.json" } | Remove-Item -Recurse -Force
    } else {
        Remove-Item $InstallDir -Recurse -Force
    }
    Write-Host "[ok] $InstallDir removed"
}

Write-Host "Power button / hibernation settings were left unchanged."
