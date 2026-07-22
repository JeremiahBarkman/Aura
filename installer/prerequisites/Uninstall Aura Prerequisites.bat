@echo off
title Uninstall Aura Prerequisites
echo.
echo  This removes what the Aura prerequisites wizard installed
echo  (speech service, ComfyUI, Ollama, config) so you can start clean.
echo.
echo  Everything it removes goes to the RECYCLE BIN.
echo  Shared tools (Python, FFmpeg) are kept by default.
echo.
echo  Showing what WOULD be removed first - nothing is deleted yet.
echo.
pause
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0Aura-Uninstall-Prerequisites.ps1" -WhatIf -Yes
echo.
echo ==================================================================
echo  The list above is a PREVIEW. Nothing has been removed yet.
echo  To actually remove it, continue and type YES when prompted.
echo  To stop here, just close this window.
echo ==================================================================
echo.
pause
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0Aura-Uninstall-Prerequisites.ps1"
echo.
pause
