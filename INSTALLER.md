# Installer

Packaging and deployment.

## npm scripts

```
npm run stage         # scripts/stage-resources.js — stages native binaries for packaging
npm run check:docs    # scripts/check-docs-sync.js — fails if the two doc copies differ
npm run sync:docs     # same script with --fix: copies docs/ over installer/
npm run dist          # electron-builder installer — NSIS on Windows, AppImage + deb on Linux (predist runs `check:docs` + `stage`; postdist stages the .exe into installer/)
npm run dist:dir      # unpacked build output only, no installer (predist:dir runs the same two)
npm run stage:installer  # scripts/stage-installer.js — copy the built .exe into installer/ on its own (Windows only; skips elsewhere)
npm run build:prereq  # scripts/build-prereq-bundle.js — rebuilds installer/prerequisites.zip
```

## scripts/stage-installer.js

electron-builder writes to `dist/`, but `installer/` is the folder testers actually receive — `START HERE.txt`, `prerequisites.zip`, the documentation set and the `.exe`. Nothing moved the build into it, so that copy was done by hand and stopped being done. After the 0.7.0 build, `installer/` still held `Aura Installer v0.6.7.exe` while `START HERE.txt` told testers to run `v0.7.0` — a file that was not there, next to one the instructions did not mention.

Runs from `postdist`. It removes superseded `.exe` files from `installer/`, copies in the current one, and verifies the copy is byte-complete. The build output stays in `dist/`, so nothing it removes is unrecoverable.

Before touching anything it **hard-fails if `START HERE.txt` names a version other than the one just built** — the specific mistake that shipped, since the instructions named `v0.6.6` through an entire `0.6.7` release. A failure leaves the existing tester package untouched rather than half-updated.

The artifact filename is derived from `build.artifactName`, not hardcoded, so changing that template does not leave this looking for a file electron-builder no longer produces. The `.exe.blockmap` is deliberately not staged: it exists for differential auto-updates and Aura has no updater.

It also prunes superseded builds from `dist/`, which electron-builder never does on its own — three releases had accumulated at ~135 MB each. Only files sharing the current artifact's filename prefix (and their `.blockmap`s) are removed; `win-unpacked/`, `builder-effective-config.yaml` and anything else in `dist/` are left alone. Pruning happens **after** the current build is safely staged, so a failed copy never leaves `dist/` pruned and `installer/` wrong at the same time.

## scripts/check-docs-sync.js

The four end-user documents are maintained as byte-identical copies in `docs/Aura Documentation vX.Y/` and `installer/Aura Documentation vX.Y/`. Both are tracked; the `installer/` copy is the one testers receive, so a stale one ships wrong instructions inside a correct-looking build. They had already drifted once — both Install Guides still named `v0.6.6` while `package.json` was on `0.6.7`.

Runs from `predist`/`predist:dir`, so a release build fails rather than packaging a mismatch. It catches content differences, a file present on only one side, and the case where a version bump renamed one folder and not the other (every file inside can still match, which makes that the easiest kind to miss). The folder is found by its `Aura Documentation` prefix rather than a hardcoded version, so a bump doesn't leave the check passing against a directory that no longer exists.

`docs/` is the source of truth — this file points at that copy as the end-user install walkthrough. `npm run sync:docs` copies it over `installer/` and re-verifies; the direction is fixed on purpose, because merging would mean guessing which side is right and guessing wrong silently discards an edit.

## scripts/build-prereq-bundle.js

Zips `installer/prerequisites/` into `installer/prerequisites.zip`, with everything under a `prerequisites/` root (what testers extract). Run it whenever anything in that folder changes — the bundle ships **separately from the `.exe`**, so a new installer build does not pick up wizard changes on its own.

It exists because the bundle was hand-zipped and drifted: four of its nine files were stale against the folder before anyone noticed, and one hand-built copy shipped a stray `__pycache__/*.pyc`. Two guards:

