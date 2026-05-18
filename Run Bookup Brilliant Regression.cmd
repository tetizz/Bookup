@echo off
setlocal
cd /d "%~dp0"
pwsh -ExecutionPolicy Bypass -File "scripts\run_full_brilliant_regression.ps1" %*
echo.
pause
