<#
radarwake PC ajanini masaustune kurar. Yonetici PowerShell'de calistir:

  powershell -ExecutionPolicy Bypass -File .\install.ps1 -LaptopIp 192.168.1.50

- Ajan, Windows acilirken (oturum acilmadan once) SYSTEM olarak baslar.
  Boylece giris ekranindaki PC de "acik" gorunur ve guc tusuna yanlislikla basilmaz.
- 8765 portu sadece laptop IP'sine acilir.
- -PowerButtonDoNothing: Windows'ta guc tusu eylemini "hicbir sey yapma" yapar.
  Acik PC'ye yanlislikla basma komutu gelirse PC kapanmaz; kapali/uykudaki PC'yi
  acma ozelligi donanim seviyesinde oldugu icin calismaya devam eder.
#>
param(
    [Parameter(Mandatory = $true)][string]$LaptopIp,
    [int]$Port = 8765,
    [switch]$PowerButtonDoNothing,
    [switch]$DisableHibernate
)

$ErrorActionPreference = "Stop"
$agentDir = $PSScriptRoot
$agent = Join-Path $agentDir "agent.py"

if (-not (Test-Path (Join-Path $agentDir "config.json"))) {
    throw "config.json yok: config.example.json dosyasini kopyalayip doldur"
}

$pythonw = (Get-Command pythonw.exe -ErrorAction SilentlyContinue).Source
if (-not $pythonw) { throw "pythonw.exe bulunamadi; Python'u 'tum kullanicilar icin' kur" }
if ($pythonw -like "*WindowsApps*") { throw "Microsoft Store Python'u SYSTEM altinda calismaz; python.org surumunu kur" }

$taskName = "radarwake-agent"
$action = New-ScheduledTaskAction -Execute $pythonw -Argument "`"$agent`"" -WorkingDirectory $agentDir
$trigger = New-ScheduledTaskTrigger -AtStartup
$principal = New-ScheduledTaskPrincipal -UserId "SYSTEM" -LogonType ServiceAccount -RunLevel Highest
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero)
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Principal $principal `
    -Settings $settings -Force | Out-Null
Write-Host "Zamanlanmis gorev kuruldu: $taskName"

$ruleName = "radarwake-agent-$Port"
Get-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue | Remove-NetFirewallRule
New-NetFirewallRule -DisplayName $ruleName -Direction Inbound -Protocol TCP -LocalPort $Port `
    -RemoteAddress $LaptopIp -Action Allow -Profile Private | Out-Null
Write-Host "Firewall kurali: TCP $Port <- $LaptopIp (Private profil)"

if ($PowerButtonDoNothing) {
    powercfg /setacvalueindex SCHEME_CURRENT SUB_BUTTONS PBUTTONACTION 0
    powercfg /setdcvalueindex SCHEME_CURRENT SUB_BUTTONS PBUTTONACTION 0
    powercfg /setactive SCHEME_CURRENT
    Write-Host "Guc tusu eylemi: hicbir sey yapma"
}

if ($DisableHibernate) {
    powercfg /h off
    Write-Host "Hazirda bekletme kapatildi (sleep komutu gercek uyku yapar, Fast Startup da kapanir)"
}

Start-ScheduledTask -TaskName $taskName
Write-Host "Ajan baslatildi. Log: $(Join-Path $agentDir 'agent.log')"
