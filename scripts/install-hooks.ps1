# Installs Aura's git hooks from scripts\hooks into this clone's hooks directory.
#
# Git does not version control .git\hooks, so a fresh clone starts with no hooks
# and the CV-Hub mirror silently stops happening. Run this once after cloning.
# Safe to re-run: it overwrites whatever is there.
#
# Why this rewrites the file instead of using Copy-Item: hooks run under git's
# bundled sh, and either CRLF line endings or a UTF-8 BOM turns the "#!/bin/sh"
# line into an unrecognised interpreter, so the hook dies with "bad interpreter"
# on every push. .gitattributes forces LF on checkout; this is the second line of
# defence for a hook edited by a Windows editor.

$ErrorActionPreference = 'Stop'

$ProjectRoot = Split-Path -Parent $PSScriptRoot
$SourceDir   = Join-Path $PSScriptRoot 'hooks'

Set-Location $ProjectRoot

if (!(Test-Path $SourceDir)) {
    Write-Host "ERROR: $SourceDir not found."
    exit 1
}

# A custom hooksPath would make this install into a directory git then ignores,
# which looks like success and mirrors nothing.
$CustomPath = git config --get core.hooksPath
if ($CustomPath) {
    Write-Host "ERROR: core.hooksPath is set to '$CustomPath'."
    Write-Host "       Aura expects the default hooks directory. Unset it with:"
    Write-Host "       git config --unset core.hooksPath"
    exit 1
}

$HooksDir = git rev-parse --git-path hooks
if (!$?) {
    Write-Host "ERROR: not inside a git repository."
    exit 1
}
if (![System.IO.Path]::IsPathRooted($HooksDir)) {
    $HooksDir = Join-Path $ProjectRoot $HooksDir
}
if (!(Test-Path $HooksDir)) {
    New-Item $HooksDir -ItemType Directory | Out-Null
}

$Utf8NoBom = New-Object System.Text.UTF8Encoding $false

foreach ($Hook in (Get-ChildItem $SourceDir -File)) {
    $Target = Join-Path $HooksDir $Hook.Name
    $Text   = [System.IO.File]::ReadAllText($Hook.FullName)
    $Text   = $Text -replace "`r`n", "`n"
    [System.IO.File]::WriteAllText($Target, $Text, $Utf8NoBom)
    Write-Host "Installed hook: $($Hook.Name)"
}

Write-Host "Git hooks installed."
