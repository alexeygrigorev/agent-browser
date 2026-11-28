# Managed Chrome launch for the agent-browser bridge (Windows, user scope).
#
# Chrome throttles occluded/background renderers: with the desktop session
# disconnected (query session = Disc) documents report visibilityState "hidden",
# trusted input is dropped and synthetic clicks never reach page handlers. Both
# flags below turn that off, but they only apply when passed on the command line
# of the FIRST Chrome process, so every launch must go through this script.
#
#   managed-chrome.ps1 -Ensure    start Chrome if it is not running; never touches a running one
#   managed-chrome.ps1 -Restart   stop Chrome gracefully and relaunch it with the flags, restoring tabs
#   managed-chrome.ps1 -Verify    report whether the running Chrome carries both flags
#   managed-chrome.ps1 -Install   register the autostart task (logon + every 5 minutes, -Ensure)
#   managed-chrome.ps1 -Uninstall remove the autostart task
#
# The user data dir and profile are the ones the bridge already connects to
# (Chrome default dir, -ProfileDirectory 'Profile 1'), so logins are untouched.
# Open tabs are restored by Chrome itself (--restore-last-session); their URLs
# are also saved to a JSON file as a backup. Nothing is ever clicked or filled.
[CmdletBinding()]
param(
  [switch]$Ensure,
  [switch]$Restart,
  [switch]$Verify,
  [switch]$Install,
  [switch]$Uninstall,
  [string]$ProfileDirectory = 'Profile 1',
  [string]$UserDataDir = (Join-Path $env:LOCALAPPDATA 'Google\Chrome\User Data'),
  [string]$Chrome = 'C:\Program Files\Google\Chrome\Application\chrome.exe',
  [string]$Browser = 'orin',
  [string]$TabBackup = (Join-Path $env:USERPROFILE '.agent-browser\managed-chrome-tabs.json')
)
$ErrorActionPreference = 'Stop'
$TaskName = 'Agent Browser Managed Chrome'
$RequiredFlags = @('--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding')
$CustomDataDir = $PSBoundParameters.ContainsKey('UserDataDir')
$Cli = Join-Path (Split-Path -Parent $PSScriptRoot) 'bin\cli.js'

function Get-MainChrome {
  # The browser process is the chrome.exe without --type=.
  Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" |
    Where-Object { -not $_.CommandLine -or $_.CommandLine -notmatch '--type=' }
}

function Test-Flags($commandLine) {
  foreach ($flag in $RequiredFlags) { if (-not $commandLine -or $commandLine -notmatch [regex]::Escape($flag)) { return $false } }
  $true
}

function Save-Tabs {
  # URL list only, via the bridge; best effort because the bridge may be down.
  try {
    $raw = & node $Cli --browser $Browser call tabs.list 2>$null
    $urls = ($raw | ConvertFrom-Json) | ForEach-Object { $_.url } | Where-Object { $_ }
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $TabBackup) | Out-Null
    $urls | ConvertTo-Json | Set-Content -Encoding utf8 -Path $TabBackup
    Write-Output "Saved $(@($urls).Count) tab URLs to $TabBackup"
  } catch { Write-Warning "Tab backup skipped: $($_.Exception.Message)" }
}

function Start-ManagedChrome {
  $chromeArgs = @($RequiredFlags) + @("--profile-directory=$ProfileDirectory", '--restore-last-session')
  if ($CustomDataDir) { $chromeArgs += "--user-data-dir=$UserDataDir" }
  Start-Process -FilePath $Chrome -ArgumentList $chromeArgs | Out-Null
  Write-Output "Started Chrome with: $($chromeArgs -join ' ')"
}

if ($Install) {
  $self = $MyInvocation.MyCommand.Path
  $action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$self`" -Ensure"
  $logon = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
  $repeat = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 5)
  $principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited
  Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger @($logon, $repeat) -Principal $principal -Force | Out-Null
  Write-Output "Registered scheduled task '$TaskName'"
  return
}
if ($Uninstall) {
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
  Write-Output "Removed scheduled task '$TaskName'"
  return
}

$main = @(Get-MainChrome)

if ($Verify) {
  if (-not $main) { Write-Output 'Chrome is not running'; exit 2 }
  $commandLine = $main[0].CommandLine
  if (-not $commandLine) {
    Write-Warning 'Command line unreadable; open chrome://version in Chrome to read it, or check document.visibilityState via the bridge.'
    exit 3
  }
  if (Test-Flags $commandLine) { Write-Output "OK: both flags present`n$commandLine"; exit 0 }
  Write-Output "MISSING flags (run -Restart)`n$commandLine"; exit 1
}

if ($Restart) {
  Save-Tabs
  foreach ($p in $main) {
    # Graceful close first so Chrome writes its session for --restore-last-session.
    $proc = Get-Process -Id $p.ProcessId -ErrorAction SilentlyContinue
    if ($proc) { $null = $proc.CloseMainWindow() }
  }
  $deadline = (Get-Date).AddSeconds(20)
  while ((Get-Process chrome -ErrorAction SilentlyContinue) -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 500 }
  if (Get-Process chrome -ErrorAction SilentlyContinue) {
    # Windows without a display may ignore WM_CLOSE; end the browser process tree.
    foreach ($p in $main) { & taskkill /PID $p.ProcessId /T /F | Out-Null }
    Start-Sleep -Seconds 2
  }
  if (Get-Process chrome -ErrorAction SilentlyContinue) {
    throw 'Failed to stop existing Chrome process(es) (access denied or still running); run -Restart from the account/session that owns Chrome.'
  }
  Start-ManagedChrome
  return
}

# -Ensure (default): only start when nothing is running.
if ($main) {
  if ($main[0].CommandLine -and -not (Test-Flags $main[0].CommandLine)) {
    Write-Warning 'Chrome is running without the anti-backgrounding flags; run -Restart to relaunch it.'
  }
  return
}
Start-ManagedChrome
