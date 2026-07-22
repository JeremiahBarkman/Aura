# Vendored: VCamSample

`VCamSample/` is a **vendored** copy of Microsoft's virtual-camera sample,
modified for Aura. It is committed here as ordinary files, not as a submodule.

| | |
|---|---|
| Upstream | https://github.com/smourier/VCamSample |
| Upstream commit | `ae42a88` ("Updated C++/WinRT nuget") |
| Aura commit on top | `3fab24b` |
| License | MIT — see `VCamSample/LICENSE` |

## Why vendored rather than a submodule

It arrived as a nested git clone, which git will not recurse into: committing
it from the parent repo would have silently created a *gitlink* — a pointer to
`ae42a88` with no source behind it. That looks fine locally and clones as an
empty directory for everyone else.

A submodule would have been the textbook answer, but a submodule records only a
commit pointer, so it would still need the Aura changes pushed to a fork
somewhere reachable. Vendoring keeps the repository self-contained and
buildable with no external dependency.

## What Aura changed

The upstream sample generates synthetic frames. Aura's build consumes real
frames from `AuraFrameBridge` over TCP `127.0.0.1:5151`:

- `VCamSampleSource/TcpFrameClient.{h,cpp}` — new; reads frames from the bridge
- `VCamSampleSource/AuraSharedMemory.{h,cpp}` — new; shared-memory frame buffer
- `VCamSampleSource/FrameGenerator.cpp` — rewired to render Aura frames
- `VCamSampleSource/VCamSampleSource.vcxproj` (+ `.filters`) — new sources added
- `VCamSampleSource/framework.h`, `MediaStream.cpp`, `*.rc` — supporting edits

The complete diff against upstream is preserved in
`aura-vcamsample-changes.patch` (generated with `git format-patch ae42a88..`).

## Updating from upstream

The nested `.git` was moved out of the working tree when this was vendored, so
there is no live upstream link. To take a newer upstream version:

```
git clone https://github.com/smourier/VCamSample.git /tmp/vcam
cd /tmp/vcam
git am < <aura>/native/external/aura-vcamsample-changes.patch   # replay Aura's changes
```

Resolve any conflicts, build, then copy the result back over
`native/external/VCamSample/` and re-run `npm run stage`.

## Building

Open `VCamSample/VCamSample.sln` in Visual Studio (x64). The binaries Aura
ships are staged into `native/runtime/` by `scripts/stage-resources.js`, which
runs automatically as part of `npm run dist`.
