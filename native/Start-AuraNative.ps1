# -----------------------------------------------------------------------------
# Start-AuraNative.ps1
# -----------------------------------------------------------------------------

$AuraRoot = "C:\Projects\aura"

$FrameBridgeExe = "$AuraRoot\native\AuraFrameBridge\AuraFrameBridge\x64\Debug\AuraFrameBridge.exe"
$VCamSampleExe  = "$AuraRoot\native\external\VCamSample\x64\Debug\VCamSample.exe"

Write-Host "Starting Aura Native Development Stack..." -ForegroundColor Cyan

# ---------------------------------------------------------------------
# Stop previous instances
# ---------------------------------------------------------------------

Get-Process AuraFrameBridge -ErrorAction SilentlyContinue | Stop-Process -Force
Get-Process VCamSample      -ErrorAction SilentlyContinue | Stop-Process -Force

Start-Sleep -Milliseconds 500

# ---------------------------------------------------------------------
# Validate files
# ---------------------------------------------------------------------

if (!(Test-Path $FrameBridgeExe))
{
    Write-Host "AuraFrameBridge.exe not found." -ForegroundColor Red
    exit 1
}

if (!(Test-Path $VCamSampleExe))
{
    Write-Host "VCamSample.exe not found." -ForegroundColor Red
    exit 1
}

# ---------------------------------------------------------------------
# Launch bridge
# ---------------------------------------------------------------------

Write-Host "Launching AuraFrameBridge..." -ForegroundColor Green

Start-Process powershell `
    -ArgumentList "-NoExit","-Command","`"$FrameBridgeExe`""

Start-Sleep -Seconds 2

# ---------------------------------------------------------------------
# Launch camera host
# ---------------------------------------------------------------------

Write-Host "Launching VCamSample..." -ForegroundColor Green

Start-Process powershell `
    -ArgumentList "-NoExit","-Command","cd `"$AuraRoot\native\external\VCamSample\x64\Debug`"; .\VCamSample.exe"

Start-Sleep -Seconds 2

# ---------------------------------------------------------------------
# Launch Camera
# ---------------------------------------------------------------------

Write-Host "Opening Windows Camera..." -ForegroundColor Green

Start-Process "microsoft.windows.camera:"

Write-Host ""
Write-Host "Aura Native stack ready." -ForegroundColor Cyan