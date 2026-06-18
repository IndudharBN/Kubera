@echo off
:: ============================================================================
::  Kubera -- Full Restart (Daemon + Dashboard)
::  Rebuilds and restarts the daemon (5003) in a visible window, restarts the
::  pm2 UI (5004), and opens the dashboard in the browser. Use this for a clean
::  slate; use RESTART_DAEMON.bat when the UI is fine and only the engine needs
::  a restart.
:: ============================================================================
title Kubera -- Full Restart
cls
echo.
echo  =====================================================
echo    Kubera  ^|  Full Restart (Daemon + Dashboard)
echo  =====================================================
echo.
cd /d "%~dp0"

:: -- Build first; if it fails, leave everything as-is ---------------------
echo  [1/4] Building daemon (tsc)...
call npm run build:daemon
if errorlevel 1 (
  echo.
  echo  [BUILD FAILED] -- daemon and UI left as-is. Fix and retry.
  echo.
  pause
  exit /b 1
)

:: -- Stop the old daemon on 5003 (UI is pm2-managed; pm2 restarts it) ------
:: NOTE: netstat instead of Get-NetTCPConnection -- the latter is CIM/WMI-backed
:: and can hang for minutes on Windows 11, stalling the restart.
echo  [2/4] Stopping daemon on port 5003...
PowerShell -NoProfile -Command "$ls = netstat -ano | Select-String ':5003\s' | Where-Object { $_ -match 'LISTENING' }; $procIds = $ls | ForEach-Object { ($_.ToString().Trim() -split '\s+')[-1] } | Sort-Object -Unique; if ($procIds) { foreach ($p in $procIds) { Stop-Process -Id $p -Force -ErrorAction SilentlyContinue; Write-Host ('  Daemon stopped (PID ' + $p + ').') } } else { Write-Host '  Daemon was not running.' }"
timeout /t 2 /nobreak >nul

:: -- Start a fresh daemon window ------------------------------------------
echo  [3/4] Starting daemon on port 5003...
start "Kubera Daemon [5003]" cmd /k "cd /d "%~dp0" && node daemon\dist\index.js || (echo. & echo [DAEMON CRASHED -- check error above] & pause)"
timeout /t 5 /nobreak >nul

:: -- Restart the UI via pm2 (start it if pm2 has no entry yet) -------------
echo  [4/4] Restarting UI (pm2) on port 5004...
call pm2 restart kubera-ui
if errorlevel 1 (
  call pm2 start npm --name kubera-ui -- run dev
)

timeout /t 3 /nobreak >nul
start "" "http://localhost:5004"
echo.
echo  =====================================================
echo    Daemon : http://localhost:5003/api/state
echo    UI     : http://localhost:5004
echo  =====================================================
echo.
echo  Both are running. You can close this window.
echo.
pause
exit /b 0
