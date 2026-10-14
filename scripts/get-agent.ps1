# One-line installer for the radarwake pc-agent (Windows workstation):
#
#   irm https://github.com/AkoSuminoe/radarwake/releases/latest/download/get-agent.ps1 | iex
#
# Downloads the latest release zip and runs its install.ps1 (asks for elevation,
# the server IP and the agent secret).

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$url = "https://github.com/AkoSuminoe/radarwake/releases/latest/download/radarwake-agent-windows.zip"
$tmp = Join-Path $env:TEMP ("radarwake-agent-" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Force $tmp | Out-Null

Write-Host "Downloading $url"
Invoke-WebRequest -Uri $url -OutFile (Join-Path $tmp "agent.zip") -UseBasicParsing
Expand-Archive (Join-Path $tmp "agent.zip") -DestinationPath $tmp -Force

& powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $tmp "install.ps1") -PowerButtonDoNothing -DisableHibernate
Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
