@echo off
title Aura Diagnostics
rem Read-only. Prints what Aura actually sees, and tries to start the two
rem services by hand so their real error messages are visible.
rem
rem Output goes to the DESKTOP, not this folder - writing it here would mean
rem the report gets bundled into the next copy of the package we send out.
set "REPORT=%USERPROFILE%\Desktop\aura-diagnostics.txt"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0Aura-Diagnose.ps1" > "%REPORT%" 2>&1
type "%REPORT%"
echo.
echo ------------------------------------------------------------------
echo Saved to your Desktop as: aura-diagnostics.txt
echo Please send that file back.
echo ------------------------------------------------------------------
pause
