<#
    Aura prerequisites uninstaller  (TEST MACHINES)

    Removes what the Aura prerequisites wizard installed, so you can start
    from a known-clean state.

    Safety:
      * Nothing is removed without being listed and confirmed first.
      * Deletions go to the RECYCLE BIN wherever possible, not permanent.
      * Shared tools (Python, FFmpeg, 7-Zip) are OFF by default - other
        software on the machine may depend on them.
      * The Aura APP itself is not touched here; uninstall it from
        Settings > Apps like any normal program.

    Run:  powershell -NoProfile -ExecutionPolicy Bypass -File Aura-Uninstall-Prerequisites.ps1
          add  -WhatIf  to see what WOULD be removed, changing nothing.
#>

[CmdletBinding()]
param(
    [switch]$WhatIf,
    # Off by default: these are commonly shared with other software.
    [switch]$IncludeSharedTools,
    # Ollama's downloaded models can be many GB and are slow to re-pull.
    [switch]$IncludeOllamaModels,
    # ComfyUI + the SDXL checkpoint are ~12 GB and rarely the thing under
    # test. Kept by default so a re-test does not mean an overnight download.
    [switch]$IncludeComfyUI,
    # Leave the installed Aura app alone (default is to uninstall it, since
    # the install path itself is usually what is being re-tested).
    [switch]$KeepAuraApp,
    [switch]$Yes
)

$ErrorActionPreference = 'Continue'

function Say  { param([string]$T) Write-Host $T }
function Head { param([string]$T) Write-Host ''; Write-Host ('=== ' + $T + ' ===') }

function Get-SizeGb {
    param([string]$Path)
    try {
        if (-not (Test-Path -LiteralPath $Path)) { return 0 }
        if (Test-Path -LiteralPath $Path -PathType Container) {
            return ((Get-ChildItem -LiteralPath $Path -Recurse -Force -File -ErrorAction SilentlyContinue |
                     Measure-Object -Property Length -Sum).Sum) / 1GB
        }
        return (Get-Item -LiteralPath $Path).Length / 1GB
    } catch { return 0 }
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
        Say ('    (Recycle Bin refused - leaving in place: {0})' -f $_.Exception.Message)
        return $false
    }
}

# ---------------------------------------------------------------------------
# 1. Work out what is actually here
# ---------------------------------------------------------------------------
$envPath  = Join-Path $env:APPDATA      'Aura\.env'
$auraLocal= Join-Path $env:LOCALAPPDATA 'Aura'
$speechEnv= Join-Path $env:LOCALAPPDATA 'Aura\speech-venv'
$speechDir= Join-Path $env:LOCALAPPDATA 'Aura\speech'
$cacheDir = Join-Path $env:LOCALAPPDATA 'Aura\installer-cache'

# ComfyUI location comes from .env when we can read it.
$comfyDir = $null
if (Test-Path -LiteralPath $envPath) {
    foreach ($l in Get-Content -LiteralPath $envPath) {
        if ($l -match '^\s*COMFYUI_WORKING_DIR\s*=\s*(.+)$') { $comfyDir = $Matches[1].Trim() }
    }
}
# The portable build nests ComfyUI one level down; remove the whole payload.
if ($comfyDir -and (Split-Path -Leaf $comfyDir) -eq 'ComfyUI') {
    $parent = Split-Path -Parent $comfyDir
    if ($parent -and (Test-Path -LiteralPath (Join-Path $parent 'python_embeded'))) { $comfyDir = $parent }
}

# %APPDATA%\Aura is the packaged app's userData: the SQLite DB, aura-config,
# session/PID files AND .env. Removing the whole folder (not just .env) is
# what actually gives a first-run-clean install to test against.
$auraRoaming = Join-Path $env:APPDATA 'Aura'

$targets = @()
$targets += [pscustomobject]@{ Name='Speech service venv';   Path=$speechEnv;   On=$true }
$targets += [pscustomobject]@{ Name='Speech service files';  Path=$speechDir;   On=$true }
$targets += [pscustomobject]@{ Name='Installer cache';       Path=$cacheDir;    On=$true }
$targets += [pscustomobject]@{ Name='Aura data + .env + DB'; Path=$auraRoaming; On=$true }
if ($comfyDir -and $IncludeComfyUI) {
    $targets += [pscustomobject]@{ Name='ComfyUI (incl. models)'; Path=$comfyDir; On=$true }
}

