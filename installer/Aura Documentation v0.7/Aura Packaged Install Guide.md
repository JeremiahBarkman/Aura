# Aura Installation Guide (Packaged Build)

This guide covers installing Aura from the distributable installer
(`Aura Installer v0.7.1.exe`) rather than running it from source. It's for
testers who received the installer, not for development setup — see
`INSTALL.md` for that.

Aura itself installs in under a minute. Everything in this guide before
"Install Aura" is about the *external services* Aura talks to — those are
not bundled in the installer and need to already be running on the machine.

> **Shortcut for testers: run the Prerequisites Wizard instead.**
> The `Aura Prerequisites` folder ships a wizard
> (`Install Aura Prerequisites.bat`) that checks for everything below,
> installs the small tools for you (Ollama, Python, FFmpeg), sets up the
> speech service, and writes your `.env` — including fields to paste your
> SerpAPI key and, optionally, your PsySeg keys into (leave PsySeg empty and
> the wizard selects the license-free PaddleSeg engine). It also enables GPU
> acceleration for speech-to-text automatically on NVIDIA machines. For
> ComfyUI, the checkpoint, and a text
> model it detects what's missing and links you to the downloads (those are
> too large to auto-install). You can still follow the manual steps below
> if you prefer; the wizard just automates most of them.

---

## 1. System Requirements

- Windows 10 or 11 (64-bit)
- NVIDIA GPU strongly recommended (ComfyUI image generation is very slow on
  CPU)
- No administrator rights required to install Aura itself (per-user install)

---

## 2. Prerequisites — install and verify these BEFORE installing Aura

Aura's installer bundles Node.js and Aura's own native components. It does
**not** bundle Ollama, ComfyUI, or a Python environment for speech
transcription — those are separate tools you install once, the same way the
dev environment always has.

### 2.1 Ollama

Used for text summarization, image prompts, and trigger phrases.

1. Install from https://ollama.com
2. Pull a text model. **Aura's built-in default is:**
   ```powershell
   ollama pull hf.co/byteshape/Devstral-Small-2-24B-Instruct-2512-GGUF:latest
   ```
   If you'd rather use a different (or smaller) model, pull that instead and
   point Aura at it — either set `OLLAMA_MODEL` in your `.env`, or use
   **Settings → Matching & Generation → Ollama Model Override** in the app.
   Aura will fail on every Capture if the configured model isn't actually
   pulled, so make sure the name matches exactly what `ollama list` shows.

   > **Working in languages other than English?** Prefer a strong general
   > multilingual model such as `gemma3` or `qwen2.5` over a
   > coding-specialized one. Aura writes each record's summary and trigger
   > phrases *in the source language*, so the text model's multilingual
   > quality directly affects how well Play Mode matches your speech.

3. Pull the embedding model used by Play Mode semantic matching:
   ```powershell
   ollama pull nomic-embed-text
   ```
   (Optional but recommended — without it, Play Mode automatically falls
   back to exact keyword matching.)

   For libraries in languages other than English, use a multilingual
   embedding model instead: `ollama pull bge-m3`, then set
   `OLLAMA_EMBED_MODEL=bge-m3` in your `.env`.
4. Verify what you pulled is present:
   ```powershell
   ollama list
   ```
5. Default URL Aura expects: `http://127.0.0.1:11434`

### 2.2 ComfyUI

Used for AI image generation.

1. Install ComfyUI (see https://github.com/comfyanonymous/ComfyUI) with its
   own Python virtual environment.
2. Download the **`sdxl_lightning_4step.safetensors`** checkpoint and place
   it in ComfyUI's `models/checkpoints` folder. Get it from
   https://huggingface.co/ByteDance/SDXL-Lightning (the 4-step UNet/full
   checkpoint). **The filename must match exactly** — Aura's workflow
   requests this checkpoint by name, and ComfyUI will reject the job with
   an error if it isn't found.
