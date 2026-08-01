# Aura Architecture

Current system architecture and execution flow. This is a factual description derived from reading the code — it is not aspirational and should be kept in sync when the underlying code changes.

## Process model

`electron-main.js` is a process orchestrator only — it contains no application logic. It spawns and supervises up to 5 child processes and points a `BrowserWindow` at them:

1. **`serverProcess`** — the actual app backend, `src/web/server.js` (Express + better-sqlite3), run via a **bundled standalone `node.exe`** rather than Electron's own Node, because Electron's Node ABI doesn't match the precompiled `better-sqlite3` binding. The main window loads `http://localhost:5150`.
2. **`comfyProcess`** — ComfyUI (`python main.py --listen`), autostarted if `COMFYUI_AUTOSTART=true` and port 8188 is free.
3. **`speechProcess`** — `services/speech/speech_server.py`, a Flask app wrapping `faster_whisper`, listening on `127.0.0.1:8765`. Node talks to it over plain HTTP (`src/speech/localWhisperService.js`), not a subprocess call per request.
4. **`auraFrameBridgeProcess`** — `native/AuraFrameBridge.exe`, started on demand via IPC. See VIRTUAL_CAMERA.md.
5. **`auraCameraHostProcess`** — `native/VCamSample.exe`, also on demand. See VIRTUAL_CAMERA.md.

A second `BrowserWindow` (`createOutputWindow`, loading `/aura-output/`) is a clean output surface for screen-sharing, independent of the main UI window.

`src/electron/sessionTracker.js` records spawned child PIDs to `data/run/aura-session.json` so a crashed session's orphaned children (Windows recycles PIDs, so matching also checks process name + command-line substring) get cleaned up on next launch. `stopAuraServices()` tree-kills everything (`taskkill /F /T`) on quit. `npm start` (`node src/web/server.js`) runs only process 1, with no Electron shell and no camera/native/speech/ComfyUI stack — useful for iterating on web/API/DB code alone.

## src/ module map