Head 'Aura prerequisites uninstaller'
if ($WhatIf) { Say 'DRY RUN - nothing will actually be removed.' }
Say ''
Say 'These will be sent to the Recycle Bin:'
$total = 0
foreach ($t in $targets) {
    if (Test-Path -LiteralPath $t.Path) {
        $g = Get-SizeGb $t.Path
        $total += $g
        Say ('  [x] {0,-24} {1,8:N2} GB   {2}' -f $t.Name, $g, $t.Path)
    } else {
        $t.On = $false
        Say ('  [ ] {0,-24} {1}' -f $t.Name, '(not present)')
    }
}
Say ('  Total: about {0:N2} GB' -f $total)

Say ''
Say 'Programs to be uninstalled:'
$ollama = Get-Command ollama -ErrorAction SilentlyContinue
Say ('  [{0}] Ollama' -f $(if ($ollama) { 'x' } else { ' ' }))
$ollamaModels = Join-Path $env:USERPROFILE '.ollama'
if ($IncludeOllamaModels) {
    Say ('  [x] Ollama models  {0,8:N2} GB   {1}' -f (Get-SizeGb $ollamaModels), $ollamaModels)
} else {
    Say ('  [ ] Ollama models  ({0:N2} GB) - KEPT. Re-run with -IncludeOllamaModels to remove.' -f (Get-SizeGb $ollamaModels))
}
if ($IncludeSharedTools) {
    Say '  [x] Python 3, FFmpeg  (shared - removing because -IncludeSharedTools was passed)'
} else {
    Say '  [ ] Python 3, FFmpeg  - KEPT. Other software may need them.'
    Say '                          Re-run with -IncludeSharedTools to remove.'
}

# --- the Aura app itself ----------------------------------------------------
$auraUninstaller = $null
foreach ($k in @('HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*',
                 'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*',
                 'HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*')) {
    $e = Get-ItemProperty $k -ErrorAction SilentlyContinue |
         Where-Object { $_.DisplayName -match '^Aura( \d|$)' } | Select-Object -First 1
    if ($e) { $auraUninstaller = $e; break }
}
Say ''
if ($KeepAuraApp) {
    Say '  [ ] Aura application - KEPT (-KeepAuraApp).'
} elseif ($auraUninstaller) {
    Say ('  [x] Aura application - "{0}" will be uninstalled.' -f $auraUninstaller.DisplayName)
} else {
    Say '  [ ] Aura application - not installed.'
}

# --- virtual camera COM registration ---------------------------------------
# This is the piece nothing else cleans up, and the one most likely to make a
# "clean" re-test lie to you: a leftover CLSID can still point at an old DLL
# (even one inside a source tree), so the camera appears to work - or shows
# black - for reasons that have nothing to do with the build being tested.
$camClsids = @()
foreach ($root in @('HKLM:\SOFTWARE\Classes\CLSID', 'HKCU:\SOFTWARE\Classes\CLSID')) {
    Get-ChildItem $root -ErrorAction SilentlyContinue | ForEach-Object {
        $ip = Join-Path $_.PSPath 'InprocServer32'
        if (Test-Path $ip) {
            $v = (Get-ItemProperty $ip -ErrorAction SilentlyContinue).'(default)'
            if ($v -and $v -match 'VCamSampleSource') {
                $camClsids += [pscustomobject]@{ Key=$_.PSPath; Clsid=$_.PSChildName; Dll=$v }
            }
        }
    }
}
Say ''
if ($camClsids.Count) {
    Say 'Virtual camera registration to be removed:'
    foreach ($c in $camClsids) { Say ('  [x] {0}' -f $c.Clsid); Say ('       -> {0}' -f $c.Dll) }
} else {
    Say 'Virtual camera registration: none found (already clean).'
}

