@echo off
chcp 65001 >nul
title NovelForge
cd /d "%~dp0"

echo.
echo   ==============================================
echo      NovelForge  -  AI Novel Writing Studio
echo   ==============================================
echo.
echo   Starting up. Browser opens automatically in ~12s.
echo   Keep this window open while writing.
echo   Close this window to stop the service.
echo.

REM Open the browser only after the servers are ready.
start "" /b powershell -NoProfile -WindowStyle Hidden -Command "Start-Sleep -Seconds 12; Start-Process 'http://127.0.0.1:5173'"

node scripts\dev.mjs

echo.
echo   Service stopped.
pause >nul
