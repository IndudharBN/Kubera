@echo off
:: ============================================================================
::  Kubera -- Daemon Restart Only (UI on 5004 stays up)
::  Rebuilds the daemon from source, kills the old process on 5003, and
::  starts a fresh visible "Kubera Daemon [5003]" window. The pm2 UI is left
::  untouched and auto-reconnects over the websocket.
:: ============================================================================
title Kubera -- Daemon Restart
cls
echo.
echo  =====================================================
echo    Kubera  ^|  Daemon Restart (UI stays up)
echo  =====================================================
echo.
cd /d "%~dp0"

:: -- Build first; if it fails, leave the running daemon alone --------------
echo  [1/3] Building daemon (tsc)...
call npm run build:daemon
if errorlevel 1 (
  echo.
  echo  [BUILD FAILED] -- daemon left running on its old code. Fix and retry.
  echo.
  pause
  exit /b 1
)

:: -- Stop the old daemon on 5003 ------------------------------------------
:: NOTE: use netstat (fast/reliable) to find the listener PID. Get-NetTCPConnection
:: is backed by CIM/WMI and can hang for minutes on Windows 11 when that service is
:: busy -- it stalled this script before, leaving the old daemon running.
echo  [2/3] Stopping daemon on port 5003...
PowerShell -NoProfile -Command "$ls = netstat -ano | Select-String ':5003\s' | Where-Object { $_ -match 'LISTENING' }; $procIds = $ls | ForEach-Object { ($_.ToString().Trim() -split '\s+')[-1] } | Sort-Object -Unique; if ($procIds) { foreach ($p in $procIds) { Stop-Process -Id $p -Force -ErrorAction SilentlyContinue; Write-Host ('  Daemon stopped (PID ' + $p + ').') } } else { Write-Host '  Daemon was not running.' }"
timeout /t 2 /nobreak >nul

:: -- Start a fresh daemon window ------------------------------------------
echo  [3/3] Starting daemon on port 5003...
start "Kubera Daemon [5003]" cmd /k "cd /d "%~dp0" && node daemon\dist\index.js || (echo. & echo [DAEMON CRASHED -- check error above] & pause)"

echo.
echo  =====================================================
echo    Daemon restarted. UI auto-reconnects.
echo    Daemon : http://localhost:5003/api/state
echo    UI     : http://localhost:5004  (unchanged)
echo  =====================================================
echo.
timeout /t 3 /nobreak >nul
exit /b 0