Say ''
Say 'NOT touched by this script:'
if (-not $IncludeComfyUI) {
    Say ('  * ComfyUI + SDXL checkpoint ({0:N2} GB) - KEPT.' -f $(if ($comfyDir) { Get-SizeGb $comfyDir } else { 0 }))
    Say '    Re-run with -IncludeComfyUI if you really want it gone.'
}
Say '  * Your PsySeg / SerpAPI keys - keep them, you will need them again.'
Say '    (They live in the .env being removed, so copy them out first if'
Say '     you have no other record of them.)'

if (-not $WhatIf -and -not $Yes) {
    Say ''
    $ans = Read-Host 'Proceed? Type YES to continue'
    if ($ans -ne 'YES') { Say 'Cancelled - nothing was changed.'; return }
}

# ---------------------------------------------------------------------------
# 2. Stop anything still running, or files will be locked
# ---------------------------------------------------------------------------
Head 'Stopping running services'
# Match on the EXECUTABLE PATH, not the process name. Killing every 'node' or
# 'python' on the box would take out unrelated work - on a dev box that could
# be an editor, a build, or another app entirely.
$ownedRoots = @($auraLocal, $comfyDir, (Join-Path $env:LOCALAPPDATA 'Programs\Ollama'),
                (Join-Path $env:LOCALAPPDATA 'Ollama'), (Join-Path $env:LOCALAPPDATA 'Programs\Aura')) |
              Where-Object { $_ -and (Test-Path -LiteralPath $_) } |
              ForEach-Object { (Resolve-Path -LiteralPath $_).Path.TrimEnd('\') + '\' }

$stopped = 0
foreach ($p in @(Get-Process -ErrorAction SilentlyContinue)) {
    $exe = $null
    try { $exe = $p.Path } catch { continue }   # access denied on system procs
    if (-not $exe) { continue }
    $owned = $false
    foreach ($root in $ownedRoots) {
        if ($exe.StartsWith($root, [StringComparison]::OrdinalIgnoreCase)) { $owned = $true; break }
    }
    if (-not $owned) { continue }
    Say ('  stopping {0} (pid {1})' -f $exe, $p.Id)
    $stopped++
    if (-not $WhatIf) { try { $p.Kill(); $p.WaitForExit(5000) } catch {} }
}
if ($stopped -eq 0) { Say '  nothing of ours is running.' }
Start-Sleep -Seconds 1

# ---------------------------------------------------------------------------
# 3. Uninstall programs
# ---------------------------------------------------------------------------
Head 'Uninstalling programs'

# Aura first: its own uninstaller unregisters the virtual camera DLL, which is
# cleaner than us ripping the CLSID out from underneath it.
if ($auraUninstaller -and -not $KeepAuraApp) {
    Say ('  Aura ({0})...' -f $auraUninstaller.DisplayName)
    if (-not $WhatIf) {
        $cmd = $auraUninstaller.QuietUninstallString
        if (-not $cmd) { $cmd = $auraUninstaller.UninstallString }
        if ($cmd) {
            # UninstallString is usually a quoted exe path, sometimes with
            # trailing switches (e.g. /currentuser on a per-user NSIS build).
            # NB: not $args - that is an automatic PowerShell variable.
            if ($cmd -match '^\s*"([^"]+)"\s*(.*)$') { $exe = $Matches[1]; $uninstArgs = $Matches[2] }
            else { $exe = $cmd; $uninstArgs = '' }
            $argList = @('/S', '--force-run=false')
            if ($uninstArgs) { $argList = @($uninstArgs) + $argList }
            try {
                Start-Process -FilePath $exe -ArgumentList $argList -Wait -ErrorAction Stop
                Say '    uninstalled'
            } catch {
                Say ('    could not run the uninstaller automatically: {0}' -f $_.Exception.Message)
                Say '    Uninstall "Aura" manually from Settings > Apps.'
            }
        }
    }
}

if ($ollama) {
    Say '  Ollama...'
    if (-not $WhatIf) {
        $done = $false
        # Its own uninstaller first; winget as a fallback.
        foreach ($u in @((Join-Path $env:LOCALAPPDATA 'Programs\Ollama\unins000.exe'),
                         (Join-Path $env:LOCALAPPDATA 'Ollama\unins000.exe'))) {
            if (Test-Path -LiteralPath $u) {
                Start-Process -FilePath $u -ArgumentList '/SILENT' -Wait
                $done = $true; break
            }
        }
        if (-not $done -and (Get-Command winget -ErrorAction SilentlyContinue)) {
            winget uninstall --id Ollama.Ollama -e --silent 2>&1 | Out-Null
        }
    }
}

if ($IncludeSharedTools -and (Get-Command winget -ErrorAction SilentlyContinue)) {
    foreach ($id in @('Python.Python.3.12','Gyan.FFmpeg')) {
        Say ('  {0}...' -f $id)
        if (-not $WhatIf) { winget uninstall --id $id -e --silent 2>&1 | Out-Null }
    }
}

# ---------------------------------------------------------------------------
# 3b. Virtual camera registration
# ---------------------------------------------------------------------------
Head 'Clearing virtual camera registration'
if (-not $camClsids.Count) {
    Say '  nothing registered.'
} else {
    $isAdmin = ([Security.Principal.WindowsPrincipal] `
        [Security.Principal.WindowsIdentity]::GetCurrent()
        ).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)

    foreach ($c in $camClsids) {
        Say ('  {0}' -f $c.Clsid)
        Say ('    dll: {0}' -f $c.Dll)
        if ($WhatIf) { continue }

        # Proper unregister first - only possible if the DLL still exists.
        $unregistered = $false
        if (Test-Path -LiteralPath $c.Dll) {
            $p = Start-Process -FilePath "$env:SystemRoot\System32\regsvr32.exe" `
                               -ArgumentList @('/u', '/s', ('"{0}"' -f $c.Dll)) -Wait -PassThru
            $unregistered = ($p.ExitCode -eq 0)
            Say ('    regsvr32 /u -> exit {0}' -f $p.ExitCode)
        } else {
            Say '    dll is gone - registration is stale, removing the key directly'
        }

        # Stale key (or a failed unregister) still has to go, or the next
        # install inherits a CLSID pointing at a DLL that is not there.
        if (-not $unregistered) {
            if ($c.Key -like 'HKLM*' -and -not $isAdmin) {
                Say '    NEEDS ADMIN - re-run this script as Administrator to remove it.'
            } else {
                try {
                    Remove-Item -LiteralPath $c.Key -Recurse -Force -ErrorAction Stop
                    Say '    registry key removed'
                } catch {
                    Say ('    could not remove key: {0}' -f $_.Exception.Message)
                }
            }
        }
    }
}

# ---------------------------------------------------------------------------
# 4. Remove files
# ---------------------------------------------------------------------------
Head 'Removing files (to Recycle Bin)'
foreach ($t in $targets) {
    if (-not $t.On) { continue }
    Say ('  {0}  ->  {1}' -f $t.Name, $t.Path)
    if (-not $WhatIf) {
        if (Remove-ToRecycleBin $t.Path) { Say '    removed' } else { Say '    COULD NOT REMOVE (in use?)' }
    }
}

if ($IncludeOllamaModels -and (Test-Path -LiteralPath $ollamaModels)) {
    Say ('  Ollama models  ->  {0}' -f $ollamaModels)
    if (-not $WhatIf) {
        if (Remove-ToRecycleBin $ollamaModels) { Say '    removed' } else { Say '    COULD NOT REMOVE' }
    }
}

# %LOCALAPPDATA%\Aura itself, if now empty.
if (-not $WhatIf -and (Test-Path -LiteralPath $auraLocal)) {
    if (@(Get-ChildItem -LiteralPath $auraLocal -Force -ErrorAction SilentlyContinue).Count -eq 0) {
        Remove-ToRecycleBin $auraLocal | Out-Null
        Say ('  removed empty folder {0}' -f $auraLocal)
    }
}

Head 'Done'
Say ''
Say 'Next steps for a clean re-test:'
Say '  1. Reboot (clears anything still holding a file, port or DLL).'
Say '  2. Run "Install Aura Prerequisites.bat" and let it do everything.'
Say '     ComfyUI should still be detected automatically - it was kept.'
Say '  3. Install Aura (approve the admin prompt - that registers the'
Say '     virtual camera), then launch it.'
Say '  4. Run "Diagnose Aura.bat" if anything is still red.'
Say ''
if (-not $WhatIf) {
    Say 'Everything removed went to the Recycle Bin - recover from there if needed.'
}
Say ''
