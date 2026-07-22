@echo off
title Aura Prerequisites Setup
rem Launches the Aura prerequisites wizard. -STA is required for the WinForms UI.
powershell -NoProfile -ExecutionPolicy Bypass -STA -File "%~dp0Aura-Prerequisites.ps1"
if errorlevel 1 (
  echo.
  echo The prerequisites wizard exited with an error. See the message above.
  pause
)
