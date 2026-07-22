# Aura User Guide

Aura turns things you say or type into a searchable library of AI-generated
images, then uses your live speech to bring the right image up as your
virtual webcam background in real time. This guide covers every feature in
the app, organized the way you'll actually use them.

If you haven't installed Aura yet, see the
[Packaged Install Guide](Aura%20Packaged%20Install%20Guide.md) first —
Ollama, ComfyUI, and the speech service all need to be running before
anything below will work.

---

## The Basic Idea

1. **Capture** something — record your voice, type text, or import an image
   from the web. Aura turns it into a **record**: a summary, an AI-generated
   background image, and a set of **trigger phrases**.
2. Mark the record **Complete** so it's eligible to appear in Play Mode.
3. Turn on your camera and start **Play Mode**. As you talk, Aura listens,
   matches your words against every complete record's trigger phrases, and
   swaps your virtual camera background to the best match — live.

Everything below builds on that loop.

---

## 1. Studio — the main screen

Studio is where you run everything day-to-day: the camera, Play Mode, and
live display settings.

### Aura Camera

The large preview at the top is your **composited output** — camera feed
run through background segmentation, with the matched image behind you.
This is also what gets sent to the **Aura Camera** virtual webcam device, so
what you see here is what shows up in Zoom/Teams/OBS/etc. once you select
"Aura Camera" as your camera source in those apps.

**Webcam Live View** controls:
- **Camera Device** — pick which physical webcam to use.
- **Start Camera / Stop Camera** — begin or end the live feed.
- **Blur** — blur your real background instead of replacing it.
- **Remove BG** — cut your background to transparent/black with no
  replacement image.
- **Reset** — clear whatever effect is active and show the raw camera feed.

Your last-used camera mode (Blur, Remove BG, or an active semantic
background) is remembered and automatically reapplied the next time you
start the camera.

### Active Visual

A small preview of whichever image Play Mode most recently matched, along
with its match score. This is a **status readout**, not the composited
output — it updates the moment a new match is chosen, slightly ahead of
the camera transition finishing.

### Rolling Transcript

Shows the last few seconds of what Aura heard while Play Mode is running.
Useful for confirming your microphone is picking up speech correctly.

### Play Mode panel

- **Active Play Mode Group** — restrict matching to one Library Group, or
  leave it on "All Complete Records" to match against everything.
- **Microphone** — which mic to listen on.
- **Start Play Mode / Stop** — begin or end live speech matching.
- **Live Play Status** — shows whether Play Mode is listening.

