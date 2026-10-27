# Aura Roadmap

Long-term product direction.

**How to read this.** Every item below is a gap that already exists in the
code or a question the repository's own documentation leaves open — not a
wishlist. Each one cites where it comes from so it can be checked rather than
trusted. The grouping into near / medium / longer term is a proposal about
sequencing, not a commitment, and there are deliberately no dates.

Nothing here adds a capability Aura has not already set out to have. Features
that would contradict the project's philosophy — cloud dependencies, plugin
systems, speculative abstractions — are out of scope by default, per
`CLAUDE.md`.

---

## Near term

### Translation beyond the UI chrome

The largest gap between stated intent and shipped behaviour. `CLAUDE.md`
describes translation as "invisible, universal, local whenever practical."
`TRANSLATION.md` is blunt that today it is only a static UI-string
localization layer: user-generated content — record summaries, trigger texts,
transcripts — stays in whatever language it was created or spoken in, and no
code for translating spoken input or record content exists anywhere in `src/`.

"Universal" is therefore only partially true, and the subsystem doc says so
explicitly. Closing this means deciding what universal actually covers:
trigger-text matching across languages is the part that affects Play Mode
results, since a library recorded in one language will not match speech in
another. `OLLAMA_EMBED_MODEL` already accepts a multilingual embedding model
(`bge-m3`) as a partial answer for matching, which is worth settling before
building anything larger.

Source: `TRANSLATION.md:3`, `TRANSLATION.md:20`, `CLAUDE.md` §9.

### Code signing for the installer

The installer is unsigned, so Windows shows "Windows protected your PC" on
first run and testers are told to click through it. That is acceptable for
tester builds and not acceptable for general distribution — it is the single
most visible trust problem a new user hits.

Source: `README.md`, `installer/START HERE.txt`, `INSTALLER.md`.

### Third-party notices file

The licensing report's own checklist leaves this open: the MIT/BSD/Apache
dependencies shipped in the installer carry attribution obligations that are
currently satisfied nowhere in the packaged output. It also flags confirming
whether any of the 13 Apache-2.0 packages ship a `NOTICE` file that has to be
reproduced.

Both are mechanical to resolve and both are prerequisites for distributing
builds, not for publishing source.

Source: `docs/Aura Documentation v0.7/Aura Third-Party Licensing Report.md`
lines 162, 169.

---

## Medium term

### Linux virtual camera

Everything in Aura works on Linux except the camera device itself. The two
native components are Media Foundation / COM code with no Linux build, and
`VIRTUAL_CAMERA.md` is clear that the Linux answer is not a port of them: it
would be a `v4l2loopback` sink fed by the same composited frames.

Groundwork is already in place. `AURA_FRAME_PIPE_PATH` resolves to a Unix
domain socket under `userData`, so the Electron-side transport is ready —
nothing serves it. That makes this a well-bounded piece of work rather than an
architectural change.

Source: `VIRTUAL_CAMERA.md:5`, `ARCHITECTURE.md:14`.

### Linux prerequisites setup

The prerequisites wizard is PowerShell and `.bat`, so Linux users configure
Ollama, Python, FFmpeg and the speech venv by hand. Lower priority than the
camera: a Linux user without a virtual camera has less reason to install at
all, so these two are worth sequencing together.

Source: `ARCHITECTURE.md:15`, `README.md`.

### Finish extracting `server.js`

`src/web/server.js` still holds roughly 30 inline routes — record CRUD, DB
Manager stats, bulk operations, trash, export/import zip, image ownership —
that have not moved into services and repositories the way the conference,
play and system routes have. The pattern to follow already exists in
`src/web/routes/`; this is unfinished refactoring, not a redesign.

Source: `ARCHITECTURE.md:54`.

### Repository infrastructure

No `.github/` directory: no CI, no `SECURITY.md`, no `CONTRIBUTING.md`. CI
that runs `npm run check:docs` and at minimum parses every tracked JavaScript
file would have caught real classes of problem already. `CONTRIBUTING.md`
matters only once outside contributions actually arrive, so it can wait for
evidence that they will.

Also worth resolving: `installer/prerequisites.zip` is tracked alongside the
`installer/prerequisites/` folder it is generated from, so the two can drift.
Either build it in CI or check it in CI.

---

## Longer term

### macOS

Unsupported, with no work done. A macOS camera device is a different
mechanism again from both Media Foundation and `v4l2loopback`, so this is a
third implementation of the same seam rather than a port — worth attempting
only once the Linux sink has proven the seam holds.

Source: `README.md:67`.

### Replacing the committed native binaries with built artifacts

`native/runtime/` carries three prebuilt, unsigned Windows binaries so that a
clone has a working camera without Visual Studio. The tradeoff is that nobody
can verify they match the source. Building them in CI and attaching them to
releases removes the tradeoff — but only after there is CI to build them with,
which is why this sits behind the infrastructure item above.

---

## Standing constraints

Not tasks. Conditions that have to stay true, recorded here because breaking
one would be easy and expensive.

- **ComfyUI stays separately installed.** ComfyUI is GPL-3.0. Aura is safe
  today because it talks to a separately-installed program over local HTTP and
  redistributes nothing. Bundling ComfyUI into the installer would change the
  licensing position entirely.
  Source: Licensing Report §3, checklist line 173.

- **SerpAPI terms are unreviewed.** A paid service under its own ToS;
  commercial tier and the caching/display terms both need confirming before
  commercial use.
  Source: Licensing Report checklist line 172.

- **Local-first is not negotiable.** Cloud services stay optional, and no
  existing local capability gets replaced by an online one.
  Source: `CLAUDE.md` §7.

---

## Known dead code

`src/speech/transcribe.py` is a legacy standalone script using plain
`openai-whisper`. It was superseded by the Flask service in
`services/speech/` and is not invoked anywhere. It should be deleted rather
than carried, but deleting it is a change to make deliberately and verify, not
a drive-by.

Source: `ARCHITECTURE.md:52`.
