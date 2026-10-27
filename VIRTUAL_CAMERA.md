# Virtual Camera

Native virtual camera architecture. This is Aura's core product feature — a real Windows virtual camera device that other apps (Teams/OBS/Zoom/Camera app) can select, fed by frames composited inside Aura.

**Windows only.** Both native components below are Media Foundation / COM code with no Linux build, and the Linux equivalent would not be a port of them — it would be a v4l2loopback sink fed by the same composited frames. On Linux, `aura-native:ensure-running` returns an explicit "the Aura virtual camera is Windows-only" error and everything else in Aura (Studio, Play Mode, the Slide Output window, segmentation) works normally. `AURA_FRAME_PIPE_PATH` resolves to a Unix domain socket in `userData` there so the Electron-side transport is ready for a Linux bridge, but nothing serves it today.

## Stack

Two native C++ projects plus a vendored third-party base:

- **`native/AuraFrameBridge/`** — Aura's own code (`AuraFrameBridge.vcxproj`, MSVC). `main.cpp` starts two threads: a `NamedPipeServer` listening on `\\.\pipe\AuraFrameBridgePipe` (receives frames from Electron) and a `TcpFrameServer` listening on `127.0.0.1:5151` (serves frames to the camera host). `FrameBuffer` holds the last-received frame so the TCP side always has something to serve even if Electron stalls.
- **`native/external/VCamSample/`** — a **vendored fork** of Microsoft's public `VCamSample` (see `native/external/VENDORED.md`: upstream `github.com/smourier/VCamSample` @ `ae42a88`, patched on top, committed as plain files rather than a submodule/gitlink to avoid nested-git issues). Aura's additions:
  - `VCamSampleSource/TcpFrameClient.{h,cpp}` — connects to AuraFrameBridge's TCP port 5151 and pulls the latest frame, using a "copy only if newer" optimization keyed by frame number.
  - `FrameGenerator.cpp` rewired to render real Aura frames instead of synthetic test patterns.
  - `AuraSharedMemory.h/cpp` (Direct2D `DrawLatestFrame`) exists but is a secondary/diagnostic render path, not the primary transport — the primary transport is the TCP client.

## Wire protocol

A 44-byte header followed by raw pixel bytes:

```
magic       'AURA'
version
width
height
stride
format       (1 = BGRA32)
frameNumber  u64
timestampMs  u64
dataSize
```

Implemented identically in two places that **must stay in sync**:
- `electron-main.js` — `buildAuraFrameParts()` / `AURA_FRAME_HEADER_SIZE = 44`
- The C++ `AuraTcpFrameHeader` struct (`static_assert(sizeof == 44)`)

Changing the header shape on one side without the other silently breaks the camera pipeline (frames will misparse rather than throw).

## Electron ↔ native communication

Electron main process is a **named-pipe client** to AuraFrameBridge (`connectAuraFramePipe()`), keeping the pipe open for the whole session (`allowHalfOpen: true`, since the pipe is `PIPE_ACCESS_INBOUND`-only on the server side). Electron health-checks/launches the two native `.exe`s by probing TCP port 5151 rather than talking to them over IPC/pipe for control — it just spawns/kills the processes and hides `VCamSample.exe`'s stray windows via a PowerShell + Win32 `EnumWindows`/`ShowWindow` script.

## Frame pipeline end to end

Camera frame → `PaddleSegSegmentationProvider` (background blur/remove/replace, runs in the **renderer/browser**) → composited with the current Play-Mode-matched image rendered by `public/rendering/SceneRenderer.js` → sent to Electron main over the `aura-frame-export:send-frame` IPC call → written to `\\.\pipe\AuraFrameBridgePipe` → `AuraFrameBridge.exe` re-serves the latest frame over TCP on `127.0.0.1:5151` → `VCamSample.exe`'s `TcpFrameClient` pulls it and renders it as the virtual camera device.

## Build

No CMake/top-level build orchestration for the real product:
- `AuraFrameBridge.vcxproj` and `VCamSample.sln` are built manually in Visual Studio (`x64/Release` or `x64/Debug`).
- `native/AuraFrameBridge/CMakeLists.txt` exists but builds unrelated PoC executables (`AuraFrameWriter`/`AuraFrameReader`) from a `src/` folder that doesn't exist in the current tree — dead scaffolding, not the real build.
- `native/external/VENDORED.md` documents how to re-sync with upstream VCamSample via `git format-patch`/`git am` with `aura-vcamsample-changes.patch`. Don't hand-edit `native/external/VCamSample/` outside that process.
- `scripts/stage-resources.js` copies the built `Release` binaries (falling back to `Debug` with a warning) plus the currently-running `node.exe` into `native/runtime/` (a tracked, curated directory, not a build-output dir) — this is what `package.json`'s `extraResources` ships in the installer. See INSTALLER.md.

## Dev-loop scripts

Both hardcoded to `C:\Projects\aura` and the `x64\Debug` build path:

- **`native/Start-AuraNative.ps1`** — kills any existing `AuraFrameBridge`/`VCamSample` processes, launches both from `x64\Debug` in separate PowerShell windows, then opens the Windows Camera app to visually confirm the virtual camera is producing frames.
- **`native/Restart-VCam.ps1`** — kills Windows Camera + `VCamSample`, re-registers `VCamSampleSource.dll` via `regsvr32 /s` (elevated), restarts `VCamSample.exe` — the fix for when the COM/Media-Foundation source registration gets stuck (needed after rebuilding `VCamSampleSource.dll`, or when the virtual camera stops being recognized by consumers).

`native/docs/adr/ADR-000-README.md` is only the ADR-format template — no populated ADRs currently exist under `native/docs/adr/`.

## Historical note

`docs/LegacyDocs.zip` contains draft v0.1 docs (`Aura_Native_Architecture.md`, `Aura_Frame_Transport_Specification.md`, `Aura_Native_Development_Guidelines.md`) describing an aspirational from-scratch native layer (`AuraNative.slnx` with sibling `AuraFrameBridge`, `AuraVirtualCamera`, `AuraDiagnostics`, `AuraInstaller` projects). **This was never built.** The actual implementation uses the vendored Microsoft `VCamSample` fork described above instead of a bespoke `AuraVirtualCamera` project, and there is no `AuraDiagnostics`/`AuraInstaller` project in the tree. Treat those legacy docs as historical design intent, not a description of what's on disk today.
