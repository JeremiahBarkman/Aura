<#
    Aura diagnostics - read-only.

    Changes nothing. Prints what Aura will actually see at launch, so we can
    tell whether a service is genuinely missing or merely misconfigured.

    Run:  powershell -NoProfile -ExecutionPolicy Bypass -File Aura-Diagnose.ps1
    Then send the whole output back.
#>

$ErrorActionPreference = 'Continue'

function Line { param([string]$T) Write-Host $T }
function Head { param([string]$T) Write-Host ''; Write-Host ('=== ' + $T + ' ===') }
function KV   { param([string]$K,[string]$V) Write-Host ('  {0,-22} {1}' -f $K, $V) }

Line 'Aura diagnostics'
Line ('Generated: {0}' -f (Get-Date))

# --- where Aura reads config from -------------------------------------------
# Packaged Aura loads .env from app.getPath('userData') = %APPDATA%\Aura.
$envPath = Join-Path $env:APPDATA 'Aura\.env'

Head '.env'
KV 'Path' $envPath
KV 'Exists' (Test-Path -LiteralPath $envPath)

$cfg = @{}
if (Test-Path -LiteralPath $envPath) {
    foreach ($l in Get-Content -LiteralPath $envPath) {
        $t = $l.Trim()
        if (-not $t -or $t.StartsWith('#') -or ($t -notmatch '=')) { continue }
        $i = $t.IndexOf('=')
        $cfg[$t.Substring(0, $i).Trim()] = $t.Substring($i + 1).Trim()
    }
    KV 'Keys present' $cfg.Count
}

# Secrets are never printed - only whether they are filled in.
Head 'Config values Aura will use'
foreach ($k in @('COMFYUI_AUTOSTART','COMFYUI_WORKING_DIR','COMFYUI_PYTHON','COMFYUI_OUTPUT_DIR',
                 'SPEECH_PYTHON','SPEECH_SCRIPT','OLLAMA_MODEL','OLLAMA_EMBED_MODEL',
                 'COMFYUI_URL','WHISPER_URL','OLLAMA_URL')) {
    $v = $cfg[$k]
    if ([string]::IsNullOrWhiteSpace($v)) { KV $k '<<< EMPTY / MISSING >>>' } else { KV $k $v }
}
foreach ($k in @('SERPAPI_KEY')) {
    KV $k $(if ([string]::IsNullOrWhiteSpace($cfg[$k])) { '<<< EMPTY >>>' } else { '(filled in)' })
}

# --- do the configured paths actually exist? --------------------------------
Head 'Do those paths exist on disk?'
foreach ($k in @('COMFYUI_WORKING_DIR','COMFYUI_PYTHON','SPEECH_PYTHON','SPEECH_SCRIPT')) {
    $v = $cfg[$k]
    if ([string]::IsNullOrWhiteSpace($v)) { KV $k 'not set - cannot check'; continue }
    KV $k $(if (Test-Path -LiteralPath $v) { 'OK - exists' } else { 'MISSING ON DISK' })
}
if ($cfg['COMFYUI_WORKING_DIR']) {
    $mp = Join-Path $cfg['COMFYUI_WORKING_DIR'] 'main.py'
    KV 'ComfyUI main.py' $(if (Test-Path -LiteralPath $mp) { 'OK' } else { 'MISSING' })
    $ck = Join-Path $cfg['COMFYUI_WORKING_DIR'] 'models\checkpoints\sdxl_lightning_4step.safetensors'
    if (Test-Path -LiteralPath $ck) {
        KV 'SDXL checkpoint' ('OK - {0:N2} GB' -f ((Get-Item -LiteralPath $ck).Length / 1GB))
    } else { KV 'SDXL checkpoint' 'MISSING' }
}

# --- is anything listening right now? ---------------------------------------
Head 'Ports (are the services up?)'
foreach ($p in @(@{N='ComfyUI';P=8188}, @{N='Whisper/speech';P=8765}, @{N='Ollama';P=11434}, @{N='Aura server';P=5150})) {
    $up = $false
    try {
        $c = New-Object Net.Sockets.TcpClient
        $up = $c.ConnectAsync('127.0.0.1', $p.P).Wait(1200)
        $c.Close()
    } catch {}
    KV ('{0} :{1}' -f $p.N, $p.P) $(if ($up) { 'LISTENING' } else { 'not listening' })
}