3. Confirm ComfyUI starts and is reachable at `http://127.0.0.1:8188`
   (open that URL in a browser — you should see the ComfyUI UI).
4. Note the full paths to:
   - The ComfyUI working directory (e.g. `C:\AI\ComfyUI`)
   - `python.exe` inside ComfyUI's venv (e.g.
     `C:\AI\ComfyUI\venv\Scripts\python.exe`)
   - ComfyUI's output folder (e.g. `C:\AI\ComfyUI\output`)

   You'll need these exact paths in step 4 below.

#### About the workflow — you do NOT need to build one

A common misunderstanding: you don't have to open ComfyUI and construct a
workflow by hand. **Aura ships its own workflow** at
`comfy/workflows/aura_background_api.json` and submits it to ComfyUI's
`/prompt` HTTP API on every generation. ComfyUI acts purely as a rendering
backend — it doesn't need anything loaded in its browser UI, and it can sit
on a blank canvas the whole time Aura is running.

What ComfyUI *does* need is only:

- **The checkpoint from step 2**, named exactly `sdxl_lightning_4step.safetensors`.
- **Stock nodes only.** The bundled workflow uses `CheckpointLoaderSimple`,
  `CLIPTextEncode`, `EmptyLatentImage`, `KSamplerAdvanced`, `VAEDecode`, and
  `SaveImage` — all built into ComfyUI. **No custom nodes or extensions are
  required.** If you've installed custom node packs, they're harmless but
  unnecessary.

If image generation fails, the two overwhelmingly likely causes are a
missing/misnamed checkpoint, or ComfyUI not running at the configured
`COMFYUI_URL`.

#### Optional: replacing Aura's workflow with your own

Only relevant if you want a different visual style or a different base
model. Replace the contents of `comfy/workflows/aura_background_api.json`
(in your Aura install folder — see the User Guide for its location).

Your replacement **must be API-format JSON**, which is *not* the same as the
workflow format ComfyUI saves by default:

- **API format** is a flat JSON object keyed by node ID — this is what the
  `/prompt` endpoint accepts and what Aura requires.
- To produce it: in ComfyUI, enable **Settings → Enable Dev Mode Options**,
  then use **Workflow → Export (API)**. A normal "Save" produces UI-format
  JSON that will **not** work.

Reference examples:

- **API format (the format Aura needs)** —
  https://github.com/comfyanonymous/ComfyUI/blob/master/script_examples/basic_api_example.py
  contains a complete API-format prompt inline; it's the canonical example
  of the structure.
- **Workflow examples to start from (SDXL and others)** —
  https://github.com/comfyanonymous/ComfyUI_examples (see the `sdxl`
  folder). Note these are UI-format workflows embedded in PNGs: load one
  into ComfyUI, then re-export it via **Export (API)** to get the format
  Aura can use.

For Aura to drive your custom workflow, it must contain:

| Requirement | Why |
|---|---|
| At least one node with a `text` input (e.g. `CLIPTextEncode`) | Aura injects the generated image prompt here |
| A negative-prompt node whose `_meta.title` contains the word **"negative"** | How Aura tells positive from negative; without it your negative prompt node gets overwritten with the positive prompt |
| A node with a `seed` or `noise_seed` input | Aura randomizes it each run so repeated prompts don't produce identical images |
| A `SaveImage` node | Aura reads the finished file from ComfyUI's output folder |

### 2.3 Speech transcription (Whisper)

Used to transcribe recorded audio and to drive live Play Mode matching.

1. Set up a Python virtual environment anywhere on the machine and install:
   ```powershell
   pip install flask flask-cors faster-whisper
   ```
2. Note the full paths to that venv's `python.exe` and to
   `speech_server.py` (copy this file from the Aura source repo's
   `services\speech\speech_server.py` if you don't already have a copy —
   it's a small standalone Flask service, not something the installer
   bundles).
3. You'll need both paths in step 4 below.

