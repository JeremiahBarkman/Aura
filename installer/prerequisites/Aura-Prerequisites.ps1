#Requires -Version 5.1
<#
    Aura Prerequisites Setup
    ------------------------------------------------------------------------
    A standalone wizard for TESTERS. It checks for the external software Aura
    depends on, helps install what's missing, sets up the local speech
    service, and writes Aura's .env configuration file.

    This is NOT the Aura application installer. Install the Aura app itself
    separately (Aura Installer vx.y.z.exe). This tool only prepares prerequisites.

    Usage:
      Double-click "Install Aura Prerequisites.bat", OR
      powershell -ExecutionPolicy Bypass -File Aura-Prerequisites.ps1
      powershell ... Aura-Prerequisites.ps1 -Check    (console status only)
#>
[CmdletBinding()]
param(
    [switch]$Check
)

# Windows PowerShell 5.1 renders a progress bar for every web call, and that
# rendering costs far more than the transfer itself on large downloads. The
# wizard draws its own progress in the status banner instead.
$ProgressPreference = 'SilentlyContinue'

# TLS 1.2 for downloads on older Windows builds.
try {
    [Net.ServicePointManager]::SecurityProtocol =
        [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
} catch {}

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------
$script:UserDataDir  = Join-Path $env:APPDATA 'aura'
$script:EnvPath      = Join-Path $script:UserDataDir '.env'
$script:SpeechRoot   = Join-Path $env:LOCALAPPDATA 'Aura\speech'
$script:SpeechVenv   = Join-Path $env:LOCALAPPDATA 'Aura\speech-venv'
$script:SpeechScript = Join-Path $script:SpeechRoot 'speech_server.py'
$script:VenvPython   = Join-Path $script:SpeechVenv 'Scripts\python.exe'
$script:EmbedModel   = 'nomic-embed-text'
$script:OllamaUrl    = 'http://127.0.0.1:11434'
$script:ComfyUrl     = 'http://127.0.0.1:8188'
$script:WhisperUrl   = 'http://127.0.0.1:8765'
$script:AuraPort     = '5150'

$script:ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$script:BundledSpeechScript = Join-Path $script:ScriptDir 'speech_server.py'

$script:OllamaSetupUrl = 'https://ollama.com/download/OllamaSetup.exe'
$script:ComfyReleasesUrl = 'https://github.com/comfyanonymous/ComfyUI/releases'
$script:CheckpointPageUrl = 'https://huggingface.co/ByteDance/SDXL-Lightning'
$script:CheckpointName = 'sdxl_lightning_4step.safetensors'
# Direct file URL so the wizard can fetch it straight into ComfyUI's
# checkpoints folder. The repo also hosts *_unet and *_lora variants with
# very similar names that will NOT work as a checkpoint - picking the wrong
# one by hand was an easy and confusing mistake to make.
$script:CheckpointUrl = 'https://huggingface.co/ByteDance/SDXL-Lightning/resolve/main/sdxl_lightning_4step.safetensors'

$script:LogBox = $null  # set when GUI is up

# ---------------------------------------------------------------------------
# Small helpers
# ---------------------------------------------------------------------------
function Write-Log {
    param([string]$Message)
    $line = ('{0}  {1}' -f (Get-Date -Format 'HH:mm:ss'), $Message)
    if ($script:LogBox) {
        $script:LogBox.AppendText($line + "`r`n")
        try { [System.Windows.Forms.Application]::DoEvents() } catch {}
    } else {
        Write-Host $line
    }
}

# Big, always-visible status line at the top of the wizard. No-op in -Check
# mode. Also echoed to the log so there's a history.
$script:StatusBanner = $null
function Set-Status {
    # -NoLog is for high-frequency updates (download progress ticks), which
    # would otherwise bury the log in hundreds of near-identical lines.
    param(
        [string]$Message,
        [ValidateSet('info','working','done','warn')][string]$Kind = 'info',
        [switch]$NoLog
    )
    if ($script:StatusBanner) {
        $script:StatusBanner.Text = $Message
        $script:StatusBanner.ForeColor = switch ($Kind) {
            'working' { [System.Drawing.Color]::FromArgb(30, 90, 200) }
            'done'    { [System.Drawing.Color]::FromArgb(20, 130, 40) }
            'warn'    { [System.Drawing.Color]::FromArgb(170, 110, 0) }
            default   { [System.Drawing.Color]::FromArgb(60, 60, 60) }
        }
        try { [System.Windows.Forms.Application]::DoEvents() } catch {}
    }
    if (-not $NoLog) { Write-Log $Message }
}

function Test-CommandExists {
    param([string]$Name)
    [bool](Get-Command $Name -ErrorAction SilentlyContinue)
}

function Test-HttpUp {
    param([string]$Url, [int]$TimeoutSec = 3)
    try {
        Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec $TimeoutSec -ErrorAction Stop | Out-Null
        return $true
    } catch {
        # A 4xx/5xx still proves something is listening on that port.
        if ($_.Exception.Response) { return $true }
        return $false
    }
}

function Test-IsAdmin {
    try {
        $id = [Security.Principal.WindowsIdentity]::GetCurrent()
        (New-Object Security.Principal.WindowsPrincipal($id)).IsInRole(
            [Security.Principal.WindowsBuiltInRole]::Administrator)
    } catch { $false }
}

function Get-OllamaModels {
    try {
        $resp = Invoke-RestMethod -Uri ('{0}/api/tags' -f $script:OllamaUrl) -TimeoutSec 4 -ErrorAction Stop
        if ($resp.models) { return @($resp.models.name) }
        return @()
    } catch {
        # Fall back to the CLI if the server isn't answering HTTP yet.
        if (Test-CommandExists 'ollama') {
            try { return @((& ollama list 2>$null) | Select-Object -Skip 1 | ForEach-Object { ($_ -split '\s+')[0] } | Where-Object { $_ }) } catch {}
        }
        return @()
    }
}

# ---------------------------------------------------------------------------
# Detection  (each returns: @{ Ok=[bool]; State='ok'|'partial'|'missing'; Detail=string })
# ---------------------------------------------------------------------------
function Get-OllamaStatus {
    $running = Test-HttpUp ('{0}/api/tags' -f $script:OllamaUrl)
    $onPath  = Test-CommandExists 'ollama'
    $exe     = Join-Path $env:LOCALAPPDATA 'Programs\Ollama\ollama.exe'
    $onDisk  = Test-Path $exe
    if ($running) { return @{ Ok=$true;  State='ok';      Detail='Installed and running on port 11434. (It ships with no models - the two rows below add them.)' } }
    if ($onPath -or $onDisk) { return @{ Ok=$true; State='partial'; Detail='Installed but not currently running. Start Ollama, or Aura will start it.' } }
    return @{ Ok=$false; State='missing'; Detail='Not found. Required for summaries, prompts, and matching.' }
}

function Get-OllamaEmbedStatus {
    $models = Get-OllamaModels
    if ($models | Where-Object { $_ -like ($script:EmbedModel + '*') }) {
        return @{ Ok=$true; State='ok'; Detail=("'{0}' is pulled." -f $script:EmbedModel) }
    }
    if (-not (Get-OllamaStatus).Ok) {
        return @{ Ok=$false; State='missing'; Detail='Install Ollama first, then pull this model.' }
    }
    return @{ Ok=$false; State='missing'; Detail=("'{0}' not pulled (~275 MB). Enables semantic matching." -f $script:EmbedModel) }
}

function Get-OllamaTextModelStatus {
    $models = @(Get-OllamaModels | Where-Object { $_ -notlike ($script:EmbedModel + '*') })

    if ($models.Count -gt 0) {
        # Having a model is only half the job: Aura reads OLLAMA_MODEL to know
        # WHICH one to use. Left blank it falls back to a large developer
        # model that no tester has, and every LLM feature fails with a
        # "model not found" that points nowhere near the real cause.
        $configured = Get-ConfigValue 'OLLAMA_MODEL'

        if (-not $configured) {
            return @{ Ok=$false; State='partial'; Detail=('Installed: {0} - but Aura has not been told which to use. Click "Choose + download" to pick one.' -f ($models -join ', ')) }
        }

        # Tolerate the ":latest" suffix Ollama adds when it is omitted.
        $match = $models | Where-Object { $_ -eq $configured -or $_ -eq ($configured + ':latest') -or ($_ -replace ':latest$','') -eq $configured }

        if (-not $match) {
            return @{ Ok=$false; State='partial'; Detail=('Aura is set to "{0}", which is not installed. Installed: {1}' -f $configured, ($models -join ', ')) }
        }

        return @{ Ok=$true; State='ok'; Detail=('Using "{0}".' -f $configured) }
    }
    if (-not (Get-OllamaStatus).Ok) {
        return @{ Ok=$false; State='missing'; Detail='Install Ollama first, then pull a text model.' }
    }
    # The single most confusing thing about a fresh Ollama: it installs with
    # NO models at all, and nothing in Ollama says so.
    return @{ Ok=$false; State='missing'; Detail='Ollama installs with no models. Aura needs one - click "Choose + download" and pick from the list.' }
}

function Get-PythonStatus {
    foreach ($cmd in @('python', 'py')) {
        $c = Get-Command $cmd -ErrorAction SilentlyContinue
        if (-not $c) { continue }
        # Skip the Microsoft Store execution-alias stub.
        if ($c.Source -and $c.Source -like '*WindowsApps*') { continue }
        try {
            $v = & $cmd --version 2>&1
            if ("$v" -match 'Python 3\.(\d+)') { return @{ Ok=$true; State='ok'; Detail=("$v".Trim()) } }
        } catch {}
    }
    return @{ Ok=$false; State='missing'; Detail='Python 3 not found. Required to run the speech service.' }
}

function Get-FfmpegStatus {
    if (Test-CommandExists 'ffprobe') {
        return @{ Ok=$true; State='ok'; Detail='ffprobe found on PATH.' }
    }
    return @{ Ok=$false; State='missing'; Detail='ffprobe not found. Used to read recorded-audio duration.' }
}

function Get-SpeechServiceStatus {
    if (Test-HttpUp ('{0}/transcribe' -f $script:WhisperUrl)) {
        return @{ Ok=$true; State='ok'; Detail='Running on port 8765.' }
    }

    # Honor the paths already configured in .env (an existing/manual setup),
    # falling back to the wizard's own default install location.
    $env = Read-DotEnv
    $py = if ($env['SPEECH_PYTHON'])  { $env['SPEECH_PYTHON'] }  else { $script:VenvPython }
    $sc = if ($env['SPEECH_SCRIPT'])  { $env['SPEECH_SCRIPT'] }  else { $script:SpeechScript }

    $venvOk   = Test-Path $py
    $scriptOk = Test-Path $sc
    $pkgsOk   = $false
    if ($venvOk) {
        try {
            & $py -c 'import flask, flask_cors, faster_whisper' 2>$null
            $pkgsOk = ($LASTEXITCODE -eq 0)
        } catch {}
    }

    if ($venvOk -and $pkgsOk -and $scriptOk) {
        # Aura reads .env, not the disk. If the venv exists but SPEECH_PYTHON
        # was never recorded, Aura falls back to a dev-only path that does not
        # exist in a packaged install and Whisper silently never starts - while
        # this row would otherwise claim everything is fine.
        if (-not $env['SPEECH_PYTHON']) {
            return @{ Ok=$false; State='partial'; Detail='Set up, but not recorded in .env yet - click "Save my keys + config" or Aura cannot start it.' }
        }
        return @{ Ok=$true; State='ok'; Detail='Set up (not running now - Aura starts it automatically).' }
    }
    if ($venvOk -or $scriptOk) {
        return @{ Ok=$false; State='partial'; Detail='Partially set up. Re-run "Set up speech service" or fix SPEECH_* in .env.' }
    }
    return @{ Ok=$false; State='missing'; Detail='Not set up. The wizard can create the venv and install packages.' }
}

function Test-ComfyInstall {
    param([string]$Dir)
    if (-not $Dir -or -not (Test-Path $Dir)) { return $false }
    # ComfyUI's entrypoint is main.py; portable builds nest it one level down.
    return ((Test-Path (Join-Path $Dir 'main.py')) -or
            (Test-Path (Join-Path $Dir 'ComfyUI\main.py')))
}

# Read a config value the way the USER sees it: whatever is currently typed in
# the wizard field wins, falling back to what is saved in .env. Detection used
# to read .env only, so paths you had just typed (or that the wizard had just
# auto-filled) were invisible until you hit Save - which made the wizard report
# "not installed" for things plainly configured on screen.
function Get-ConfigValue {
    param([string]$Key)
    if ($script:Fields -and $script:Fields[$Key]) {
        $v = $script:Fields[$Key].Text
        if (-not [string]::IsNullOrWhiteSpace($v)) { return $v.Trim() }
    }
    $saved = Read-DotEnv
    return $saved[$Key]
}

# The ComfyUI folder, normalized so it works whether the configured path points
# at the portable outer folder or the inner one that actually holds main.py.
function Get-ComfyWorkingDir {
    $wd = Get-ConfigValue 'COMFYUI_WORKING_DIR'
    if (-not $wd) { return $null }
    $r = Resolve-ComfyLayout $wd
    if ($r.WorkingDir) { return $r.WorkingDir }
    if (Test-Path $wd) { return $wd }
    return $null
}

function Get-ComfyStatus {
    if (Test-HttpUp ($script:ComfyUrl)) {
        return @{ Ok=$true; State='ok'; Detail='Running on port 8188.' }
    }
    $wd = Get-ComfyWorkingDir
    if (Test-ComfyInstall $wd) {
        # Same trap as the speech service: Aura only sees what is in .env.
        $saved = Read-DotEnv
        if (-not $saved['COMFYUI_WORKING_DIR']) {
            return @{ Ok=$false; State='partial'; Detail='Found, but not recorded in .env yet - click "Save my keys + config" or Aura cannot start it.' }
        }
        return @{ Ok=$true; State='ok'; Detail=('Installed at {0} (not running now - Aura starts it automatically).' -f $wd) }
    }
    return @{ Ok=$false; State='missing'; Detail='Not found. Click "Set up ComfyUI..." - it can locate an existing install or download one.' }
}

function Get-CheckpointStatus {
    $wd = Get-ComfyWorkingDir
    if ($wd) {
        $ckpt = Join-Path $wd ('models\checkpoints\' + $script:CheckpointName)
        if (Test-Path $ckpt) {
            $gb = 0
            try { $gb = (Get-Item -LiteralPath $ckpt).Length / 1GB } catch {}
            # A truncated/interrupted download is worse than a missing one: it
            # looks fine here but fails at image-generation time.
            if ($gb -lt 5) {
                return @{ Ok=$false; State='partial'; Detail=('{0} is only {1:N1} GB - looks like an incomplete download. Re-download it.' -f $script:CheckpointName, $gb) }
            }
            return @{ Ok=$true; State='ok'; Detail=('Checkpoint present ({0:N1} GB).' -f $gb) }
        }
        return @{ Ok=$false; State='missing'; Detail=('Not in {0}\models\checkpoints. The wizard can download it (6.5 GB).' -f $wd) }
    }
    return @{ Ok=$false; State='missing'; Detail='Set up ComfyUI first - then the wizard can download the checkpoint for you.' }
}

function Get-EnvStatus {
    if (-not (Test-Path $script:EnvPath)) {
        return @{ Ok=$false; State='missing'; Detail=('.env not created yet at {0}' -f $script:EnvPath) }
    }
    $env = Read-DotEnv
    $missing = @()
    foreach ($k in @('PSYSEG_LICENSE','PSYSEG_ACCESS_KEY','PSYSEG_ACCESS_TOKEN','SERPAPI_KEY')) {
        if (-not $env[$k]) { $missing += $k }
    }
    if ($missing.Count -gt 0) {
        return @{ Ok=$false; State='partial'; Detail=('.env exists but missing keys: {0}' -f ($missing -join ', ')) }
    }
    return @{ Ok=$true; State='ok'; Detail='.env exists with all license/API keys filled.' }
}

# ---------------------------------------------------------------------------
# Temp-file housekeeping.
#
# Everything the wizard downloads (installers, archives, extraction tools)
# lands in ONE work folder, and goes to the Recycle Bin when we're done with
# it - recoverable, rather than gone. Leftovers from an earlier run (e.g. the
# wizard was closed mid-install) are swept on the next startup.
# ---------------------------------------------------------------------------
$script:WorkDir = Join-Path $env:LOCALAPPDATA 'Aura\installer-cache'

function Get-WorkDir {
    if (-not (Test-Path -LiteralPath $script:WorkDir)) {
        New-Item -ItemType Directory -Force -Path $script:WorkDir | Out-Null
    }
    return $script:WorkDir
}

function Remove-ToRecycleBin {
    param([string]$Path)
    if (-not $Path -or -not (Test-Path -LiteralPath $Path)) { return $false }
    try {
        Add-Type -AssemblyName Microsoft.VisualBasic -ErrorAction SilentlyContinue
        $full = (Resolve-Path -LiteralPath $Path).Path
        if (Test-Path -LiteralPath $full -PathType Container) {
            [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory(
                $full,
                [Microsoft.VisualBasic.FileIO.UIOption]::OnlyErrorDialogs,
                [Microsoft.VisualBasic.FileIO.RecycleOption]::SendToRecycleBin)
        } else {
            [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile(
                $full,
                [Microsoft.VisualBasic.FileIO.UIOption]::OnlyErrorDialogs,
                [Microsoft.VisualBasic.FileIO.RecycleOption]::SendToRecycleBin)
        }
        return $true
    } catch {
        # Never leave clutter behind just because the Recycle Bin refused
        # (network drives and very large files bypass it).
        try { Remove-Item -LiteralPath $Path -Recurse -Force -ErrorAction Stop; return $true }
        catch { return $false }
    }
}

# Sweep the work folder. Files still in use (an installer the user is running
# right now) simply fail to delete and get picked up on the next sweep.
function Clear-WorkDir {
    param([switch]$Quiet)
    if (-not (Test-Path -LiteralPath $script:WorkDir)) { return }
    $items = @(Get-ChildItem -LiteralPath $script:WorkDir -Force -ErrorAction SilentlyContinue)
    if ($items.Count -eq 0) { return }

    $freed = 0L
    $removed = 0
    foreach ($i in $items) {
        $size = 0L
        try {
            $size = if ($i.PSIsContainer) {
                (Get-ChildItem -LiteralPath $i.FullName -Recurse -Force -File -ErrorAction SilentlyContinue |
                 Measure-Object -Property Length -Sum).Sum
            } else { $i.Length }
        } catch {}
        if (Remove-ToRecycleBin $i.FullName) {
            $removed++
            if ($size) { $freed += $size }
        }
    }
    if ($removed -gt 0 -and -not $Quiet) {
        Write-Log ('Cleaned up {0} temporary install file(s), {1:N2} GB, to the Recycle Bin.' -f $removed, ($freed/1GB))
    }
}

# ---------------------------------------------------------------------------
# Actions
# ---------------------------------------------------------------------------
function Invoke-WingetInstall {
    param([string]$Id, [string]$FriendlyName)
    if (-not (Test-CommandExists 'winget')) {
        Set-Status ("winget isn't available, so {0} can't be auto-installed. See the README for a manual link." -f $FriendlyName) 'warn'
        return $false
    }
    Set-Status ("Installing {0} - a console window will show progress. Please wait, and approve any Windows permission prompt..." -f $FriendlyName) 'working'
    try {
        # Visible window (NOT hidden) so the user can see it working and isn't
        # left staring at a frozen wizard.
        $p = Start-Process -FilePath 'winget' -ArgumentList @(
            'install','--id',$Id,'-e','--source','winget',
            '--accept-package-agreements','--accept-source-agreements'
        ) -Wait -PassThru
        if ($p.ExitCode -eq 0) { Set-Status ("{0} installed." -f $FriendlyName) 'done'; return $true }
        Set-Status ("{0} installer exited with code {1}. See the README for a manual link." -f $FriendlyName, $p.ExitCode) 'warn'
        return $false
    } catch {
        Set-Status ("Installing {0} failed: {1}" -f $FriendlyName, $_.Exception.Message) 'warn'
        return $false
    }
}

function Install-Ollama {
    Set-Status 'Downloading the Ollama installer...' 'working'
    try {
        # Into the work folder so it is swept to the Recycle Bin later - it
        # can't be deleted right now because the user is about to run it.
        $tmp = Join-Path (Get-WorkDir) 'OllamaSetup.exe'

        # Streamed with a live progress banner rather than Invoke-WebRequest.
        # IWR buffers the whole response and, in Windows PowerShell 5.1, its
        # progress rendering makes large downloads dramatically slower - and
        # it shows nothing at all until finished, so a multi-hundred-MB
        # download looks exactly like a hung wizard.
        if (-not (Invoke-DownloadWithProgress -Url $script:OllamaSetupUrl -Dest $tmp -Label 'Ollama installer')) {
            return $false
        }
        # Launch WITHOUT -Wait so the wizard stays responsive. The Ollama
        # installer is its own window; blocking on it is what made the wizard
        # look frozen.
        Start-Process -FilePath $tmp | Out-Null
        Set-Status 'Ollama''s installer opened in a NEW WINDOW. Finish it there, then come back and click "Re-check all".' 'working'
        return $true
    } catch {
        Set-Status ('Ollama download failed: {0}. Install manually from https://ollama.com/download' -f $_.Exception.Message) 'warn'
        return $false
    }
}

function Install-Python  { Invoke-WingetInstall -Id 'Python.Python.3.12' -FriendlyName 'Python 3.12' }
function Install-Ffmpeg  { Invoke-WingetInstall -Id 'Gyan.FFmpeg'        -FriendlyName 'FFmpeg' }

function Invoke-OllamaPull {
    param([string]$Model)
    if (-not (Test-CommandExists 'ollama')) {
        Set-Status 'Ollama isn''t on PATH yet. Install Ollama and finish its installer first, then click "Re-check all".' 'warn'
        return $false
    }
    Set-Status ("Downloading model '{0}' - a window shows download progress. Please wait (a few hundred MB)..." -f $Model) 'working'
    try {
        # Visible console window so the user sees the download progress bar.
        $p = Start-Process -FilePath 'ollama' -ArgumentList @('pull', $Model) -Wait -PassThru
        if ($p.ExitCode -eq 0) { Set-Status ("Model '{0}' downloaded." -f $Model) 'done'; return $true }
        Set-Status ("Model download exited with code {0}." -f $p.ExitCode) 'warn'
        return $false
    } catch {
        Set-Status ('Model download failed: {0}' -f $_.Exception.Message) 'warn'
        return $false
    }
}

function Find-PythonExe {
    foreach ($cmd in @('python','py')) {
        $c = Get-Command $cmd -ErrorAction SilentlyContinue
        if ($c -and $c.Source -notlike '*WindowsApps*') {
            if ($cmd -eq 'py') { return @{ Exe='py'; Prefix=@('-3') } }
            return @{ Exe=$c.Source; Prefix=@() }
        }
    }
    return $null
}

function Setup-SpeechService {
    $py = Find-PythonExe
    if (-not $py) {
        Set-Status 'Python 3 not found. Install Python first (its row above), then run this step.' 'warn'
        return $false
    }
    if (-not (Test-Path $script:BundledSpeechScript)) {
        Set-Status ('speech_server.py is missing next to this wizard - re-extract the package. ({0})' -f $script:BundledSpeechScript) 'warn'
        return $false
    }
    try {
        New-Item -ItemType Directory -Force -Path $script:SpeechRoot | Out-Null
        Set-Status 'Setting up the speech service. This runs below and can take a few minutes - please wait...' 'working'
        Write-Log ('Copying speech_server.py to {0}' -f $script:SpeechScript)
        Copy-Item $script:BundledSpeechScript $script:SpeechScript -Force

        if (-not (Test-Path $script:VenvPython)) {
            Write-Log ('Creating Python virtual environment at {0}...' -f $script:SpeechVenv)
            & $py.Exe @($py.Prefix + @('-m','venv',$script:SpeechVenv))
            if (-not (Test-Path $script:VenvPython)) { Set-Status 'Could not create the Python virtual environment.' 'warn'; return $false }
        }

        Write-Log 'Installing flask, flask-cors, faster-whisper (this is the slow part)...'
        & $script:VenvPython -m pip install --upgrade pip 2>&1 | ForEach-Object { Write-Log "$_" }
        & $script:VenvPython -m pip install flask flask-cors faster-whisper 2>&1 | ForEach-Object { Write-Log "$_" }

        & $script:VenvPython -c 'import flask, flask_cors, faster_whisper' 2>$null
        if ($LASTEXITCODE -eq 0) {
            # Persist SPEECH_PYTHON/SPEECH_SCRIPT immediately. Those keys are
            # only computed at save time, so without this the wizard could show
            # [OK] while .env still had them blank - and Aura, falling back to a
            # dev-only relative path that doesn't exist in a packaged install,
            # would silently fail to start Whisper.
            Save-Config -Quiet
            Set-Status 'Speech service is set up and saved to your config.' 'done'
            return $true
        }
        Set-Status 'Speech packages did not verify after install. See the log below.' 'warn'
        return $false
    } catch {
        Set-Status ('Speech setup failed: {0}' -f $_.Exception.Message) 'warn'
        return $false
    }
}

# ---------------------------------------------------------------------------
# .env read / write
# ---------------------------------------------------------------------------
function Read-DotEnv {
    $result = @{}
    if (Test-Path $script:EnvPath) {
        foreach ($line in Get-Content $script:EnvPath) {
            $t = $line.Trim()
            if (-not $t -or $t.StartsWith('#')) { continue }
            $idx = $t.IndexOf('=')
            if ($idx -lt 1) { continue }
            $k = $t.Substring(0, $idx).Trim()
            $v = $t.Substring($idx + 1).Trim()
            $result[$k] = $v
        }
    }
    return $result
}

function Write-DotEnv {
    param([hashtable]$Values)

    New-Item -ItemType Directory -Force -Path $script:UserDataDir | Out-Null

    # Start from existing values so we never blow away something already set,
    # then overlay the values we were given (only non-empty ones).
    $merged = Read-DotEnv
    foreach ($k in $Values.Keys) {
        $val = $Values[$k]
        if ($null -ne $val -and "$val".Trim() -ne '') { $merged[$k] = "$val".Trim() }
        elseif (-not $merged.ContainsKey($k)) { $merged[$k] = '' }
    }

    $sb = New-Object System.Text.StringBuilder
    function AddLine($s) { [void]$sb.AppendLine($s) }
    function AddKV($k) { [void]$sb.AppendLine(('{0}={1}' -f $k, $merged[$k])) }

    AddLine '# Aura configuration - generated by Aura Prerequisites Setup.'
    AddLine '# Edit values here or re-run the wizard.'
    AddLine ''
    AddLine '# ============================================================================'
    AddLine '# Segmentation Licensing (PsySeg SDK)'
    AddLine '# ============================================================================'
    AddKV 'PSYSEG_LICENSE'; AddKV 'PSYSEG_ACCESS_KEY'; AddKV 'PSYSEG_ACCESS_TOKEN'
    AddLine ''
    AddLine '# ============================================================================'
    AddLine '# SerpAPI (image search / import)'
    AddLine '# ============================================================================'
    AddKV 'SERPAPI_KEY'
    AddLine ''
    AddLine '# ============================================================================'
    AddLine '# Aura Server'
    AddLine '# ============================================================================'
    AddKV 'PORT'
    AddLine ''
    AddLine '# ============================================================================'
    AddLine '# AI Services'
    AddLine '# ============================================================================'
    AddKV 'OLLAMA_URL'; AddKV 'COMFYUI_URL'; AddKV 'WHISPER_URL'
    AddLine ''
    AddLine '# Text model for summaries/prompts/triggers (must be pulled in Ollama).'
    AddKV 'OLLAMA_MODEL'
    AddLine '# Embedding model for semantic matching. bge-m3 recommended for non-English.'
    AddKV 'OLLAMA_EMBED_MODEL'
    AddLine ''
    AddLine '# ============================================================================'
    AddLine '# ComfyUI'
    AddLine '# ============================================================================'
    AddKV 'COMFYUI_AUTOSTART'; AddKV 'COMFYUI_WORKING_DIR'; AddKV 'COMFYUI_PYTHON'; AddKV 'COMFYUI_OUTPUT_DIR'
    AddLine ''
    AddLine '# ============================================================================'
    AddLine '# Speech Service (created by the prerequisites wizard)'
    AddLine '# ============================================================================'
    AddKV 'SPEECH_PYTHON'; AddKV 'SPEECH_SCRIPT'
    AddLine '# Whisper model size: base (default), small, or medium for better non-English.'
    AddKV 'WHISPER_MODEL'

    # Write UTF-8 without BOM.
    $utf8 = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($script:EnvPath, $sb.ToString(), $utf8)
    Write-Log ('.env written to {0}' -f $script:EnvPath)
}

# ---------------------------------------------------------------------------
# Console mode (-Check): fully testable, no GUI
# ---------------------------------------------------------------------------
function Show-ConsoleReport {
    Write-Host ''
    Write-Host '=== Aura Prerequisites - status ===' -ForegroundColor Cyan
    Write-Host ''
    $items = [ordered]@{
        'Ollama'                 = (Get-OllamaStatus)
        'Ollama embedding model' = (Get-OllamaEmbedStatus)
        'Ollama text model'      = (Get-OllamaTextModelStatus)
        'Python 3'               = (Get-PythonStatus)
        'FFmpeg (ffprobe)'       = (Get-FfmpegStatus)
        'Speech service'         = (Get-SpeechServiceStatus)
        'ComfyUI'                = (Get-ComfyStatus)
        'SDXL checkpoint'        = (Get-CheckpointStatus)
        'Aura .env config'       = (Get-EnvStatus)
    }
    foreach ($name in $items.Keys) {
        $s = $items[$name]
        $tag = switch ($s.State) { 'ok' {'[ OK ]'} 'partial' {'[WARN]'} default {'[ X  ]'} }
        $color = switch ($s.State) { 'ok' {'Green'} 'partial' {'Yellow'} default {'Red'} }
        Write-Host ('{0,-6} {1,-24} {2}' -f $tag, $name, $s.Detail) -ForegroundColor $color
    }
    Write-Host ''
    Write-Host ('.env location: {0}' -f $script:EnvPath)
    Write-Host ''
}

# ---------------------------------------------------------------------------
# Streaming download with a live progress banner.
#
# Downloads to a .part file and only moves it into place on success, so an
# interrupted 6.5 GB download can never masquerade as a finished one.
# ---------------------------------------------------------------------------
function Invoke-DownloadWithProgress {
    param(
        [string]$Url,
        [string]$Dest,
        [string]$Label = 'file'
    )

    $dir = Split-Path -Parent $Dest
    if ($dir -and -not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
    $part = $Dest + '.part'
    if (Test-Path -LiteralPath $part) { Remove-Item -LiteralPath $part -Force -ErrorAction SilentlyContinue }

    $req = [System.Net.HttpWebRequest]::Create($Url)
    $req.UserAgent = 'Aura-Prerequisites'
    $req.Timeout = 60000
    $req.ReadWriteTimeout = 300000

    $resp = $null; $in = $null; $out = $null
    try {
        $resp = $req.GetResponse()
        $total = $resp.ContentLength
        $in = $resp.GetResponseStream()
        $out = [System.IO.File]::Create($part)

        $buf = New-Object byte[] 1048576   # 1 MB
        $done = 0L
        $lastTick = 0
        $sw = [System.Diagnostics.Stopwatch]::StartNew()

        while (($read = $in.Read($buf, 0, $buf.Length)) -gt 0) {
            $out.Write($buf, 0, $read)
            $done += $read

            # Refresh at most ~4x/sec: enough to look alive, cheap enough not
            # to throttle the transfer.
            if (($sw.ElapsedMilliseconds - $lastTick) -ge 250) {
                $lastTick = $sw.ElapsedMilliseconds
                $mbps = if ($sw.Elapsed.TotalSeconds -gt 0) { ($done / 1MB) / $sw.Elapsed.TotalSeconds } else { 0 }
                if ($total -gt 0) {
                    $pct = [int](($done / $total) * 100)
                    $etaTxt = ''
                    if ($mbps -gt 0.01) {
                        $eta = [TimeSpan]::FromSeconds( (($total - $done) / 1MB) / $mbps )
                        $etaTxt = ('  -  about {0:hh\:mm\:ss} left' -f $eta)
                    }
                    Set-Status ('Downloading {0}: {1}%  ({2:N2} / {3:N2} GB at {4:N1} MB/s){5}' -f `
                        $Label, $pct, ($done/1GB), ($total/1GB), $mbps, $etaTxt) 'working' -NoLog
                } else {
                    Set-Status ('Downloading {0}: {1:N2} GB at {2:N1} MB/s' -f $Label, ($done/1GB), $mbps) 'working' -NoLog
                }
                [System.Windows.Forms.Application]::DoEvents()
            }
        }

        $out.Close(); $out = $null
        $in.Close();  $in = $null
        $resp.Close(); $resp = $null

        if ($total -gt 0 -and $done -lt $total) {
            throw ("Connection dropped after {0:N2} of {1:N2} GB." -f ($done/1GB), ($total/1GB))
        }

        if (Test-Path -LiteralPath $Dest) { Remove-Item -LiteralPath $Dest -Force }
        Move-Item -LiteralPath $part -Destination $Dest -Force
        Write-Log ('Downloaded {0} -> {1}' -f $Label, $Dest)
        return $true
    }
    catch {
        if ($out) { try { $out.Close() } catch {} }
        if ($in)  { try { $in.Close() }  catch {} }
        if ($resp){ try { $resp.Close() } catch {} }
        if (Test-Path -LiteralPath $part) { Remove-Item -LiteralPath $part -Force -ErrorAction SilentlyContinue }
        Set-Status ('Download of {0} failed: {1}' -f $Label, $_.Exception.Message) 'warn'
        return $false
    }
}

# ---------------------------------------------------------------------------
# ComfyUI location helpers.
#
# Testers get tripped up here more than anywhere else, because the portable
# build's run_nvidia_gpu.bat uses RELATIVE paths - if it is launched via
# "Run as administrator" the working directory becomes C:\Windows\System32
# and it dies with "The system cannot find the path specified".
#
# Aura never uses that .bat: it spawns COMFYUI_PYTHON with cwd set to
# COMFYUI_WORKING_DIR, so it is immune to that problem. All the tester
# actually has to do is point us at the folder. So we find it for them.
# ---------------------------------------------------------------------------

# Given any plausible ComfyUI folder, work out the three paths Aura needs.
# Handles both the portable layout and a git-clone + venv layout.
function Resolve-ComfyLayout {
    param([string]$Root)

    $result = @{ Ok = $false; WorkingDir = ''; Python = ''; OutputDir = ''; Detail = '' }
    if ([string]::IsNullOrWhiteSpace($Root) -or -not (Test-Path -LiteralPath $Root)) {
        $result.Detail = 'That folder does not exist.'
        return $result
    }
    $Root = (Resolve-Path -LiteralPath $Root).Path

    # Locate main.py: the user may have picked the outer portable folder,
    # the inner ComfyUI folder, or a plain clone.
    $workingDir = $null
    foreach ($cand in @($Root, (Join-Path $Root 'ComfyUI'), (Join-Path $Root 'ComfyUI_windows_portable\ComfyUI'))) {
        if (Test-Path -LiteralPath (Join-Path $cand 'main.py')) { $workingDir = $cand; break }
    }
    if (-not $workingDir) {
        $result.Detail = "Could not find main.py in or under that folder. Pick the folder that contains ComfyUI's main.py (or the ComfyUI_windows_portable folder)."
        return $result
    }
    $workingDir = (Resolve-Path -LiteralPath $workingDir).Path
    $parent = Split-Path -Parent $workingDir

    # Locate a python interpreter, preferring the portable embedded one.
    $pyCandidates = @(
        (Join-Path $parent 'python_embeded\python.exe'),
        (Join-Path $Root 'python_embeded\python.exe'),
        (Join-Path $workingDir 'venv\Scripts\python.exe'),
        (Join-Path $parent 'venv\Scripts\python.exe'),
        (Join-Path $workingDir '.venv\Scripts\python.exe')
    )
    $python = $pyCandidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1

    $result.WorkingDir = $workingDir
    $result.OutputDir  = Join-Path $workingDir 'output'
    if ($python) {
        $result.Python = (Resolve-Path -LiteralPath $python).Path
        $result.Ok = $true
        $result.Detail = 'Found ComfyUI.'
    } else {
        $result.Detail = "Found ComfyUI at $workingDir, but no Python next to it (expected python_embeded\python.exe or venv\Scripts\python.exe). If you downloaded the portable build, make sure the .7z was fully extracted."
    }
    return $result
}

# Scan the usual places so most testers never have to browse at all.
function Find-ComfyInstall {
    $roots = @(
        'C:\', 'C:\AI', 'C:\Program Files', 'D:\',
        (Join-Path $env:USERPROFILE 'Desktop'),
        (Join-Path $env:USERPROFILE 'Downloads'),
        (Join-Path $env:USERPROFILE 'Documents')
    ) | Where-Object { $_ -and (Test-Path -LiteralPath $_) } | Select-Object -Unique

    foreach ($root in $roots) {
        $cands = @()
        try {
            $cands = Get-ChildItem -LiteralPath $root -Directory -Force -ErrorAction SilentlyContinue |
                     Where-Object { $_.Name -like 'ComfyUI*' }
        } catch { }
        foreach ($c in $cands) {
            $r = Resolve-ComfyLayout $c.FullName
            if ($r.Ok) { return $r }
        }
    }
    return $null
}

# Push resolved paths into the config fields.
function Set-ComfyFields {
    param($Layout)
    if (-not $script:Fields) { return }
    if ($script:Fields['COMFYUI_WORKING_DIR']) { $script:Fields['COMFYUI_WORKING_DIR'].Text = $Layout.WorkingDir }
    if ($script:Fields['COMFYUI_PYTHON'])      { $script:Fields['COMFYUI_PYTHON'].Text      = $Layout.Python }
    if ($script:Fields['COMFYUI_OUTPUT_DIR'])  { $script:Fields['COMFYUI_OUTPUT_DIR'].Text  = $Layout.OutputDir }
}

# --- Fully automated ComfyUI install -----------------------------------------

# Which portable build matches this machine's GPU.
function Get-GpuVariant {
    try {
        $gpus = @(Get-CimInstance Win32_VideoController -ErrorAction Stop)
        $all = ($gpus | ForEach-Object { "$($_.Name) $($_.AdapterCompatibility)" }) -join ' '
        if ($all -match 'NVIDIA|GeForce|RTX|GTX')  { return @{ Variant='nvidia'; Gpu=($gpus[0].Name) } }
        if ($all -match 'AMD|Radeon|ATI')          { return @{ Variant='amd';    Gpu=($gpus[0].Name) } }
        if ($all -match 'Intel|Arc|Iris')          { return @{ Variant='intel';  Gpu=($gpus[0].Name) } }
        return @{ Variant='nvidia'; Gpu=($gpus[0].Name) }
    } catch {
        return @{ Variant='nvidia'; Gpu='unknown' }
    }
}

# Latest portable archive for this GPU, straight from the releases API.
function Get-ComfyDownloadInfo {
    param([string]$Variant = 'nvidia')
    try {
        $rel = Invoke-RestMethod -Uri 'https://api.github.com/repos/comfyanonymous/ComfyUI/releases/latest' `
                                 -Headers @{ 'User-Agent' = 'Aura-Prerequisites' } -TimeoutSec 30
        # Exact match first: '..._nvidia.7z' must not lose to '..._nvidia_cu126.7z'.
        $want = ('ComfyUI_windows_portable_{0}.7z' -f $Variant)
        $asset = $rel.assets | Where-Object { $_.name -eq $want } | Select-Object -First 1
        if (-not $asset) {
            $asset = $rel.assets | Where-Object { $_.name -like ('*{0}*.7z' -f $Variant) } | Select-Object -First 1
        }
        if (-not $asset) {
            $asset = $rel.assets | Where-Object { $_.name -like '*portable*.7z' } | Select-Object -First 1
        }
        if ($asset) {
            return @{ Ok=$true; Url=$asset.browser_download_url; Name=$asset.name; Size=$asset.size; Tag=$rel.tag_name }
        }
        return @{ Ok=$false; Detail='No portable build found in the latest release.' }
    } catch {
        return @{ Ok=$false; Detail=("Could not reach the ComfyUI releases API: {0}" -f $_.Exception.Message) }
    }
}

# A tool that can unpack .7z. Prefer an installed 7-Zip; otherwise fetch the
# 588 KB standalone extractor (Windows cannot open .7z on its own).
function Get-SevenZipTool {
    foreach ($c in @("$env:ProgramFiles\7-Zip\7z.exe", "${env:ProgramFiles(x86)}\7-Zip\7z.exe")) {
        if (Test-Path -LiteralPath $c) { return $c }
    }
    $cmd = Get-Command '7z.exe' -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }

    $zr = Join-Path (Get-WorkDir) '7zr.exe'
    if (Test-Path -LiteralPath $zr) { return $zr }

    Set-Status 'Fetching a small extraction tool (7zr.exe, under 1 MB)...' 'working'
    if (Invoke-DownloadWithProgress -Url 'https://www.7-zip.org/a/7zr.exe' -Dest $zr -Label '7zr.exe') { return $zr }
    return $null
}

# Unpack, keeping the wizard responsive and showing that something is happening.
function Expand-SevenZip {
    param([string]$Tool, [string]$Archive, [string]$Destination)

    if (-not (Test-Path -LiteralPath $Destination)) {
        New-Item -ItemType Directory -Force -Path $Destination | Out-Null
    }
    # NB: not $args - that's an automatic variable.
    $zargs = @('x', $Archive, ('-o' + $Destination), '-y', '-bsp1')
    $p = Start-Process -FilePath $Tool -ArgumentList $zargs -PassThru -WindowStyle Minimized
    $sw = [System.Diagnostics.Stopwatch]::StartNew()

    while (-not $p.HasExited) {
        $gb = 0
        try {
            $gb = ((Get-ChildItem -LiteralPath $Destination -Recurse -Force -File -ErrorAction SilentlyContinue |
                    Measure-Object -Property Length -Sum).Sum) / 1GB
        } catch {}
        Set-Status ('Extracting ComfyUI... {0:N2} GB unpacked so far ({1:mm\:ss} elapsed). This takes a few minutes.' -f `
            $gb, $sw.Elapsed) 'working' -NoLog
        [System.Windows.Forms.Application]::DoEvents()
        Start-Sleep -Milliseconds 500
    }
    return ($p.ExitCode -eq 0)
}

function Install-ComfyUI {
    $gpu = Get-GpuVariant
    Set-Status ('Detected {0} - looking up the matching ComfyUI build...' -f $gpu.Gpu) 'working'

    $info = Get-ComfyDownloadInfo -Variant $gpu.Variant
    if (-not $info.Ok) { Set-Status $info.Detail 'warn'; return $false }

    # Where to put it. Default to a short path - deep paths break ComfyUI.
    $defaultParent = 'C:\AI'
    $fb = New-Object System.Windows.Forms.FolderBrowserDialog
    $fb.Description = 'Choose where to install ComfyUI (a subfolder is created inside it). A short path like C:\AI works best.'
    if (-not (Test-Path -LiteralPath $defaultParent)) {
        try { New-Item -ItemType Directory -Force -Path $defaultParent | Out-Null } catch {}
    }
    if (Test-Path -LiteralPath $defaultParent) { $fb.SelectedPath = $defaultParent }
    if ($fb.ShowDialog() -ne 'OK') { Set-Status 'ComfyUI install cancelled.' 'info'; return $false }
    $parent = $fb.SelectedPath

    # ~2 GB archive + ~8 GB extracted, and the checkpoint lands here later.
    $needGb = 14
    try {
        $drive = (Get-Item -LiteralPath $parent).PSDrive
        if ($drive -and $drive.Free -and (($drive.Free / 1GB) -lt $needGb)) {
            Set-Status ('Not enough space on {0}: {1:N1} GB free, about {2} GB needed.' -f $drive.Name, ($drive.Free/1GB), $needGb) 'warn'
            return $false
        }
    } catch {}

    $answer = [System.Windows.Forms.MessageBox]::Show(
        ('Install ComfyUI automatically?' + [Environment]::NewLine + [Environment]::NewLine +
         ('Graphics card : {0}' -f $gpu.Gpu) + [Environment]::NewLine +
         ('Build         : {0} ({1})' -f $info.Name, $info.Tag) + [Environment]::NewLine +
         ('Download      : {0:N2} GB' -f ($info.Size/1GB)) + [Environment]::NewLine +
         ('Install into  : {0}' -f $parent) + [Environment]::NewLine + [Environment]::NewLine +
         'The wizard will download it, unpack it, configure the paths, and send the downloaded archive to the Recycle Bin when finished.'),
        'Install ComfyUI', 'YesNo', 'Question')
    if ($answer -ne 'Yes') { Set-Status 'ComfyUI install cancelled.' 'info'; return $false }

    $archive = Join-Path (Get-WorkDir) $info.Name
    Set-Status ('Downloading ComfyUI ({0:N2} GB)...' -f ($info.Size/1GB)) 'working'
    if (-not (Invoke-DownloadWithProgress -Url $info.Url -Dest $archive -Label 'ComfyUI')) { return $false }

    $tool = Get-SevenZipTool
    if (-not $tool) {
        Set-Status 'Could not get an extraction tool. Install 7-Zip from 7-zip.org, then click "Set up ComfyUI..." again.' 'warn'
        return $false
    }

    Set-Status 'Extracting ComfyUI...' 'working'
    $ok = Expand-SevenZip -Tool $tool -Archive $archive -Destination $parent
    if (-not $ok) {
        Set-Status 'Extraction failed. The download may be damaged - try again, or extract it yourself with 7-Zip.' 'warn'
        return $false
    }

    # Reclaim the archive immediately; it is the single biggest leftover.
    if (Remove-ToRecycleBin $archive) {
        Write-Log ('Sent {0} to the Recycle Bin ({1:N2} GB reclaimed).' -f $info.Name, ($info.Size/1GB))
    }

    $layout = Resolve-ComfyLayout $parent
    if (-not $layout.Ok) {
        Set-Status ('Installed, but the layout looks off: {0}' -f $layout.Detail) 'warn'
        return $false
    }
    Set-ComfyFields $layout
    Save-Config -Quiet
    Set-Status ('ComfyUI installed at {0} and configured. Next: download the SDXL checkpoint.' -f $layout.WorkingDir) 'done'
    return $true
}

# The guided ComfyUI dialog shown by the ComfyUI row's button.
function Invoke-ComfySetup {
    $dlg = New-Object System.Windows.Forms.Form
    $dlg.Text = 'Set up ComfyUI'
    $dlg.Size = New-Object System.Drawing.Size(660, 430)
    $dlg.StartPosition = 'CenterParent'
    $dlg.FormBorderStyle = 'FixedDialog'
    $dlg.MaximizeBox = $false; $dlg.MinimizeBox = $false

    $info = New-Object System.Windows.Forms.Label
    $info.Location = New-Object System.Drawing.Point(16, 14)
    $info.Size = New-Object System.Drawing.Size(610, 210)
    $info.Text = @'
Aura starts ComfyUI for you. You do NOT need to run it yourself, and it does
NOT need to be running right now - Aura just needs to know where it lives.

DON'T HAVE IT YET?
  Click "Install it for me". The wizard picks the right build for your
  graphics card, downloads it (about 2 GB), unpacks it, fills in the paths,
  and sends the downloaded archive to the Recycle Bin when it's done.

ALREADY HAVE IT?
  Click "Find it automatically", or use "Browse..." and pick the folder
  holding ComfyUI's main.py (or the ComfyUI_windows_portable folder).

Either way the paths are saved for you - no need to press Save afterwards.

Note: if you ever run run_nvidia_gpu.bat yourself, do NOT use "Run as
administrator" - that makes Windows look in System32 and it fails with
"The system cannot find the path specified". Aura does not have this problem.
'@
    $dlg.Controls.Add($info)

    $res = New-Object System.Windows.Forms.Label
    $res.Location = New-Object System.Drawing.Point(16, 232)
    $res.Size = New-Object System.Drawing.Size(610, 66)
    $res.Text = ''
    $dlg.Controls.Add($res)

    $applyLayout = {
        param($layout)
        if ($layout -and $layout.Ok) {
            Set-ComfyFields $layout
            $res.ForeColor = [System.Drawing.Color]::Green
            $res.Text = ("Found it. Filled in:" + [Environment]::NewLine +
                         "  " + $layout.WorkingDir + [Environment]::NewLine +
                         "  " + $layout.Python + [Environment]::NewLine +
                         'Click "Use these paths" to save and close.')
            $dlg.Tag = $layout
        } else {
            $res.ForeColor = [System.Drawing.Color]::Firebrick
            $res.Text = if ($layout) { $layout.Detail } else { 'Could not find ComfyUI automatically - use Browse... to point at the folder.' }
        }
    }

    $btnAuto = New-Object System.Windows.Forms.Button
    $btnAuto.Location = New-Object System.Drawing.Point(16, 306)
    $btnAuto.Size = New-Object System.Drawing.Size(160, 30)
    $btnAuto.Text = 'Find it automatically'
    $btnAuto.Add_Click({
        $dlg.Cursor = [System.Windows.Forms.Cursors]::WaitCursor
        $res.ForeColor = [System.Drawing.Color]::DimGray
        $res.Text = 'Searching common locations...'
        $dlg.Refresh()
        & $applyLayout (Find-ComfyInstall)
        $dlg.Cursor = [System.Windows.Forms.Cursors]::Default
    })
    $dlg.Controls.Add($btnAuto)

    $btnBrowse = New-Object System.Windows.Forms.Button
    $btnBrowse.Location = New-Object System.Drawing.Point(186, 306)
    $btnBrowse.Size = New-Object System.Drawing.Size(120, 30)
    $btnBrowse.Text = 'Browse...'
    $btnBrowse.Add_Click({
        $fb = New-Object System.Windows.Forms.FolderBrowserDialog
        $fb.Description = 'Pick your ComfyUI folder'
        if ($fb.ShowDialog() -eq 'OK') { & $applyLayout (Resolve-ComfyLayout $fb.SelectedPath) }
    })
    $dlg.Controls.Add($btnBrowse)

    $btnDl = New-Object System.Windows.Forms.Button
    $btnDl.Location = New-Object System.Drawing.Point(316, 306)
    $btnDl.Size = New-Object System.Drawing.Size(150, 30)
    $btnDl.Text = 'Install it for me'
    $btnDl.Font = New-Object System.Drawing.Font('Segoe UI', 9, [System.Drawing.FontStyle]::Bold)
    $btnDl.Add_Click({
        $dlg.Hide()
        if (Install-ComfyUI) {
            $layout = Resolve-ComfyLayout (Get-ConfigValue 'COMFYUI_WORKING_DIR')
            if ($layout.Ok) { $dlg.Tag = $layout }
        }
        $dlg.Close()
    })
    $dlg.Controls.Add($btnDl)

    $btnOk = New-Object System.Windows.Forms.Button
    $btnOk.Location = New-Object System.Drawing.Point(476, 306)
    $btnOk.Size = New-Object System.Drawing.Size(150, 30)
    $btnOk.Text = 'Use these paths'
    $btnOk.Add_Click({ $dlg.Close() })
    $dlg.Controls.Add($btnOk)

    [void]$dlg.ShowDialog()

    if ($dlg.Tag -and $dlg.Tag.Ok) {
        Save-Config -Quiet
        Set-Status ('ComfyUI set: {0} (saved).' -f $dlg.Tag.WorkingDir) 'done'
    } else {
        Set-Status 'ComfyUI not set up yet. Re-open "Set up ComfyUI" once you have extracted it.' 'info'
    }
}

# ---------------------------------------------------------------------------
# Write the current fields to .env. Top-level so automated steps can persist
# their own results (-Quiet), instead of relying on the user remembering to
# press Save afterwards.
# ---------------------------------------------------------------------------
function Save-Config {
    param([switch]$Quiet)
    if (-not $script:Fields) { return }
    $vals = @{
        'PORT'               = $script:AuraPort
        'OLLAMA_URL'         = $script:OllamaUrl
        'COMFYUI_URL'        = $script:ComfyUrl
        'WHISPER_URL'        = $script:WhisperUrl
        'COMFYUI_AUTOSTART'  = 'true'
        'OLLAMA_EMBED_MODEL' = $script:EmbedModel
        'SPEECH_PYTHON'      = $(if (Test-Path $script:VenvPython) { $script:VenvPython } else { '' })
        'SPEECH_SCRIPT'      = $(if (Test-Path $script:SpeechScript) { $script:SpeechScript } else { '' })
    }
    foreach ($k in $script:Fields.Keys) { $vals[$k] = $script:Fields[$k].Text }
    Write-DotEnv -Values $vals
    Invoke-RefreshRows -Quiet
    if (-not $Quiet) { Set-Status ('Saved to {0}' -f $script:EnvPath) 'done' }
}

# ---------------------------------------------------------------------------
# Text-model picker. Replaces "open ollama.com, read the docs, open a terminal,
# type `ollama pull gemma3`, then come back and type the name into a field" -
# the wizard pulls it and fills the field itself.
# ---------------------------------------------------------------------------
function Invoke-TextModelSetup {
    $choices = @(
        [pscustomobject]@{ Name='gemma3:4b';   Size='~3.3 GB'; Note='Recommended. Fast, runs well on most laptops.' },
        [pscustomobject]@{ Name='llama3.2:3b'; Size='~2.0 GB'; Note='Smallest / quickest. Good on low-RAM machines.' },
        [pscustomobject]@{ Name='gemma3:12b';  Size='~8.1 GB'; Note='Better quality. Needs a strong GPU or lots of RAM.' },
        [pscustomobject]@{ Name='qwen3:8b';    Size='~5.2 GB'; Note='Strong multilingual option.' }
    )

    $dlg = New-Object System.Windows.Forms.Form
    $dlg.Text = 'Choose a text model'
    $dlg.Size = New-Object System.Drawing.Size(620, 400)
    $dlg.StartPosition = 'CenterParent'
    $dlg.FormBorderStyle = 'FixedDialog'
    $dlg.MaximizeBox = $false; $dlg.MinimizeBox = $false

    $lbl = New-Object System.Windows.Forms.Label
    $lbl.Location = New-Object System.Drawing.Point(16, 14)
    $lbl.Size = New-Object System.Drawing.Size(570, 46)
    $lbl.Text = "Ollama installs with NO models - it is just the engine. Aura needs one" + [Environment]::NewLine +
                "to turn what you say into image prompts." + [Environment]::NewLine +
                "Pick one below: the wizard downloads it AND tells Aura to use it."
    $dlg.Controls.Add($lbl)

    $list = New-Object System.Windows.Forms.ListBox
    $list.Location = New-Object System.Drawing.Point(16, 66)
    $list.Size = New-Object System.Drawing.Size(570, 130)
    # Anything already pulled goes first and needs no download - selecting it
    # just records it. Re-downloading a model you already have is pure waste.
    $installed = @(Get-OllamaModels | Where-Object { $_ -notlike ($script:EmbedModel + '*') })
    foreach ($m in $installed) {
        $choices = @([pscustomobject]@{ Name=$m; Size='installed'; Note='Already downloaded - just use this one.' }) + $choices
    }

    foreach ($c in $choices) { [void]$list.Items.Add(('{0}   {1}   -   {2}' -f $c.Name.PadRight(14), $c.Size.PadRight(11), $c.Note)) }
    $list.Font = New-Object System.Drawing.Font('Consolas', 9)
    $list.SelectedIndex = 0
    $dlg.Controls.Add($list)

    $orLbl = New-Object System.Windows.Forms.Label
    $orLbl.Location = New-Object System.Drawing.Point(16, 206)
    $orLbl.Size = New-Object System.Drawing.Size(180, 20)
    $orLbl.Text = 'Or type any Ollama model:'
    $dlg.Controls.Add($orLbl)

    $custom = New-Object System.Windows.Forms.TextBox
    $custom.Location = New-Object System.Drawing.Point(196, 203)
    $custom.Size = New-Object System.Drawing.Size(230, 22)
    $dlg.Controls.Add($custom)

    $browse = New-Object System.Windows.Forms.Button
    $browse.Location = New-Object System.Drawing.Point(436, 202)
    $browse.Size = New-Object System.Drawing.Size(150, 25)
    $browse.Text = 'Browse ollama.com'
    $browse.Add_Click({ [System.Diagnostics.Process]::Start('https://ollama.com/library') | Out-Null })
    $dlg.Controls.Add($browse)

    $note = New-Object System.Windows.Forms.Label
    $note.Location = New-Object System.Drawing.Point(16, 238)
    $note.Size = New-Object System.Drawing.Size(570, 40)
    $note.ForeColor = [System.Drawing.Color]::DimGray
    $note.Text = 'The download runs in a console window that closes on its own. Large models take a while - the window is your progress bar.'
    $dlg.Controls.Add($note)

    $ok = New-Object System.Windows.Forms.Button
    $ok.Location = New-Object System.Drawing.Point(16, 292)
    $ok.Size = New-Object System.Drawing.Size(210, 32)
    $ok.Text = 'Download + use this model'
    $ok.Add_Click({
        $model = $custom.Text.Trim()
        if (-not $model) { $model = $choices[$list.SelectedIndex].Name }
        $dlg.Tag = $model
        $dlg.Close()
    })
    $dlg.Controls.Add($ok)

    $cancel = New-Object System.Windows.Forms.Button
    $cancel.Location = New-Object System.Drawing.Point(486, 292)
    $cancel.Size = New-Object System.Drawing.Size(100, 32)
    $cancel.Text = 'Cancel'
    $cancel.Add_Click({ $dlg.Tag = $null; $dlg.Close() })
    $dlg.Controls.Add($cancel)

    [void]$dlg.ShowDialog()

    $chosen = $dlg.Tag
    if (-not $chosen) { Set-Status 'No text model selected.' 'info'; return }

    # Already have it? Just record the choice - no download needed.
    if ($installed -contains $chosen) {
        if ($script:Fields -and $script:Fields['OLLAMA_MODEL']) { $script:Fields['OLLAMA_MODEL'].Text = $chosen }
        Save-Config -Quiet
        Set-Status ('Aura will use "{0}" (already installed).' -f $chosen) 'done'
        return
    }

    Set-Status ('Downloading model "{0}" - watch the console window that just opened.' -f $chosen) 'working'
    if (Invoke-OllamaPull $chosen) {
        if ($script:Fields -and $script:Fields['OLLAMA_MODEL']) { $script:Fields['OLLAMA_MODEL'].Text = $chosen }
        Save-Config -Quiet
        Set-Status ('Text model "{0}" is ready and saved to your config.' -f $chosen) 'done'
    } else {
        Set-Status ('Could not pull "{0}". Check the name and your connection, then try again.' -f $chosen) 'warn'
    }
}

# ---------------------------------------------------------------------------
# One-click SDXL checkpoint download, straight into ComfyUI's checkpoints
# folder under the exact filename Aura's workflow expects. Replaces: find the
# right file among several similarly-named ones, download 6.5 GB by hand, put
# it in the right folder, and name it exactly right.
# ---------------------------------------------------------------------------
function Invoke-CheckpointDownload {
    $wd = Get-ComfyWorkingDir
    if (-not $wd) {
        Set-Status 'Set up ComfyUI first - the checkpoint has to go inside its models folder.' 'warn'
        return
    }

    $destDir = Join-Path $wd 'models\checkpoints'
    $dest = Join-Path $destDir $script:CheckpointName

    if (Test-Path -LiteralPath $dest) {
        $sz = 0; try { $sz = (Get-Item -LiteralPath $dest).Length / 1GB } catch {}
        if ($sz -ge 5) {
            Set-Status ('Checkpoint is already there ({0:N1} GB).' -f $sz) 'done'
            return
        }
    }

    $free = -1
    try {
        $drive = (Get-Item -LiteralPath $wd).PSDrive
        if ($drive -and $drive.Free) { $free = $drive.Free / 1GB }
    } catch {}
    if ($free -ge 0 -and $free -lt 7.5) {
        Set-Status ('Not enough free space on that drive: {0:N1} GB free, need about 7 GB.' -f $free) 'warn'
        return
    }

    $answer = [System.Windows.Forms.MessageBox]::Show(
        ('Download the SDXL Lightning checkpoint (about 6.5 GB) to:' + [Environment]::NewLine + $dest +
         [Environment]::NewLine + [Environment]::NewLine +
         'This can take a while on a slow connection. The wizard stays usable and shows progress. Continue?'),
        'Download checkpoint', 'YesNo', 'Question')
    if ($answer -ne 'Yes') { Set-Status 'Checkpoint download cancelled.' 'info'; return }

    Set-Status 'Starting checkpoint download...' 'working'
    if (Invoke-DownloadWithProgress -Url $script:CheckpointUrl -Dest $dest -Label 'SDXL checkpoint') {
        Save-Config -Quiet
        Set-Status 'Checkpoint downloaded and in place.' 'done'
    }
}

# ---------------------------------------------------------------------------
# Refresh all row statuses in the GUI. Top-level (resolved by name at call
# time) so event handlers can call it safely - the previous scriptblock-in-a-
# closure approach captured it as $null and crashed.
# ---------------------------------------------------------------------------
function Invoke-RefreshRows {
    param([switch]$Quiet)
    if (-not $script:Rows) { return }

    $firstTodo = $null
    $firstTodoDetail = ''
    foreach ($row in $script:Rows) {
        $s = & $row.Check
        $tag = switch ($s.State) { 'ok' {'[OK]'} 'partial' {'[!]'} default {'[X]'} }
        $col = switch ($s.State) {
            'ok'      { [System.Drawing.Color]::Green }
            'partial' { [System.Drawing.Color]::DarkGoldenrod }
            default   { [System.Drawing.Color]::Firebrick }
        }
        $row.Status.Text = $tag
        $row.Status.ForeColor = $col
        $row.Detail.Text = $s.Detail

        # Instruct/helper rows keep their button active even when [OK], so the
        # user can re-open the guidance or re-point a path. Matched exactly -
        # a fuzzy '*Set up*' would also catch the speech-service button.
        $isInstruct = $row.Button.Text -in @('Choose + download', 'Set up ComfyUI...')
        $row.Button.Enabled = ($isInstruct -or (-not $s.Ok))

        # NB: $row.Detail is the Label CONTROL - the status TEXT has to come
        # from $s, or the banner prints "System.Windows.Forms.Label, Text: ...".
        if ((-not $s.Ok) -and (-not $firstTodo)) { $firstTodo = $row; $firstTodoDetail = $s.Detail }
    }

    if (-not $Quiet) {
        if ($firstTodo) {
            Set-Status ('Next: {0}  -  {1}' -f $firstTodo.Name, $firstTodoDetail) 'info'
        } else {
            Set-Status 'All prerequisites are ready. Fill in your keys below, click "Save my keys + config", then launch Aura.' 'done'
        }
    }
}

# ---------------------------------------------------------------------------
# GUI
# ---------------------------------------------------------------------------
function Show-Wizard {
    Add-Type -AssemblyName System.Windows.Forms
    Add-Type -AssemblyName System.Drawing

    $existing = Read-DotEnv

    $form = New-Object System.Windows.Forms.Form
    $form.Text = 'Aura Prerequisites Setup'
    $form.Size = New-Object System.Drawing.Size(820, 902)
    $form.StartPosition = 'CenterScreen'
    $form.Font = New-Object System.Drawing.Font('Segoe UI', 9)

    $header = New-Object System.Windows.Forms.Label
    $header.Text = 'Checks the external software Aura needs and helps install what is missing.' + [Environment]::NewLine +
                   'This is not the Aura app installer - install the Aura app separately.'
    $header.Location = New-Object System.Drawing.Point(14, 8)
    $header.Size = New-Object System.Drawing.Size(780, 32)
    $form.Controls.Add($header)

    # --- status banner (always tells the user what's happening / what's next) ---
    $bannerBox = New-Object System.Windows.Forms.Panel
    $bannerBox.Location = New-Object System.Drawing.Point(14, 42)
    $bannerBox.Size = New-Object System.Drawing.Size(780, 40)
    $bannerBox.BackColor = [System.Drawing.Color]::FromArgb(245, 247, 250)
    $bannerBox.BorderStyle = 'FixedSingle'
    $form.Controls.Add($bannerBox)

    $script:StatusBanner = New-Object System.Windows.Forms.Label
    $script:StatusBanner.Location = New-Object System.Drawing.Point(8, 4)
    $script:StatusBanner.Size = New-Object System.Drawing.Size(764, 32)
    $script:StatusBanner.Font = New-Object System.Drawing.Font('Segoe UI', 9.5, [System.Drawing.FontStyle]::Bold)
    $script:StatusBanner.TextAlign = 'MiddleLeft'
    $script:StatusBanner.Text = 'Checking what you already have...'
    $bannerBox.Controls.Add($script:StatusBanner)

    # --- prerequisites panel ---
    $panel = New-Object System.Windows.Forms.Panel
    $panel.Location = New-Object System.Drawing.Point(14, 90)
    $panel.Size = New-Object System.Drawing.Size(780, 340)
    $panel.BorderStyle = 'FixedSingle'
    $panel.AutoScroll = $true
    $form.Controls.Add($panel)

    $script:Rows = @()
    # Script-scoped so New-Row's writes and reads hit the SAME variable
    # (a local $y read + $script:y write would be two different variables,
    # stacking every row at the same Y).
    $script:rowY = 6

    function New-Row {
        param([string]$Name, [scriptblock]$CheckFn, [string]$ActionText, [scriptblock]$ActionFn)

        $status = New-Object System.Windows.Forms.Label
        $status.Location = New-Object System.Drawing.Point(8, ($script:rowY + 2))
        $status.Size = New-Object System.Drawing.Size(52, 20)
        $status.Text = '...'
        $panel.Controls.Add($status)

        $nameLbl = New-Object System.Windows.Forms.Label
        $nameLbl.Location = New-Object System.Drawing.Point(64, $script:rowY)
        $nameLbl.Size = New-Object System.Drawing.Size(180, 18)
        $nameLbl.Font = New-Object System.Drawing.Font('Segoe UI', 9, [System.Drawing.FontStyle]::Bold)
        $nameLbl.Text = $Name
        $panel.Controls.Add($nameLbl)

        $detail = New-Object System.Windows.Forms.Label
        $detail.Location = New-Object System.Drawing.Point(64, ($script:rowY + 18))
        $detail.Size = New-Object System.Drawing.Size(490, 32)
        $detail.ForeColor = [System.Drawing.Color]::DimGray
        $panel.Controls.Add($detail)

        $btn = New-Object System.Windows.Forms.Button
        $btn.Location = New-Object System.Drawing.Point(600, ($script:rowY + 6))
        $btn.Size = New-Object System.Drawing.Size(160, 26)
        $btn.Text = $ActionText
        if ($ActionFn) {
            # NOTE: no .GetNewClosure() here. The action is read from the
            # button's own .Tag at click time, and Invoke-RefreshRows is a
            # named function resolved at call time - so nothing needs to be
            # captured. (The earlier crash was a GetNewClosure snapshotting
            # $script:RefreshAll as $null because it was defined later.)
            $btn.Add_Click({
                $frm = $this.FindForm()
                if ($frm) { $frm.Cursor = [System.Windows.Forms.Cursors]::WaitCursor }
                $this.Enabled = $false
                try { & $this.Tag.Action } catch { Set-Status ('That step failed: {0}' -f $_.Exception.Message) 'warn' }
                $this.Enabled = $true
                if ($frm) { $frm.Cursor = [System.Windows.Forms.Cursors]::Default }
                # Refresh statuses quietly so the action's own banner message
                # (e.g. "finish the installer, then Re-check") is not overwritten.
                Invoke-RefreshRows -Quiet
            })
        } else {
            $btn.Visible = $false
        }
        $btn.Tag = @{ Action = $ActionFn }
        $panel.Controls.Add($btn)

        $script:Rows += ,([pscustomobject]@{ Check=$CheckFn; Status=$status; Detail=$detail; Button=$btn; Name=$Name })
        $script:rowY = $script:rowY + 56
    }

    New-Row 'Ollama' { Get-OllamaStatus } 'Install Ollama' { [void](Install-Ollama) }
    New-Row 'Embedding model' { Get-OllamaEmbedStatus } 'Pull nomic-embed-text' { [void](Invoke-OllamaPull $script:EmbedModel) }
    New-Row 'Text model' { Get-OllamaTextModelStatus } 'Choose + download' { Invoke-TextModelSetup }
    New-Row 'Python 3' { Get-PythonStatus } 'Install Python' { [void](Install-Python) }
    New-Row 'FFmpeg' { Get-FfmpegStatus } 'Install FFmpeg' { [void](Install-Ffmpeg) }
    New-Row 'Speech service' { Get-SpeechServiceStatus } 'Set up speech service' { [void](Setup-SpeechService) }
    New-Row 'ComfyUI' { Get-ComfyStatus } 'Set up ComfyUI...' { Invoke-ComfySetup }
    New-Row 'SDXL checkpoint' { Get-CheckpointStatus } 'Download checkpoint' { Invoke-CheckpointDownload }

    # --- configuration group ---
    $grp = New-Object System.Windows.Forms.GroupBox
    $grp.Text = 'Configuration (your keys + ComfyUI paths - written to .env)'
    $grp.Location = New-Object System.Drawing.Point(14, 438)
    $grp.Size = New-Object System.Drawing.Size(780, 250)
    $form.Controls.Add($grp)

    # Script-scoped: event handlers run on a different scope chain and would
    # not see a Show-Wizard local. The ComfyUI setup helper writes into this.
    $script:Fields = @{}
    $script:fieldY = 22
    function New-Field {
        param([string]$Label, [string]$Key, [bool]$Browse = $false, [bool]$Folder = $false)
        $l = New-Object System.Windows.Forms.Label
        $l.Location = New-Object System.Drawing.Point(12, ($script:fieldY + 3))
        $l.Size = New-Object System.Drawing.Size(200, 18)
        $l.Text = $Label
        $grp.Controls.Add($l)

        $tb = New-Object System.Windows.Forms.TextBox
        $tb.Location = New-Object System.Drawing.Point(216, $script:fieldY)
        $tb.Size = New-Object System.Drawing.Size(($(if ($Browse) { 460 } else { 548 })), 22)
        if ($existing[$Key]) { $tb.Text = $existing[$Key] }
        $grp.Controls.Add($tb)

        if ($Browse) {
            $b = New-Object System.Windows.Forms.Button
            $b.Location = New-Object System.Drawing.Point(684, ($script:fieldY - 1))
            $b.Size = New-Object System.Drawing.Size(80, 24)
            $b.Text = 'Browse...'
            $b.Add_Click({
                if ($this.Tag.Folder) {
                    $d = New-Object System.Windows.Forms.FolderBrowserDialog
                    if ($d.ShowDialog() -eq 'OK') { $this.Tag.Box.Text = $d.SelectedPath }
                } else {
                    $d = New-Object System.Windows.Forms.OpenFileDialog
                    if ($d.ShowDialog() -eq 'OK') { $this.Tag.Box.Text = $d.FileName }
                }
            })
            $b.Tag = @{ Box = $tb; Folder = $Folder }
            $grp.Controls.Add($b)
        }
        $script:Fields[$Key] = $tb
        $script:fieldY = $script:fieldY + 28
    }

    New-Field 'Text model (OLLAMA_MODEL)' 'OLLAMA_MODEL'
    New-Field 'ComfyUI folder' 'COMFYUI_WORKING_DIR' $true $true
    New-Field 'ComfyUI python.exe' 'COMFYUI_PYTHON' $true $false
    New-Field 'ComfyUI output folder' 'COMFYUI_OUTPUT_DIR' $true $true
    New-Field 'PsySeg license' 'PSYSEG_LICENSE'
    New-Field 'PsySeg access key' 'PSYSEG_ACCESS_KEY'
    New-Field 'PsySeg access token' 'PSYSEG_ACCESS_TOKEN'
    New-Field 'SerpAPI key' 'SERPAPI_KEY'

    # --- log ---
    $logLabel = New-Object System.Windows.Forms.Label
    $logLabel.Location = New-Object System.Drawing.Point(14, 692)
    $logLabel.Size = New-Object System.Drawing.Size(300, 16)
    $logLabel.Text = 'Details / progress log:'
    $logLabel.ForeColor = [System.Drawing.Color]::DimGray
    $form.Controls.Add($logLabel)

    $script:LogBox = New-Object System.Windows.Forms.TextBox
    $script:LogBox.Location = New-Object System.Drawing.Point(14, 710)
    $script:LogBox.Size = New-Object System.Drawing.Size(780, 96)
    $script:LogBox.Multiline = $true
    $script:LogBox.ReadOnly = $true
    $script:LogBox.ScrollBars = 'Vertical'
    $script:LogBox.BackColor = [System.Drawing.Color]::White
    $form.Controls.Add($script:LogBox)

    # --- buttons ---
    $btnRecheck = New-Object System.Windows.Forms.Button
    $btnRecheck.Location = New-Object System.Drawing.Point(14, 816)
    $btnRecheck.Size = New-Object System.Drawing.Size(150, 32)
    $btnRecheck.Text = 'Re-check all'
    $form.Controls.Add($btnRecheck)

    $btnSave = New-Object System.Windows.Forms.Button
    $btnSave.Location = New-Object System.Drawing.Point(174, 816)
    $btnSave.Size = New-Object System.Drawing.Size(220, 32)
    $btnSave.Text = 'Save my keys + config (.env)'
    $form.Controls.Add($btnSave)

    $btnClose = New-Object System.Windows.Forms.Button
    $btnClose.Location = New-Object System.Drawing.Point(694, 816)
    $btnClose.Size = New-Object System.Drawing.Size(100, 32)
    $btnClose.Text = 'Close'
    $btnClose.Add_Click({ $form.Close() })
    $form.Controls.Add($btnClose)

    $btnRecheck.Add_Click({ Set-Status 'Re-checking...' 'working'; Invoke-RefreshRows })

    $btnSave.Add_Click({
        Save-Config
        [System.Windows.Forms.MessageBox]::Show(
            ('Your configuration was saved to:' + [Environment]::NewLine + $script:EnvPath +
             [Environment]::NewLine + [Environment]::NewLine +
             'You can close this wizard and launch Aura once every row above is green.'),
            'Aura Prerequisites', 'OK', 'Information') | Out-Null
    })

    # Sweep leftovers from a previous run (wizard closed mid-install, etc.)
    # before doing anything else.
    $form.Add_FormClosed({ Clear-WorkDir -Quiet })

    $form.Add_Shown({
        Clear-WorkDir

        # If exactly one text model is installed and none is configured, that
        # is the only sensible answer - just use it. Covers "I already pulled
        # a model" without making the user open a dialog to say so.
        if (-not (Get-ConfigValue 'OLLAMA_MODEL')) {
            $existingModels = @(Get-OllamaModels | Where-Object { $_ -notlike ($script:EmbedModel + '*') })
            if ($existingModels.Count -eq 1 -and $script:Fields -and $script:Fields['OLLAMA_MODEL']) {
                $script:Fields['OLLAMA_MODEL'].Text = $existingModels[0]
                Save-Config -Quiet
                Write-Log ('Auto-selected the only installed text model: {0}' -f $existingModels[0])
            }
        }

        # If ComfyUI isn't configured yet, go find it before the first check so
        # an existing install is simply recognised - no button, no browsing.
        if (-not (Get-ConfigValue 'COMFYUI_WORKING_DIR')) {
            Set-Status 'Looking for an existing ComfyUI install...' 'working'
            $found = Find-ComfyInstall
            if ($found -and $found.Ok) {
                Set-ComfyFields $found
                Save-Config -Quiet
                Write-Log ('Auto-detected ComfyUI at {0}' -f $found.WorkingDir)
            }
        }
        Invoke-RefreshRows
    })
    [void]$form.ShowDialog()
}

# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------
# Dot-sourcing (. .\Aura-Prerequisites.ps1) loads the functions without
# launching anything, so the logic can be exercised/tested in isolation.
if ($MyInvocation.InvocationName -ne '.') {
    if ($Check) {
        Show-ConsoleReport
    } else {
        Show-Wizard
    }
}
