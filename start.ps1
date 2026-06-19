# start.ps1 — opens the Orchestrator in its own Chrome/Edge window (--app), separate
# from the normal browser, with its own taskbar button. Starts the server first if needed.
$ErrorActionPreference = 'SilentlyContinue'
$port   = if ($env:ORCH_PORT) { [int]$env:ORCH_PORT } else { 4319 }
$url    = "http://127.0.0.1:$port/"
$server = Join-Path $PSScriptRoot 'server.mjs'

function Test-Port {
  try { $c = New-Object Net.Sockets.TcpClient; $c.Connect('127.0.0.1', $port); $c.Close(); return $true }
  catch { return $false }
}

if (-not (Test-Port)) {
  Start-Process -FilePath 'node' -ArgumentList "`"$server`"" -WorkingDirectory $PSScriptRoot -WindowStyle Hidden
  for ($i = 0; $i -lt 50; $i++) { if (Test-Port) { break }; Start-Sleep -Milliseconds 200 }
}

$candidates = @(
  (Join-Path $env:LOCALAPPDATA 'Google\Chrome\Application\chrome.exe'),
  'C:\Program Files\Google\Chrome\Application\chrome.exe',
  'C:\Program Files (x86)\Google\Chrome\Application\chrome.exe',
  'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe',
  'C:\Program Files\Microsoft\Edge\Application\msedge.exe'
)
$exe = $candidates | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1

if ($exe) { Start-Process -FilePath $exe -ArgumentList "--app=$url", '--window-size=1440,900' }
else { Start-Process $url }