- `__pycache__`, `.vs`, `obj`, `bin` and any `.pyc`/`.pyo` are excluded; an unexpected subdirectory logs a warning rather than being silently swallowed.
- It **hard-fails** if `installer/prerequisites/speech_server.py` differs from `services/speech/speech_server.py`. Those are maintained as duplicates and shipping a stale copy is this bundle's characteristic failure.

## scripts/stage-resources.js

Copies the binaries the installer needs into a tracked `native/runtime/` staging directory. On **Windows**, all 4:
- `AuraFrameBridge.exe` from `x64/Release`
- `VCamSample.exe` / `VCamSampleSource.dll` from `x64/Release`, falling back to `x64/Debug` with a warning
- The currently-running `node.exe` itself (the same standalone Node bundled to run `src/web/server.js` — see ARCHITECTURE.md for why Electron's own Node isn't used)

On **Linux**, only the Node runtime (staged as `node`, not `node.exe`). The three native binaries are Windows Media Foundation components with no Linux build, so they are skipped with a one-line notice rather than counted as missing — everything else Aura ships is portable JavaScript.

It's copy-only and non-destructive, skips byte-identical copies to keep git clean, and hard-fails (`process.exit(1)`) if a required binary is missing with no staged fallback available. It runs automatically via the `predist`/`predist:dir` npm hooks before `electron-builder` runs.

## electron-builder config (package.json `build`)

- `appId: com.aura.studio`, `productName: Aura`
- `artifactName: "Aura Installer v${version}.${ext}"` — overrides electron-builder's default `${productName} Setup ${version}.${ext}` NSIS naming. `package.json`'s version was reset to `0.6.5` to start a fresh, standardized numbering line; the installer file is now always `Aura Installer v<version>.exe`.
- `asar: false` — explicitly unpacked, because the native `.exe`/`.dll` extraResources and `better-sqlite3`'s native binding need real filesystem paths (Windows can't `CreateProcess` a path inside `app.asar`).
- `npmRebuild: false` — deliberately does not rebuild native modules for Electron's ABI; the bundled standalone `node.exe` is used instead (see ARCHITECTURE.md).
- `files`: `electron-main.js`, `electron-preload.js`, `package.json`, `.env.example`, `public/**/*`, `src/**/*`, `comfy/**/*`, `node_modules/**/*`.
  - Because `public/**/*` and `node_modules/**/*` are both included, the PaddleSeg ONNX model (`public/models/paddleseg/pp_humanseg.onnx`, 6.1 MB) and `onnxruntime-web` ship automatically — neither is an external prerequisite. `onnxruntime-web` is ~129 MB on disk, almost all of it alternative WASM builds (`jsep`, `asyncify`, `jspi`, plain) and 34 bundle variants, when the app only ever fetches two files. Since v0.6.7 the `files` list excludes `node_modules/onnxruntime-web/dist/**` and re-includes only `ort.webgpu.bundle.min.mjs`, `ort-wasm-simd-threaded.asyncify.mjs` and `ort-wasm-simd-threaded.asyncify.wasm` — packaged size 28 MB instead of 129 MB. The exclusion was verified by moving every other file out of the package and re-running the PaddleSeg suite, so it is measured rather than inferred; if a future ONNX runtime or execution provider is adopted, that list has to be revisited or the app will fail to load its WASM at runtime.
- `extraResources` is declared **per platform**, not globally, so a Linux build never demands files that cannot exist:
  - `win.extraResources`: the 4 staged `native/runtime/*` binaries → `resources/native/*.exe` and `resources/node.exe`.
  - `linux.extraResources`: `native/runtime/node` → `resources/node`.
- `win.target: nsis`, icon at `build/icon.ico`.
- `linux.target: [AppImage, deb]`, `category: AudioVideo`, icon at `build/icon.png` (the 256×256 PNG extracted losslessly from `icon.ico`, which already embedded it — electron-builder will not take an `.ico` for Linux). `linux.artifactName` overrides the global `"Aura Installer v${version}.${ext}"` with `"Aura-${version}-${arch}.${ext}"`, because the global one puts spaces in a `.deb` filename.
- `nsis`: `oneClick: false`, `perMachine: true`, user-choosable install directory, desktop + Start Menu shortcuts, `shortcutName: "Aura"`. `perMachine` is what makes the installer ask for admin rights, and it is required by `build/installer.nsh` (below), not a preference.

