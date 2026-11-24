@echo off
rem Double-click on Windows to start the Sky Remote.
cd /d "%~dp0"
where node >nul 2>nul || (echo Node.js is needed. Install it from https://nodejs.org then run this again. & pause & exit /b 1)
start "" http://localhost:8049
node server.js
pause
