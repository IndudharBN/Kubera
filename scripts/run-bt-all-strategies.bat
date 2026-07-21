@echo off
set BT_ALL_STRATEGIES=true
node "%~dp0..\daemon\dist\backtest\btNse.js"