**No extra download is needed for multilingual speech.** Whisper's default
`base` model is already multilingual — it auto-detects roughly 99 spoken
languages, and the model file downloads itself on first run. You can speak
any supported language and Aura will transcribe it and record it in that
language.

**If non-English transcription is inaccurate**, the `base` model is the
likely cause — it's the fastest size, not the most accurate, and the quality
gap is much wider for non-English speech. Upgrade by adding this to your
`.env` (no code editing required):

```env
WHISPER_MODEL=small     # better non-English accuracy, still CPU-practical
# WHISPER_MODEL=medium  # best accuracy, slower and more RAM
```

The larger model downloads automatically the next time the speech service
starts. Two cautions:

- **Never use the `.en` variants** (`base.en`, `small.en`) — those are
  English-only and will break language detection.
- If you have a working CUDA setup and want a larger model to stay fast,
  also set `WHISPER_DEVICE=cuda` and `WHISPER_COMPUTE_TYPE=float16`.

### 2.3b Using Aura in languages other than English

Aura supports non-English use end to end, and **nothing extra is strictly
required** — the defaults work in any supported language. But three settings
materially improve quality, and all three are `.env` changes, not new
software:

| What | Default | Better for non-English |
|---|---|---|
| Speech recognition | `WHISPER_MODEL=base` | `WHISPER_MODEL=small` or `medium` |
| Text model (summaries/triggers) | Devstral (code-focused) | `gemma3` or `qwen2.5` via `OLLAMA_MODEL` |
| Semantic matching | `nomic-embed-text` (English-centric) | `bge-m3` via `OLLAMA_EMBED_MODEL` |

How it works once configured:

- Whisper **auto-detects the spoken language** — you don't select it
  anywhere. Each record stores the language it was captured in.
- Summaries and **trigger phrases are generated in the source language**, so
  Play Mode matches the words you actually speak.
- **Image prompts are always generated in English**, because the image model
  produces better results that way — this is automatic and doesn't affect
  what you see in the app.
- Keyword matching works in **any** language, including Chinese, Japanese,
  and Korean (which don't use spaces between words). Semantic matching
  quality depends on the embedding model, hence the `bge-m3` suggestion.

The **app interface language** is separate and set in
**Settings → Language** (17 languages available). It does not affect how
your records are processed.

### 2.4 PsySeg SDK license — optional

Used by the **PsySeg** background-segmentation engine. If you have one, you
need a valid license key, access key, and access token for the
`@personifyinc/psyseg-sdk` package. Contact whoever manages the PsySeg
license — there's no self-serve signup.

**This is no longer required.** Aura ships a second segmentation engine,
**PaddleSeg**, which runs a bundled ONNX model on your GPU and needs no
license. Blur, Remove Background and Replace Background all work the same
on either engine.

If you leave the PsySeg fields empty, the prerequisites wizard selects
PaddleSeg for you, so background segmentation works on a fresh install with
no license at all. You can switch engines any time in
**Settings → Segmentation → Engine** (the change applies the next time you
start the camera).

### 2.5 SerpAPI key

Used for the image search / image import feature. Sign up at
https://serpapi.com and generate an API key.

---

## 3. Install Aura

1. Run `Aura Installer v0.7.1.exe`.
2. Follow the installer (per-user install, no admin prompt). You can change
   the install location if you want; Desktop and Start Menu shortcuts are
   created by default.
3. Do **not** launch Aura yet — configure `.env` first (next step), or the
   app will start with blank service URLs and licensing missing.

---

## 4. Configure your environment

Aura's installer does not ship your (or anyone else's) real API keys and
machine-specific paths — that data is specific to each install and is kept
out of the installer for security. Instead:

1. Launch Aura once from the Desktop or Start Menu shortcut. On first run it
   automatically creates:
   ```
   %APPDATA%\aura\.env
   ```
   seeded from a blank template. (This file lives in your user data folder,
   *not* the install directory, so it survives future Aura updates.)
