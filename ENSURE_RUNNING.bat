@echo off
:: ============================================================================
::  Kubera -- Ensure Running (idempotent)
::  Safe to run on wake-from-sleep, unlock, logon, or boot.
::  Starts the daemon (5003) and UI (5004) ONLY if they are not already
::  listening -- repeated triggers never spawn duplicates or cause EADDRINUSE.
::  Ports are deliberately 5003/5004 so Kubera never collides with Sutra (3001/3006).
::
::  Daemon: direct node process in a visible cmd window (no pm2).
::    - crash is visible; window stays open with error message
::    - no restart loop; port releases cleanly before next start attempt
::  UI: pm2 (stable, never crashes, no reason to change)
:: ============================================================================
title Kubera -- Ensure Running
cd /d "%~dp0"

:: -- Daemon on 5003 -----------------------------------------------------------
:: NOTE: netstat probes instead of Get-NetTCPConnection -- the latter is CIM/WMI-
:: backed and can hang for minutes on Windows 11, which would freeze this watchdog.
PowerShell -NoProfile -Command "if (netstat -ano | Select-String ':5003\s' | Where-Object { $_ -match 'LISTENING' }) { exit 0 } else { exit 1 }"
if errorlevel 1 (
  echo [ENSURE] Daemon not on 5003 -- checking for stale port holder...
  PowerShell -NoProfile -Command "$p = netstat -ano | Select-String ':5003\s' | Where-Object { $_ -match 'LISTENING' } | ForEach-Object { ($_.ToString().Trim() -split '\s+')[-1] } | Where-Object { [int]$_ -gt 4 } | Sort-Object -Unique | Select-Object -First 1; if ($p) { Stop-Process -Id $p -Force -ErrorAction SilentlyContinue; Start-Sleep -Seconds 2; Write-Host '[ENSURE] Killed stale PID' $p }"
  echo [ENSURE] Starting Kubera daemon on 5003...
  start "Kubera Daemon [5003]" cmd /k "cd /d "%~dp0" && node daemon/dist/index.js || (echo. & echo [DAEMON CRASHED -- check error above] & pause)"
) else (
  echo [ENSURE] Daemon already running on 5003 -- leaving it alone.
)

:: -- UI on 5004 ---------------------------------------------------------------
PowerShell -NoProfile -Command "if (netstat -ano | Select-String ':5004\s' | Where-Object { $_ -match 'LISTENING' }) { exit 0 } else { exit 1 }"
if errorlevel 1 (
  echo [ENSURE] UI not on 5004 -- starting kubera-ui via pm2...
  pm2 restart kubera-ui
  if errorlevel 1 (
    rem pm2 cannot run npm.cmd on Windows (parses the .cmd as JS -> SyntaxError) -- launch vite's
    rem JS entry directly so the UI process stays up and auto-starts every morning.
    pm2 start node_modules\vite\bin\vite.js --name kubera-ui -- --port=5004 --host=0.0.0.0
  )
) else (
  echo [ENSURE] UI already running on 5004 -- leaving it alone.
)

echo [ENSURE] Done.
exit /b 0
