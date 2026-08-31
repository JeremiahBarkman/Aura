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

**Webcam Live View** controls, left to right:
- **Camera Device** — pick which physical webcam to use.
- **Start Camera / Stop Camera** — begin or end the live feed.
- **Remove BG** — cut your background to transparent/black with no
  replacement image.
- **Blur** — blur your real background instead of replacing it.
- **Reset** — clear whatever effect is active and show the raw camera feed.

Your last-used camera mode (Blur, Remove BG, or an active semantic
background) is remembered and automatically reapplied the next time you
start the camera.

### Active Visual

A small preview of whichever image Play Mode most recently matched. This is
a **status readout**, not the composited output — it updates the moment a
new match is chosen, slightly ahead of the camera transition finishing.

### Right-hand panel: Play Mode, Rolling Transcript, Active Background Match

- **Play Mode panel**:
  - **Active Play Mode Group** — restrict matching to one Library Group, or
    leave it on "All Complete Records" to match against everything.
  - **Microphone** — which mic to listen on.
  - **Start Play Mode / Stop** — begin or end live speech matching. The mic
    icon next to the panel title lights up while Play Mode is actively
    listening.
  - **Clear Scene** — empties every filled scene slot and returns the stage
    to how it looked before the first match, in both the camera and the
    Slide Output window. Useful between segments when you want a clean
    start rather than leaving the last matched image on screen. It uses
    whichever Transition Type and Duration you have set, so the scene fades
    away rather than cutting. Clear Scene does not stop Play Mode — the
    next thing you say can fill the stage again.
- **Rolling Transcript** — shows the last few seconds of what Aura heard
  while Play Mode is running. Useful for confirming your microphone is
  picking up speech correctly.
- **Active Background Match** — the full match details for whatever Play
  Mode most recently selected: match score, the matched record's id/status,
  what Aura heard you say ("Spoken"), and the record's trigger text that
  matched it. More detailed than the Active Visual readout above; useful
  when tuning trigger phrases or Minimum Match Score.

See [section 6](#6-play-mode--how-live-matching-works) for how matching
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

Choose a **Microphone**, click **Start Recording**, speak, then **Stop**.
Click **Save Recording** to transcribe it (via Whisper) and run it through
the same summary → prompt → trigger → image pipeline as Text Source. The
transcript appears under **Whisper Transcription** once processing
finishes.

The Microphone dropdown here is the same setting as the one in Studio,
Settings and Conference — changing it in any of those changes it
everywhere, so all of Aura listens on one device.

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

### Filtering and search

The **View** dropdown on the left switches between **All Complete
Records**, **All Draft Records**, **All Records**, or any specific **Group**
you've created.

Next to **Refresh Records** in the header, the search box filters the
visible cards by matching your search term against each record's **Cleaned
Play Mode Trigger Text** — handy for jumping straight to the record behind
a specific trigger phrase in a large library.

### Groups

Groups let you organize records into named sets (e.g. "Space," "Music,"
"Philosophy") and restrict Play Mode to just one set at a time via the
Studio panel's "Active Play Mode Group" selector (hover the ⓘ next to either
group dropdown for a reminder of exactly how that matching rule works). To
create one, enter a **Group name** (and optional description) under **New
Group** and click **Create Group**.

### Record cards

