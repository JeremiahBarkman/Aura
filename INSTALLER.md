# Installer

Packaging and deployment.

## npm scripts

```
npm run stage       # scripts/stage-resources.js — stages native binaries for packaging
npm run dist        # electron-builder NSIS installer (predist runs `stage` automatically)
npm run dist:dir    # unpacked build output only, no installer (predist:dir runs `stage` automatically)
```

## scripts/stage-resources.js

Copies the 4 binaries the installer needs into a tracked `native/runtime/` staging directory:
- `AuraFrameBridge.exe` from `x64/Release`
- `VCamSample.exe` / `VCamSampleSource.dll` from `x64/Release`, falling back to `x64/Debug` with a warning
- The currently-running `node.exe` itself (the same standalone Node bundled to run `src/web/server.js` — see ARCHITECTURE.md for why Electron's own Node isn't used)

It's copy-only and non-destructive, skips byte-identical copies to keep git clean, and hard-fails (`process.exit(1)`) if a required binary is missing with no staged fallback available. It runs automatically via the `predist`/`predist:dir` npm hooks before `electron-builder` runs.

## electron-builder config (package.json `build`)

- `appId: com.aura.studio`, `productName: Aura`
- `asar: false` — explicitly unpacked, because the native `.exe`/`.dll` extraResources and `better-sqlite3`'s native binding need real filesystem paths (Windows can't `CreateProcess` a path inside `app.asar`).
- `npmRebuild: false` — deliberately does not rebuild native modules for Electron's ABI; the bundled standalone `node.exe` is used instead (see ARCHITECTURE.md).
- `files`: `electron-main.js`, `electron-preload.js`, `package.json`, `.env.example`, `public/**/*`, `src/**/*`, `comfy/**/*`, `node_modules/**/*`.
- `extraResources`: copies the 4 staged `native/runtime/*` binaries into `resources/native/*.exe` and `resources/node.exe` (flattened out of `native/runtime/`).
- `win.target: nsis`, icon at `build/icon.ico`.
- `nsis`: `oneClick: false`, `perMachine: true`, user-choosable install directory, desktop + Start Menu shortcuts, `shortcutName: "Aura"`.

## First-run config seeding

On a packaged install, `electron-main.js` resolves `.env` to `<userData>/.env` (i.e. `%APPDATA%\Aura\.env`, capitalized per `productName`) and auto-seeds it from the bundled `.env.example` on first run if it doesn't already exist. `reportEnvHealth()` then validates required keys (`PSYSEG_LICENSE`, `COMFYUI_WORKING_DIR`, `SPEECH_PYTHON`, etc.) and logs a banner if any are missing or invalid.

## External prerequisites (not bundled by electron-builder)

Aura depends on several external services/tools that are **not** packaged into the installer and must be present on the target machine: Ollama (with models pulled), ComfyUI (with checkpoints for `comfy/workflows/aura_background_api.json`), a Python venv for the speech service, and PsySeg/SerpAPI credentials. `installer/prerequisites/Aura-Prerequisites.ps1` is the tester-facing wizard that sets these up (including creating the speech venv and installing `faster-whisper`/`flask`/`flask-cors`), and `installer/prerequisites/speech_server.py` is a copy of the speech service staged for that wizard.

`docs/Aura Documentation v0.6/Aura Packaged Install Guide.md` is the current end-user-facing installation walkthrough covering the installer plus each external prerequisite — treat it as the source of truth for end-user install steps; this file covers the packaging mechanics instead.

## Known stale script

`scripts/setup-dev.ps1` (a dev environment bootstrapper — creates `data/*` folders, verifies `node`/`python`/`ffmpeg`/`ffprobe` are on PATH, runs `npm install`) also tries `pip install -r requirements.txt`, but **no `requirements.txt` exists anywhere in the repo**. This step is currently broken/stale; the real Python dependency setup now happens via `installer/prerequisites/Aura-Prerequisites.ps1` instead. Don't "fix" this by inventing a `requirements.txt` without checking with the team first — confirm what the intended dependency list is.
