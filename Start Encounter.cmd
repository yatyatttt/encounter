@echo off
setlocal
cd /d "%~dp0"
title Encounter
if not exist "runtime\node.exe" (
    echo Extract the complete Encounter-Windows-x64.zip before starting Encounter.
    pause
    exit /b 1
)
echo Keep this window open while using Encounter.
echo Press Ctrl+C to stop.
echo.
"runtime\node.exe" --import tsx src/server/index.ts --open-browser
if errorlevel 1 pause
