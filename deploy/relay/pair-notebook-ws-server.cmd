@echo off
start "Pair Notebook WebSocket server" /b powershell.exe -NoProfile -STA -WindowStyle Hidden -ExecutionPolicy Bypass -File "%~dp0pair-notebook-ws-server.ps1"
