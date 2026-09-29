# start.ps1 — opens the Orchestrator in its own Chrome/Edge window (--app), separate
# from the normal browser, with its own taskbar button. Starts the server first if needed.
# -ServerOnly: só sobe o servidor (+ tailscale serve), sem abrir janela. É o que o
# atalho da pasta Inicializar do Windows usa (start-server.vbs), pro celular já achar.
param([switch]$ServerOnly)
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

# Expose over the tailnet so the phone can reach it. `tailscale serve` proxies the
# tailnet (HTTPS, your devices only) to 127.0.0.1:$port — the server itself stays
# localhost-bound. Silent no-op if Tailscale isn't installed; --bg persists the route.
if (Get-Command tailscale -ErrorAction SilentlyContinue) {
  try { & tailscale serve --bg $port 2>$null | Out-Null } catch {}
}
if ($ServerOnly) { exit }

# Edge primeiro: é o único que expõe as vozes neurais da Microsoft ("… Online (Natural)",
# pt-BR) ao speechSynthesis — o ▶ soa bem menos robótico nele. Force o Chrome com
# ORCH_BROWSER=chrome (ou aponte ORCH_BROWSER para um .exe).
$candidates = @(
  'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe',
  'C:\Program Files\Microsoft\Edge\Application\msedge.exe',
  (Join-Path $env:LOCALAPPDATA 'Google\Chrome\Application\chrome.exe'),
  'C:\Program Files\Google\Chrome\Application\chrome.exe',
  'C:\Program Files (x86)\Google\Chrome\Application\chrome.exe'
)
if ($env:ORCH_BROWSER) {
  if (Test-Path $env:ORCH_BROWSER) { $candidates = @($env:ORCH_BROWSER) }
  else { $candidates = @($candidates | Where-Object { $_ -like "*$($env:ORCH_BROWSER)*" }) + $candidates }
}
$exe = $candidates | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1

if ($exe) { Start-Process -FilePath $exe -ArgumentList "--app=$url", '--window-size=1440,900' }
else { Start-Process $url }