## build/installer.nsh

electron-builder picks this file up by name from `build/` and splices its two macros into the generated NSIS script. `customInstall` runs `regsvr32 /s` on `resources\native\VCamSampleSource.dll` so Windows can resolve the virtual camera's COM CLSID (copying the DLL alone leaves the camera absent, or black in an app that remembers a stale entry); `customUnInstall` unregisters it so an uninstall does not leave a CLSID pointing at a deleted file. The registration writes `HKLM\SOFTWARE\Classes`, which is why the install is per-machine. A failed registration is reported in the installer's details pane and does not abort the install, since Aura itself still runs without the camera device.

## First-run config seeding

On a packaged install, `electron-main.js` resolves `.env` to `<userData>/.env` (i.e. `%APPDATA%\Aura\.env`, capitalized per `productName`) and auto-seeds it from the bundled `.env.example` on first run if it doesn't already exist. `reportEnvHealth()` then validates required keys (`COMFYUI_WORKING_DIR`, `SPEECH_PYTHON`, etc.) and logs a banner if any are missing or invalid.

## External prerequisites (not bundled by electron-builder)

Aura depends on several external services/tools that are **not** packaged into the installer and must be present on the target machine: Ollama (with models pulled), ComfyUI (with checkpoints for `comfy/workflows/aura_background_api.json`), a Python venv for the speech service, and a SerpAPI key. `installer/prerequisites/Aura-Prerequisites.ps1` is the tester-facing wizard that sets these up (including creating the speech venv and installing `faster-whisper`/`flask`/`flask-cors`), and `installer/prerequisites/speech_server.py` is a copy of the speech service staged for that wizard.

**Keep `installer/prerequisites/speech_server.py` byte-identical to `services/speech/speech_server.py`.** They are maintained as duplicates; the installer copy is the one that reaches users.

### Whisper GPU acceleration (set up by the wizard)

`Setup-SpeechService` detects the GPU via `Get-GpuVariant` (the same helper that picks the ComfyUI portable build). On NVIDIA machines it additionally `pip install`s `nvidia-cublas-cu12` and `nvidia-cudnn-cu12` into the speech venv, then `Save-Config` writes `WHISPER_DEVICE=cuda` / `WHISPER_COMPUTE_TYPE=float16` — but only if `Test-WhisperCudaAvailable` confirms those wheels actually landed. AMD/Intel/no-GPU machines get empty values and fall back to CPU/int8 exactly as before. A failed GPU install is non-fatal: it degrades to CPU rather than breaking speech setup.

This avoids requiring a system-wide CUDA Toolkit + cuDNN install. The catch it works around: CTranslate2 lazy-loads cuBLAS from its own thread pool on first inference, and `os.add_dll_directory()` does not reach that thread on Windows — only `PATH` does. `speech_server.py` prepends the pip-installed DLL directories to `PATH` when `WHISPER_DEVICE=cuda`. Without that, `cuda` fails at the first transcription with `Library cublas64_12.dll is not found`, *after* the model appears to load fine.

`docs/Aura Documentation v0.7/Aura Packaged Install Guide.md` is the current end-user-facing installation walkthrough covering the installer plus each external prerequisite — treat it as the source of truth for end-user install steps; this file covers the packaging mechanics instead.

## Known stale script

`scripts/setup-dev.ps1` (a dev environment bootstrapper — creates `data/*` folders, verifies `node`/`python`/`ffmpeg`/`ffprobe` are on PATH, runs `npm install`) also tries `pip install -r requirements.txt`, but **no `requirements.txt` exists anywhere in the repo**. This step is currently broken/stale; the real Python dependency setup now happens via `installer/prerequisites/Aura-Prerequisites.ps1` instead. Don't "fix" this by inventing a `requirements.txt` without checking with the team first — confirm what the intended dependency list is.