2. Close Aura.
3. Open `%APPDATA%\aura\.env` in a text editor and fill in every value using
   what you gathered in section 2:

   ```env
   PSYSEG_LICENSE=<your license>
   PSYSEG_ACCESS_KEY=<your access key>
   PSYSEG_ACCESS_TOKEN=<your access token>

   SERPAPI_KEY=<your serpapi key>

   PORT=5150

   OLLAMA_URL=http://127.0.0.1:11434
   COMFYUI_URL=http://127.0.0.1:8188
   WHISPER_URL=http://127.0.0.1:8765

   COMFYUI_AUTOSTART=true
   COMFYUI_WORKING_DIR=<path to your ComfyUI folder>
   COMFYUI_PYTHON=<path to ComfyUI's venv python.exe>
   COMFYUI_OUTPUT_DIR=<path to ComfyUI's output folder>

   SPEECH_PYTHON=<path to your speech venv's python.exe>
   SPEECH_SCRIPT=<path to speech_server.py>
   ```

   Optional, for non-English use (see section 2.3b):

   ```env
   OLLAMA_MODEL=gemma3          # multilingual text model
   OLLAMA_EMBED_MODEL=bge-m3    # multilingual semantic matching
   WHISPER_MODEL=small          # better non-English transcription
   ```
4. Save the file.

---

## 5. Launch and verify

1. Launch Aura from the Desktop or Start Menu shortcut.
2. Confirm:
   - The Aura window opens with the Aura icon (not a generic Electron icon).
   - `http://localhost:5150` loads the Aura UI (Aura hosts this itself; you
     don't need to open a browser, but it's a useful check if something
     seems wrong).
   - The Semantic Visual Library loads without an error banner.
3. If `COMFYUI_AUTOSTART=true`, Aura launches ComfyUI itself — give it a
   minute on first run while it loads the checkpoint.
4. Try Record Mode once end-to-end (record → transcribe → summarize →
   generate image) to confirm all four external services are wired up
   correctly.

---

## 6. Troubleshooting

**"Could not load records" / a JSON parse error mentioning `<!DOCTYPE`**
The local web server isn't responding as expected — usually means a second
copy of Aura is already running (check Task Manager for extra `Aura.exe` or
`node.exe` processes and end them), or the server hasn't finished starting
yet. Aura's single-instance lock should prevent two full copies running at
once; if you see this, fully close all Aura-related processes and relaunch.

**Library loads but images show broken thumbnails**
Close Aura, confirm `%APPDATA%\aura\images\manual` and
`%APPDATA%\aura\images\imports` exist and contain files, then relaunch.

**"AuraFrameBridge.exe was not found" or camera output doesn't work**
Confirm the install completed fully (native components ship inside the
installer's `resources\native` folder) and that no antivirus quarantined
those executables.

**Image generation fails / Capture never produces an image**
Check these in order:
1. **Is ComfyUI running** and reachable at the `COMFYUI_URL` in your `.env`?
   Open that URL in a browser to confirm.
2. **Is the checkpoint present and named exactly**
   `sdxl_lightning_4step.safetensors` in ComfyUI's `models/checkpoints`
   folder? A missing or renamed checkpoint is the most common cause —
   ComfyUI rejects the job and Aura reports the failure.
3. **Does `comfy/workflows/aura_background_api.json` exist** in your Aura
   install folder? It ships with the app; if it's missing (or you replaced
   it with an invalid file), generation can't start. Reinstalling restores
   it.
4. Confirm the Ollama model that generates the *image prompt* is working —
   if the prompt step fails, generation never gets as far as ComfyUI.

**Ollama / ComfyUI / Whisper unreachable warnings in the console**
Start that service manually and confirm it's listening on the URL
configured in `.env` (sections 2.1–2.3 above) before launching Aura.

**Uninstalling**
Your data (`aura.db`, images, config) lives in `%APPDATA%\aura` and is
**not** removed by uninstalling Aura through Windows Settings — reinstalling
later will pick your data back up automatically.