Cards default to a **minimized** view to keep a full library scannable: a
**COMPLETE**/**DRAFT** status badge (only complete records are eligible to
trigger in Play Mode), the card's "⋯" menu, the record title, its image
grid, the **Library Group** dropdown, and the **Cleaned Play Mode Trigger
Text** field with its **✎** edit icon — everything else is collapsed.

The image grid stays visible either way. **Click any image to view it full
size**; press Escape or click anywhere to close it again. Each image also
has its own "⋯" menu: **Make Primary** (choose which image displays by
default for this record), **Move** (reassign this image to a different
record), and **Delete Image** (soft-delete it — see
[Trash](#trash--purge)).

Click **⋯ → Edit Record** to expand a card to show every field:
**Original Source Text**, **Image Summary**, **Image Prompt**, **Cleaned
Play Mode Trigger Text**, and **Upload Image to This Record** (attach an
additional image without creating a new record). Each text field has its
own **✎** icon for inline editing — editing the trigger text is
particularly useful for tuning what phrases will match this record in Play
Mode. Click **Done** (next to the status badge) to collapse the card back
down once you're finished.

The **⋯** menu also has:
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

## 5. Aura Conference — turning a meeting into records

Conference turns a real conversation into library records. You record a
meeting you're already in, and Aura transcribes it, breaks it into the
subjects that were actually discussed, and builds a draft record for each
one — with a generated image, searched images, or both.

### Recording

Pick your **Audio Sources**. **System audio** captures the other
participants — it taps whatever Windows is playing, so headphones are fine.
**Microphone** captures you. Most calls want both; system audio on its own
hears everyone except you.

Give the session a **Session Title** if you like, or leave it blank to have
it named by date. Choose a **Target Group** on the right if you want the
records this meeting produces to land pre-organized.

Click **Start Recording**. A pulsing amber microphone appears next to
**Record a Meeting**, and the status line shows what is being captured, how
long it has been running, and how many segments have been saved. Click
**Stop Recording** when the meeting ends.

Aura records in short segments rather than one long file, so a crash or a
power cut costs the current segment instead of the whole meeting. The
counter only advances every five minutes or when you stop — "0 saved"
during a short recording is normal, not a fault.

**Everyone on the call is being recorded.** Make sure participants have
agreed before you start; in many places recording without consent is
unlawful. If the Aura Camera is running, a **RECORDING** badge appears in
the top-right corner of the video other participants see. If the camera is
off, Aura warns you that nobody on the call will see any indicator — the
badge travels on your video, so there is nothing to show it on.

### Processing

When you are ready, click **Process Meeting** on the session card. Aura
transcribes each segment through Whisper, then makes a single pass with
Ollama that produces the meeting's summary and its list of subjects.

This runs in the background and takes a few minutes — longer on a machine
where ComfyUI is also holding graphics memory. The card updates itself
while it works.

Processing deliberately happens *after* the call rather than during it, so
a live meeting never competes with Whisper, Ollama and ComfyUI for the
graphics card. Recording itself is only audio to disk and costs almost
nothing.

Whisper does not identify who is speaking, so the transcript is one
continuous block. Expect the participant list to be empty and most action
items to have no owner attached.

### Review

Click **Review** once the card says it is ready.

The top panel is the meeting's **Source Text** — an abstract, a narrative
summary, key points, decisions, action items, open questions and keywords.
This is the archival record of what was discussed.

Below it is each **subject** Aura found, showing:

- a strategy badge — **generate** (Aura will create an image), **search**
  (Aura will find real ones), **both**, or **none**
- **salience**, how much of the meeting this subject carried, and
  **confidence**, how clean the transcript was for it
- **Trigger phrases**, which decide when this record appears in Play Mode
- the **ComfyUI positive prompt** or **SerpAPI query** that will be used

Every field shown is editable and saves as you leave the box. Uncheck
**Approve** on anything you do not want. This is the moment to fix a weak
trigger phrase or a bad search query, because nothing has been generated or
searched yet.

### Generating the records

Set **Images per searched subject**, then click **Generate Approved
Subjects**. The line above the button says exactly what is about to happen
— how many images will be generated, how many searches will run, and how
many images will be downloaded — before anything is spent.

Each approved subject becomes one **draft** record in the Library, carrying
its trigger phrases and every image generated or found for it. As with
Image Search imports, they start as drafts; review them in the Library and
mark them complete when you are happy.

Re-running is safe. Subjects that already produced a record are skipped, so
a run interrupted halfway picks up where it stopped instead of duplicating
what already landed.

---

## 6. Play Mode — how live matching works

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

## 7. DB Manager — bulk record management

A spreadsheet-style view for managing many records at once, separate from
the card-based Library view. Everything beyond Refresh and search lives in
one of three dropdown menus in the header.

- **Search** — next to **Refresh**, filters the table by matching your
  search term against each record's Cleaned Play Mode Trigger Text, same as
  the Library search.
- **Selection** — check individual rows, or use the checkbox in the table's
  header row to select/clear every visible row at once. Bulk actions below
  operate on whatever's currently checked, and their confirmation prompt
  always states how many records are about to be affected.
- **Filter Group** menu — restrict the table to one Library Group.
- **Maintenance** menu:
  - **Move Selected** — opens a dialog to move every checked record into a
    different group (or out to No Specific Group).
  - **Mark Complete** — promotes every checked record to complete (same
    completeness check as the Library's Mark Complete).
  - **Delete Selected** — permanently deletes every checked record. Cannot
    be undone.
  - **Delete Current Group** — deletes whichever group is chosen in the
    Filter Group menu; records that were in it become ungrouped, not
    deleted.
  - **View Trash** — shows every soft-deleted image (from "Delete Image" in
    the Library) with the option to **Restore** any of them back to their
    record.
  - **Purge Deleted Images** — permanently erases every soft-deleted image
    and its file on disk. Cannot be undone; use View Trash first to make
    sure nothing in there should be restored.
- **Portability** menu:
  - **Export Selected** / **Export Group** / **Export Database** — each
    downloads a `.zip` package (records, metadata, and images) you can back
    up or move between machines, scoped to the checked records, the
    currently filtered group, or everything.
  - **Import Package** — loads a previously exported `.zip` back in; if the
    group name already exists, the import is renamed automatically (e.g.
    "Space (Imported 2026-07-19)") so nothing overwrites your existing data.

Every action above that can't be undone or affects more than one
record — Move Selected, Mark Complete, Delete Selected, Delete Current
Group, Purge Deleted Images, Import Package — asks for confirmation in a
popup dialog before it runs.

### Trash & Purge

Deleting an individual image (from a Library record card) doesn't erase it
immediately — it's soft-deleted and recoverable via DB Manager → View Trash
until you explicitly Purge. Deleting an entire record, or a bulk delete in
DB Manager, is immediate and permanent and does not go through Trash.

---

## 8. Settings

- **Language** — sets the UI's display language. Aura ships with 17
  languages: English, Spanish, Chinese, Hindi, Arabic, Portuguese, French,
  German, Japanese, Russian, Korean, Italian, Turkish, Dutch, Polish,
  Vietnamese, and Ukrainian. Changing this only affects what language the
  interface is shown in — it doesn't affect what language your records are
  processed in (that's detected automatically per-record, as described in
  Capture).
- **Devices** — camera and microphone selection, mirrored with the pickers
  in Studio.
- **Segmentation**:
  - **Engine** — which engine separates you from your background.
    **PsySeg** is the licensed Personify SDK (the default, and what Aura
    has always used). **PaddleSeg (ONNX)** runs a local PP-HumanSeg model
    on your GPU and needs no licence. Both support Blur, Remove and
    Replace identically, so this is safe to switch between.
    The change takes effect the next time you start the camera — if the
    camera is already running, stop and start it again.
- **Matching & Generation**:
  - **Semantic matching (embeddings) in Play Mode** — toggle described in
    section 6; hover the ⓘ for the short version.
  - **Ollama Model Override** — use a specific Ollama model for
    summaries/prompts/triggers instead of the built-in default. Must
    already be pulled in Ollama.
  - **Negative Prompt** — applied to every ComfyUI image generation, to
    steer away from unwanted content (default excludes text, watermarks,
    blur, and distortion); hover the ⓘ for a reminder.
- **Logs** — **Select Log** picks which of the services Aura manages
  (speech/Whisper, ComfyUI, the Aura server, the virtual-camera bridge) to
  view; **Refresh Log** reloads it, **Open Log Folder** opens the folder on
  disk, **Copy Log** copies the current contents to your clipboard. Check
  here first if a System Status indicator on the Studio page is red.

---

## Quick Reference

| I want to... | Where |
|---|---|
| Turn my speech into a live background | Studio → Start Camera, then Start Play Mode |
| Create a new record from something I say | Capture → Audio Source |
| Create a new record from text | Capture → Text Source |
| Use my own image instead of generating one | Capture → Manual Record |
| Pull images from the web | Image Search |
| Build records from a meeting I was in | Aura Conference → Start Recording |
| Check what a meeting produced before spending anything | Aura Conference → Review |
| Fix a background that keeps mismatching | Library → edit that record's Trigger Text, or raise Minimum Match Score |
| Restrict Play Mode to a topic | Create a Group, assign records to it, select it in Studio |
| Recover an image I deleted | DB Manager → View Trash → Restore |
| Move records between machines | DB Manager → Export Selected/Group, then Import Package elsewhere |
| Change the app's display language | Settings → Language |
| See if a service (Ollama/ComfyUI/Whisper) is down | Studio → System Status |
