Write-Host ""
Write-Host "====================================="
Write-Host " Restarting Aura Virtual Camera"
Write-Host "====================================="
Write-Host ""

#
# Stop Windows Camera
#
Get-Process WindowsCamera -ErrorAction SilentlyContinue |
    Stop-Process -Force

#
# Stop VCamSample
#
Get-Process VCamSample -ErrorAction SilentlyContinue |
    Stop-Process -Force

Start-Sleep -Milliseconds 500

#
# Register the DLL
#
Push-Location "C:\Projects\aura\native\external\VCamSample\x64\Debug"

Write-Host "Registering VCamSampleSource.dll..."

Start-Process regsvr32 `
    -ArgumentList "/s VCamSampleSource.dll" `
    -Verb RunAs `
    -Wait

Write-Host "Registration complete."

#
# Start VCamSample
#
Write-Host "Starting VCamSample..."

Start-Process ".\VCamSample.exe"

Pop-Location

Write-Host ""
Write-Host "Done."