- **`src/config`** — `paths.js` (single source of truth for data paths, `AURA_DATA_DIR` env override in packaged builds) and `auraConfig.js` (JSON-backed app settings at `data/config/aura-config.json`, guarded by a strict `allowedKeys` allowlist — camera device, display/transition timing, segmentation engine, PsySeg erode/blur, Play Mode semantic-matching toggle, Ollama model override, UI language).
- **`src/db`** — `connection.js` (opens `better-sqlite3`, WAL mode), `schema.sql`, `repositories/*` (thin per-table CRUD: `sourceRepository.js`, `summaryRepository.js`, `triggerTextRepository.js`, `generatedImageRepository.js`).
- **`src/electron`** — `sessionTracker.js` only.
- **`src/image`** — `comfyUiService.js`: loads the workflow template from `comfy/workflows/`, injects prompts/seeds, POSTs to ComfyUI's `/prompt`, polls `/history/{id}`, copies the generated image out of ComfyUI's volatile output folder into `data/images/generated` so Library entries survive ComfyUI cleanup.
- **`src/import`** — `serpApiImageSearchService.js` (SerpAPI image search), `imageEnrichmentService.js` (Ollama call turning search metadata into summary/prompt/trigger text), `imageSearchImportService.js` (orchestrates download → enrichment → DB insert as `draft`, concurrency-limited to 3).
- **`src/llm`** — `ollamaService.js` (record-mode text products via Ollama `/api/generate`, JSON mode), `embeddingService.js` (Ollama `/api/embed` for Play Mode semantic matching, 60s failure cooldown, vectors stored as raw `Float32Array` buffers).
- **`src/play`** — `playModeService.js` (live matching engine: `max(keywordScore, semanticScore)`, embeddings cached in `trigger_embeddings`), `semanticMatcher.js` (keyword overlap with CJK bigram tokenization), `SceneSlotManager.js` (1–3 on-screen slots with primary-promotion logic, plus `clearSlots()` backing Play Mode's Clear Scene), `transcriptBuffer.js` (rolling recent-speech buffer for the UI).
- **`src/record`** — `recordModeService.js`: the Capture pipeline orchestrator (see "Record → Play pipeline" below).
- **`public/segmentation`** — the live segmentation modules (Express serves `public/` statically; there is no `src/segmentation` — the unused duplicate there was removed). `SegmentationProvider.js` is the abstract contract; `PsySegSegmentationProvider.js` (licensed Personify SDK) and `PaddleSegSegmentationProvider.js` (ONNX PP-HumanSeg via `onnxruntime-web`, WebGPU with WASM fallback) implement it; `createSegmentationProvider.js` is the registry that maps an engine id to a provider and lazy-imports it, so picking one engine never loads the other's runtime. The engine is chosen by the `segmentationEngine` config key (Settings → Segmentation); an unknown value falls back to `psyseg` rather than leaving the user with no camera.
- **`src/speech`** — `localWhisperService.js` (the live HTTP client used by `recordModeService.js`) and `transcribe.py` (legacy standalone script using plain `openai-whisper`, superseded by the Flask service, not invoked anywhere).
- **`src/text`** — `stopwordService.js`: Unicode-aware trigger-text cleanup (strips top-50 English stopwords only when text is mostly Latin script).
- **`src/web`** — `server.js` (Express app) plus `routes/systemRoutes.js` (health checks for Whisper/ComfyUI/Ollama, `auraConfig` CRUD, PsySeg credential handoff at `/api/config/psyseg`, library groups) and `routes/playRoutes.js` (`/api/play/match`, scene-slot endpoints). `server.js` itself still keeps ~30 inline routes (record CRUD, DB Manager stats/bulk-ops/trash/export-import-zip, image ownership) that haven't been extracted into services/repositories yet.

## Record → Play pipeline

`src/record/recordModeService.js` ties together: Whisper transcription (`src/speech`) → Ollama summary/image-prompt/trigger-text generation (`src/llm/ollamaService.js`) → stopword cleanup (`src/text/stopwordService.js`) → ComfyUI image generation (`src/image/comfyUiService.js`, mutating the single workflow template at `comfy/workflows/aura_background_api.json` — a two-stage SDXL base+refiner graph) → writes across `src/db/repositories/*`.

At play time, `playRoutes.js` → `src/play/playModeService.js` does hybrid keyword+semantic matching against stored triggers, using `src/llm/embeddingService.js` and `src/play/semanticMatcher.js`. `SceneSlotManager.js` manages which matched image(s) are currently on screen.

The published scene lives in `sceneState.activeAuraScene`, which both the camera (`syncCameraToActiveScene` in `public/index.html`) and the Slide Output window (`pollActiveScene`, 750 ms poll) read. **Both deliberately ignore an empty/null scene and keep displaying the last one** — so clearing server state alone changes nothing on screen. `POST /api/play/scene-slots/clear` (Play Mode's Clear Scene) therefore has a client half: the camera is explicitly transitioned to an empty background and the Slide Output fades its layers out. Anything else that needs to blank the stage must do the same.

## Database

`better-sqlite3` at `data/aura.db` (WAL mode, foreign keys on). Schema in `src/db/schema.sql`, applied idempotently (`CREATE TABLE IF NOT EXISTS`) on every boot. **There is no migration framework** — column additions to existing tables are done via ad-hoc `ensureColumn()` calls directly in `server.js`.

Tables:
- `source_items` — one row per record (audio/text/image-search/manual origin), `record_status` (draft/complete), `group_id`, `primary_image_id`, `language`.
- `summaries` — LLM-generated summary + image prompt per source item.
- `trigger_texts` — original + stopword-cleaned trigger phrase used for Play Mode matching.
- `generated_images` — one or more images per record, soft-deleted via `deleted_at`, with `is_active`/`is_favorite` flags.
- `library_groups` — user-defined folders/categories.
- `image_search_imports` — provenance metadata (SerpAPI query/title/source/link) for imported images.
- `trigger_embeddings` — cached `Float32Array` embedding blobs for Play Mode semantic matching, invalidated on trigger-text edit.

`data/` also holds non-DB runtime artifacts: `data/audio/*.webm`, `data/images/{generated,imports,manual,backgrounds}`, `data/imports/*.zip` (DB-Manager export/import packages), `data/config/aura-config.json`, `data/run/aura-session.json`.

## Config layering

Two separate, non-overlapping systems:
- **`.env`** — deployment/machine config and secrets (PsySeg license/keys, SerpAPI key, service URLs/ports, Python interpreter paths, Whisper model size). Loaded via `dotenv` in `server.js`; `electron-main.js` resolves a different path per environment (dev: next to `electron-main.js`; packaged: `<userData>/.env`, auto-seeded from `.env.example` on first run) and validates required keys at startup.
- **`data/config/aura-config.json`** (via `src/config/auraConfig.js`) — end-user app preferences edited through in-app Settings, gated by the `allowedKeys` allowlist.

## Shared frontend rendering logic

`public/rendering/DisplaySceneMapper.js` is a plain ES module (loaded via `<script type="module">` and exposed as `window.DisplaySceneMapper`) holding the scene-slot placement logic (`getEffectiveSceneMode`, `getDisplaySlotsForMode`, `applyDisplayModeToScene`, etc.) shared between the Studio camera compositor (`public/index.html`) and Slide Output (`public/aura-slide-output/index.html`). It replaced two near-identical inline copies of the same logic — this is the one piece of `public/` frontend code with its own module boundary; everything else UI-side is inline `<script>` in the HTML files themselves (see "Known duplication" below for what's still copy-pasted).

## Known duplication in the codebase

- **Segmentation provider** still exists in two copies: `public/segmentation/PsySegSegmentationProvider.js` (live) and `public/js/PsySegBrowserProvider.js` (used only by `public/compositor-test/`). The third copy under `src/segmentation/` has been deleted. Note that `PaddleSegSegmentationProvider.js` necessarily repeats the render loop, background caching and transition logic from the PsySeg provider — the `SegmentationProvider` contract covers per-frame orchestration as well as segmentation, so a second engine cannot share it without extracting that orchestration into a common host.
- **`localWhisperService.js`** exists at both `src/speech/localWhisperService.js` (live, 122 lines) and `services/speech/localWhisperService.js` (stale duplicate, 40 lines, not required anywhere).
- **`native/AuraFrameBridge/CMakeLists.txt`** builds PoC executables (`AuraFrameWriter`/`AuraFrameReader`) from a `src/` folder that no longer exists in the tree — dead scaffolding, not the real native build.
