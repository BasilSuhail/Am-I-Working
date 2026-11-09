@echo off
rem Double-click to start Am I Working on Windows. Close this window to stop it.
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed. Get it free at https://nodejs.org ^(click the big LTS button^), then double-click this file again.
  pause
  exit /b 1
)
start "" "http://127.0.0.1:8788"
node app\server.js
