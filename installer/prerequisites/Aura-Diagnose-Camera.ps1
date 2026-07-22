<#
    Aura virtual-camera pipeline diagnostic.  READ-ONLY.

    RUN THIS WHILE AURA IS RUNNING AND THE CAMERA IS STARTED,
    ideally with a consuming app (Teams/Zoom/OBS) open on "Aura Camera".

    The pipeline has four links:

        Aura renderer  --TCP 5151-->  AuraFrameBridge.exe  -->  VCamSample.exe  -->  other apps

    A black image means one link is passing nothing. This finds which one.
#>

function Head { param([string]$T) Write-Host ''; Write-Host ('=== ' + $T + ' ===') }
function KV   { param([string]$K,[string]$V) Write-Host ('  {0,-26} {1}' -f $K, $V) }

Write-Host 'Aura virtual-camera pipeline diagnostic'
Write-Host ('Generated: {0}' -f (Get-Date))

# --- LINK 0: is Aura even up? -----------------------------------------------
Head 'LINK 0 - Aura itself'
$aura = @(Get-Process -Name 'Aura','electron' -ErrorAction SilentlyContinue)
if ($aura.Count) {
    foreach ($p in $aura) { KV $p.ProcessName ('pid {0}' -f $p.Id) }
} else {
    Write-Host '  Aura is NOT running.'
    Write-Host '  >> Start Aura and START THE CAMERA, then run this again.'
}

# --- LINK 1: the bridge ------------------------------------------------------
Head 'LINK 1 - AuraFrameBridge.exe (receives frames from Aura)'
$bridge = @(Get-Process -Name 'AuraFrameBridge' -ErrorAction SilentlyContinue)
if ($bridge.Count) {
    foreach ($p in $bridge) { KV 'running' ('pid {0}' -f $p.Id) }
} else {
    KV 'running' 'NO  <<< bridge is not running - camera output cannot work'
}

$listen = @(Get-NetTCPConnection -LocalPort 5151 -State Listen -ErrorAction SilentlyContinue)
KV 'listening on :5151' $(if ($listen.Count) { 'YES' } else { 'NO  <<< nothing is accepting frames' })

# The important one: is Aura actually CONNECTED and pushing frames?
$estab = @(Get-NetTCPConnection -LocalPort 5151 -State Established -ErrorAction SilentlyContinue)
$estab += @(Get-NetTCPConnection -RemotePort 5151 -State Established -ErrorAction SilentlyContinue)
$estab = $estab | Sort-Object -Property LocalPort,RemotePort -Unique
KV 'Aura connected to bridge' $(if ($estab.Count) { ('YES ({0} connection(s))' -f $estab.Count) } else { 'NO  <<< Aura is not sending any frames' })

# --- LINK 2: the camera host -------------------------------------------------
Head 'LINK 2 - VCamSample.exe (presents the camera to other apps)'
$host2 = @(Get-Process -Name 'VCamSample' -ErrorAction SilentlyContinue)
if ($host2.Count) {
    foreach ($p in $host2) { KV 'running' ('pid {0}' -f $p.Id) }
} else {
    KV 'running' 'NO  <<< no camera host - apps see nothing or a stale device'
}

# --- LINK 3: does Windows expose the camera? --------------------------------
Head 'LINK 3 - Cameras Windows can see right now'
Get-PnpDevice -Class Camera,Image,MEDIA -ErrorAction SilentlyContinue |
    Select-Object Status, FriendlyName |
    Format-Table -AutoSize | Out-String | Write-Host

Write-Host '  (If "Aura Camera" is absent while Aura is running with the camera on,'
Write-Host '   the virtual camera was never registered / the host is not creating it.)'

Head 'Frame Server (Windows service virtual cameras depend on)'
Get-Service -Name FrameServer, FrameServerMonitor -ErrorAction SilentlyContinue |
    Select-Object Name, Status, StartType | Format-Table -AutoSize | Out-String | Write-Host

Head 'Other virtual cameras installed (possible conflict)'
$known = 'ChromaCam|OBS|ManyCam|Snap|XSplit|NVIDIA Broadcast|Logi'
Get-PnpDevice -Class Camera,Image,MEDIA -ErrorAction SilentlyContinue |
    Where-Object { $_.FriendlyName -match $known } |
    Select-Object Status, FriendlyName | Format-Table -AutoSize | Out-String | Write-Host

# --- Verdict -----------------------------------------------------------------
Head 'VERDICT'
if (-not $aura.Count) {
    Write-Host '  Aura was not running - rerun with Aura open and the camera started.'
} elseif (-not $bridge.Count) {
    Write-Host '  BRIDGE NOT RUNNING. Aura never launched AuraFrameBridge.exe,'
    Write-Host '  so nothing can reach the virtual camera. Check Aura''s console.'
} elseif (-not $estab.Count) {
    Write-Host '  BRIDGE RUNNING BUT NO CONNECTION FROM AURA.'
    Write-Host '  The renderer is not exporting frames. In Aura''s DevTools console'
    Write-Host '  look for "Aura frame export" messages - if absent, export never'
    Write-Host '  started; if present with warnings, the pipe is rejecting frames.'
} elseif (-not $host2.Count) {
    Write-Host '  FRAMES ARE FLOWING TO THE BRIDGE, BUT THE CAMERA HOST IS NOT RUNNING.'
    Write-Host '  VCamSample.exe is what other apps actually read from - if apps still'
    Write-Host '  show an "Aura Camera", it is a stale registration serving black.'
} else {
    Write-Host '  All four links are present. If output is still black, the frames'
    Write-Host '  are arriving but not being rendered - suspect a pixel-format or'
    Write-Host '  resolution mismatch between Aura and the camera host.'
}
Write-Host ''