See [section 5](#5-play-mode--how-live-matching-works) for how matching
actually works and how to tune it.

### Display & Transition

Controls how the matched image is composited into your camera feed:

- **Display Mode**
  - **1 Image** — a single full background, the classic virtual-background
    look.
  - **2 Images** — the two most recently matched images shown together.
  - **3 Images** — the three most recently matched images shown together.
  - **Aura Mode** — up to three images blended with soft, feathered edges
    (a primary image plus two supporting images), designed to look like a
    cohesive collage rather than tiled photos.
- **Transition Type**
  - **Instant** — the new background appears immediately.
  - **Fade** — the old background dips to black, then the new one fades in.
  - **Crossfade** — the old and new backgrounds dissolve directly into each
    other.
- **Transition Duration** — how long a Fade/Crossfade takes, in
  milliseconds.
- **Minimum Display Time** — the shortest amount of time a background stays
  on screen before Play Mode is allowed to switch it again, even if a new
  match comes in sooner. Prevents rapid flickering between images.
- **Minimum Match Score** — the lowest match confidence (0–1) that's
  allowed to trigger a background change. Raise this if Play Mode is
  switching images on weak/coincidental matches; lower it if it feels
  unresponsive.

### Activity Log & System Status

The Activity Log at the bottom is a running feed of what Aura is doing
(camera starts, transitions, saves, errors). System Status shows whether
the Aura database, Whisper, ComfyUI, and Ollama are all reachable — check
here first if something isn't working.

### Output Windows

In the left sidebar:

- **Aura Camera** — opens a separate window mirroring the composited
  camera output. Useful for window-capture in streaming/recording software
  as an alternative to the virtual camera device.
- **Slide Output** — opens a separate, clean full-screen window showing
  just the currently matched image(s), styled for presenting or
  screen-sharing without exposing the rest of the Aura interface.

---

## 2. Capture — creating new records

Capture is where you turn raw material into a record. There are three ways
in, and you can also add more images to a record later without going
through the whole pipeline again.

### Text Source

Paste or type text directly, then click **Generate Draft Record**. Aura
sends it to Ollama, which produces a summary, an image prompt, and trigger
phrases, then generates a background image via ComfyUI — all automatically.
The result is saved as a **draft** record.

### Audio Source

Click **Start Recording**, speak, then **Stop**. Click **Save Recording** to
transcribe it (via Whisper) and run it through the same summary → prompt →
trigger → image pipeline as Text Source. The transcript appears under
**Whisper Transcription** once processing finishes.

### Manual Record

For full control: fill in **Original Source Text**, **AI Summary**, **Image
Prompt**, and **Trigger Phrases** yourself, optionally **upload an existing
image** instead of generating one, then click **Save Complete**. This
record is saved as **complete** immediately (not draft) if an image is
attached — useful for hand-crafted entries you don't want Ollama rewriting.

### What happens automatically

Whichever path you use, Aura also detects the **language** you wrote or
spoke in and generates the summary and trigger phrases in that same
language (so Play Mode can match your own words back to them), while the
image-generation prompt is always produced in English, since the image
model performs best that way. This happens invisibly — you don't need to
configure anything for it.

---

## 3. Library — reviewing and organizing records

The Semantic Visual Library is where every record lives, complete or draft.

### Filtering

The **View** dropdown on the left switches between **All Complete
Records**, **All Draft Records**, **All Records**, or any specific **Group**
you've created.

### Groups

Groups let you organize records into named sets (e.g. "Space," "Music,"
"Philosophy") and restrict Play Mode to just one set at a time via the
Studio panel's "Active Play Mode Group" selector. To create one, enter a
**Group name** (and optional description) under **New Group** and click
**Create Group**.

### Record cards

Each card shows:
- A **COMPLETE** or **DRAFT** status badge. Only complete records are
  eligible to trigger in Play Mode.
- All images attached to the record, with **Open** (view full-size),
  **Make Primary** (choose which image displays by default for this
  record), **Record** (jump to the parent record — used from other views),
  **Move** (reassign this image to a different record), and **Delete
  Image** (soft-delete it — see [Trash](#trash--purge)).
- Editable fields — click the **✎** icon next to **Original Source Text**,
  **Image Summary**, **Image Prompt**, or **Cleaned Play Mode Trigger
  Text** to edit any of them inline. Editing the trigger text is
  particularly useful for tuning what phrases will match this record in
  Play Mode.
- A **Library Group** dropdown to assign or reassign the record's group.
- **Upload Image to This Record** to attach an additional image without
  creating a new record.
- **Mark Complete** — promotes a draft to complete. Aura checks that the
  record has source text, a summary, an image prompt, trigger text, and at
  least one active image before allowing this; it'll tell you what's
  missing if not.
- **Delete Entire Record** — permanently removes the record and all its
  data (this is immediate and does not go through Trash).

---

## 4. Image Search — importing from the web

For when you want to build your library from existing images rather than
generating new ones.

1. Enter a **Search Query** and set the **Batch Size** (how many results to
   import).
2. Optionally choose a **Target Group** so imports land pre-organized.
3. Click **Import Images**.

Each imported image becomes its own **draft** record — Aura downloads the
image locally (so Play Mode never depends on the internet at runtime),
generates a summary/prompt/trigger text from the search metadata via
Ollama, and detects the query's language the same way Capture does.
Imported records always start as drafts; review them in the Library and
mark them complete once you're happy with them.

---

## 5. Play Mode — how live matching works

While Play Mode is running, Aura listens in short overlapping chunks,
transcribes each with Whisper, and matches the rolling transcript against
every complete record's trigger text using two methods combined:

- **Keyword matching** — exact word overlap between what you said and a
  record's trigger phrases.
- **Semantic matching** — an Ollama embedding model compares meaning, so
  related phrases can match even without exact word overlap (e.g. "ocean"
  can match a record triggered by "sea"). This can be turned off in
  Settings, and automatically falls back to keyword-only matching if the
  embedding model isn't available.

The best-scoring record above your **Minimum Match Score** threshold wins,
subject to the **Minimum Display Time** cooldown described in section 1.
The chosen image is composited into the Aura Camera output using whichever
**Display Mode** and **Transition** you've configured.

**Tuning tips:**
- Getting matches on the wrong records? Raise Minimum Match Score, or edit
  the record's trigger text to be more specific.
- Play Mode feels sluggish to respond? Lower Minimum Display Time.
- Backgrounds changing on unrelated words? Disable semantic matching in
  Settings to require closer wording, or raise the match score threshold.
- **Speaking a language other than English and matching is poor?** The most
  common cause is transcription quality, not matching — check the Rolling
  Transcript in Studio to see whether Whisper actually heard you correctly.
  If the transcript is wrong, upgrading the speech model fixes it. Three
  `.env` settings meaningfully improve non-English results (speech model,
  text model, and embedding model) — see **section 2.3b** of the
  [Install Guide](Aura%20Packaged%20Install%20Guide.md). Nothing extra is
  required to *use* other languages; these only improve accuracy.

---

## 6. DB Manager — bulk record management

A spreadsheet-style view for managing many records at once, separate from
the card-based Library view.

- **View** — Refresh, filter by group, or delete the currently-filtered
  group (records in it become ungrouped, not deleted).
- **Selection** — Select All / Clear across the visible table, with a live
  count.
- **Bulk Actions** — with records selected: **Move Selected** to a
  different group, **Mark Complete**, or **Delete** (permanent, all
  selected records at once).
- **Portability** — **Export Selected** or **Export Group** downloads a
  `.zip` package (records, metadata, and images) you can back up or move
  between machines. **Import Package** loads one back in — if the group
  name already exists, the import is renamed automatically (e.g. "Space
  (Imported 2026-07-19)") so nothing overwrites your existing data.
- **Maintenance**:
  - **View Trash** — shows every soft-deleted image (from "Delete Image" in
    the Library) with the option to **Restore** any of them back to their
    record.
  - **Purge Deleted Images** — permanently erases every soft-deleted image
    and its file on disk. This cannot be undone; use View Trash first to
    make sure nothing in there should be restored.

### Trash & Purge

Deleting an individual image (from a Library record card) doesn't erase it
immediately — it's soft-deleted and recoverable via DB Manager → View Trash
until you explicitly Purge. Deleting an entire record, or a bulk delete in
DB Manager, is immediate and permanent and does not go through Trash.

---

## 7. Settings

- **Language** — sets the UI's display language. Aura ships with 17
  languages: English, Spanish, Chinese, Hindi, Arabic, Portuguese, French,
  German, Japanese, Russian, Korean, Italian, Turkish, Dutch, Polish,
  Vietnamese, and Ukrainian. Changing this only affects what language the
  interface is shown in — it doesn't affect what language your records are
  processed in (that's detected automatically per-record, as described in
  Capture).
- **Devices** — camera and microphone selection, mirrored with the pickers
  in Studio.
- **Presentation** — informational: display/transition values live in
  Studio and are shared everywhere, this panel just confirms that.
- **Matching & Generation**:
  - **Semantic matching (embeddings) in Play Mode** — toggle described in
    section 5.
  - **Ollama Model Override** — use a specific Ollama model for
    summaries/prompts/triggers instead of the built-in default. Must
    already be pulled in Ollama.
  - **Negative Prompt** — applied to every ComfyUI image generation, to
    steer away from unwanted content (default excludes text, watermarks,
    blur, and distortion).

---

## Quick Reference

| I want to... | Where |
|---|---|
| Turn my speech into a live background | Studio → Start Camera, then Start Play Mode |
| Create a new record from something I say | Capture → Audio Source |
| Create a new record from text | Capture → Text Source |
| Use my own image instead of generating one | Capture → Manual Record |
| Pull images from the web | Image Search |
| Fix a background that keeps mismatching | Library → edit that record's Trigger Text, or raise Minimum Match Score |
| Restrict Play Mode to a topic | Create a Group, assign records to it, select it in Studio |
| Recover an image I deleted | DB Manager → View Trash → Restore |
| Move records between machines | DB Manager → Export Selected/Group, then Import Package elsewhere |
| Change the app's display language | Settings → Language |
| See if a service (Ollama/ComfyUI/Whisper) is down | Studio → System Status |
