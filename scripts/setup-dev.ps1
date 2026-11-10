Write-Host "Setting up Aura development environment..."

$ProjectRoot = Split-Path -Parent $PSScriptRoot

Set-Location $ProjectRoot

$Folders = @(
    "data",
    "data\audio",
    "data\images",
    "data\images\generated",
    "data\images\backgrounds",
    "data\imports",
    "src\db\migrations",
    "src\db\repositories",
    "src\speech",
    "src\config",
    "docs"
)

foreach ($Folder in $Folders) {
    if (!(Test-Path $Folder)) {
        New-Item $Folder -ItemType Directory | Out-Null
        Write-Host "Created folder: $Folder"
    }
}

# Hooks before the tool checks: the CV-Hub mirror does not need node or
# python, so a clone missing one of those should still get a working hook.
& (Join-Path $PSScriptRoot "install-hooks.ps1")

if (!(Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Host "ERROR: Node.js is not installed or not in PATH."
    exit 1
}

if (!(Get-Command python -ErrorAction SilentlyContinue)) {
    Write-Host "ERROR: Python is not installed or not in PATH."
    exit 1
}

if (!(Get-Command ffmpeg -ErrorAction SilentlyContinue)) {
    Write-Host "ERROR: FFmpeg is not installed or not in PATH."
    exit 1
}

if (!(Get-Command ffprobe -ErrorAction SilentlyContinue)) {
    Write-Host "ERROR: FFprobe is not installed or not in PATH."
    exit 1
}

Write-Host "Installing Node dependencies..."
npm install

Write-Host "Installing Python dependencies..."
pip install -r requirements.txt

Write-Host "Aura development setup complete."