# --- try starting the two failing services by hand --------------------------
# This is the payload: it surfaces the real error message Aura swallows.
Head 'Speech service - direct launch test'
$sp = $cfg['SPEECH_PYTHON']; $ss = $cfg['SPEECH_SCRIPT']
if ((-not $sp) -or (-not $ss)) {
    Line '  SKIPPED - SPEECH_PYTHON / SPEECH_SCRIPT not set in .env.'
    Line '  This alone stops Aura from starting Whisper.'
} elseif (-not (Test-Path -LiteralPath $sp)) {
    Line ('  SKIPPED - python not found at ' + $sp)
} else {
    Line ('  Running: {0} {1}' -f $sp, $ss)
    Line '  (5 second smoke test, output below)'

    # Apply the SAME environment Aura would. Without this the test is a lie:
    # Aura loads .env, so the service sees WHISPER_MODEL="" (present but
    # empty), while a bare launch sees it absent and quietly defaults to
    # "base". That difference is exactly what made this test report
    # "looks healthy" while the real service died on startup.
    $savedEnv = @{}
    foreach ($k in @('WHISPER_MODEL','WHISPER_DEVICE','WHISPER_COMPUTE_TYPE')) {
        $savedEnv[$k] = [Environment]::GetEnvironmentVariable($k)
        if ($cfg.ContainsKey($k)) {
            [Environment]::SetEnvironmentVariable($k, $cfg[$k])
            Line ("  env: {0}={1}" -f $k, $(if ($cfg[$k]) { $cfg[$k] } else { '(empty - as Aura sets it)' }))
        }
    }

    $errFile = Join-Path $env:TEMP 'aura-diag-speech.txt'
    $proc = Start-Process -FilePath $sp -ArgumentList @($ss) -PassThru -NoNewWindow `
                          -RedirectStandardError $errFile -RedirectStandardOutput ($errFile + '.out')
    Start-Sleep -Seconds 5
    if (-not $proc.HasExited) { Line '  -> still running after 5s (looks healthy)'; try { $proc.Kill() } catch {} }
    else { Line ('  -> EXITED with code {0}' -f $proc.ExitCode) }
    foreach ($f in @($errFile, ($errFile + '.out'))) {
        if ((Test-Path $f) -and (Get-Item $f).Length -gt 0) {
            Line ('  --- ' + (Split-Path -Leaf $f) + ' ---')
            Get-Content $f -Tail 25 | ForEach-Object { Line ('    ' + $_) }
        }
    }

    foreach ($k in $savedEnv.Keys) { [Environment]::SetEnvironmentVariable($k, $savedEnv[$k]) }
}

Head 'ComfyUI - direct launch test'
$cp = $cfg['COMFYUI_PYTHON']; $cw = $cfg['COMFYUI_WORKING_DIR']

# If Aura already has ComfyUI up, a second copy cannot bind 8188 and will
# exit on a port/database-lock error that looks like a failure but is really
# proof it is ALREADY WORKING. Don't run a test whose failure means success.
$comfyAlreadyUp = $false
try {
    $c = New-Object Net.Sockets.TcpClient
    $comfyAlreadyUp = $c.ConnectAsync('127.0.0.1', 8188).Wait(1200)
    $c.Close()
} catch {}

if ($comfyAlreadyUp) {
    Line '  SKIPPED - ComfyUI is already running and healthy on 8188'
    Line '  (starting a second copy would fail on "port in use" / database lock,'
    Line '   which would look like a problem but is not one).'
} elseif ((-not $cp) -or (-not $cw)) {
    Line '  SKIPPED - COMFYUI_PYTHON / COMFYUI_WORKING_DIR not set in .env.'
} elseif (-not (Test-Path -LiteralPath $cp)) {
    Line ('  SKIPPED - python not found at ' + $cp)
} else {
    Line ('  Running: {0} main.py  (cwd {1})' -f $cp, $cw)
    Line '  (12 second smoke test, output below)'
    $errFile = Join-Path $env:TEMP 'aura-diag-comfy.txt'
    $proc = Start-Process -FilePath $cp -ArgumentList @('main.py') -WorkingDirectory $cw -PassThru -NoNewWindow `
                          -RedirectStandardError $errFile -RedirectStandardOutput ($errFile + '.out')
    Start-Sleep -Seconds 12
    if (-not $proc.HasExited) { Line '  -> still running after 12s (looks healthy)'; try { $proc.Kill() } catch {} }
    else { Line ('  -> EXITED with code {0}' -f $proc.ExitCode) }
    foreach ($f in @($errFile, ($errFile + '.out'))) {
        if ((Test-Path $f) -and (Get-Item $f).Length -gt 0) {
            Line ('  --- ' + (Split-Path -Leaf $f) + ' ---')
            Get-Content $f -Tail 30 | ForEach-Object { Line ('    ' + $_) }
        }
    }
}

# --- Aura's own service logs ------------------------------------------------
# These say WHY a service failed to start, which nothing else can tell us:
# a packaged app has no console for the child's output to go to.
Head 'Aura service logs'
$logDir = Join-Path $env:APPDATA 'Aura\logs'
KV 'Log folder' $logDir
if (-not (Test-Path -LiteralPath $logDir)) {
    Line '  No logs yet. (Present from Aura 1.4.5 onward - if this is an older'
    Line '   build, that is expected and there is nothing to read.)'
} else {
    $logs = @(Get-ChildItem -LiteralPath $logDir -Filter *.log -ErrorAction SilentlyContinue)
    if (-not $logs.Count) { Line '  (folder exists but is empty)' }
    foreach ($lg in $logs) {
        Line ''
        Line ("  --- {0}  ({1:N0} bytes, modified {2}) ---" -f $lg.Name, $lg.Length, $lg.LastWriteTime)
        Get-Content -LiteralPath $lg.FullName -Tail 30 -ErrorAction SilentlyContinue |
            ForEach-Object { Line ('    ' + $_) }
    }
}

# --- leftovers from earlier attempts ----------------------------------------
Head 'Stray processes from earlier runs'
foreach ($n in @('python','ollama','node','Aura')) {
    $ps = @(Get-Process -Name $n -ErrorAction SilentlyContinue)
    if ($ps.Count) { KV $n ('{0} running (pids: {1})' -f $ps.Count, (($ps | Select-Object -First 8).Id -join ', ')) }
}

Head 'Installed pieces'
KV 'Ollama'   $(if (Get-Command ollama  -ErrorAction SilentlyContinue) { 'on PATH' } else { 'not on PATH' })
KV 'Python'   $(if (Get-Command python  -ErrorAction SilentlyContinue) { 'on PATH' } else { 'not on PATH' })
KV 'ffprobe'  $(if (Get-Command ffprobe -ErrorAction SilentlyContinue) { 'on PATH' } else { 'not on PATH' })
KV 'Speech venv'     (Test-Path (Join-Path $env:LOCALAPPDATA 'Aura\speech-venv\Scripts\python.exe'))
KV 'Installer cache' (Test-Path (Join-Path $env:LOCALAPPDATA 'Aura\installer-cache'))

Write-Host ''
Write-Host 'Done. Please send this entire output back.'
Write-Host ''
