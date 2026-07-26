# Translation

Universal translation subsystem — currently a static UI-string localization layer, not a live speech/content translation engine. (No code for translating spoken input, transcripts, or record content was found anywhere in `src/` — if a broader translation feature is planned, it doesn't exist yet.)

## What exists today

`public/i18n/translations.js` defines a single global `window.AURA_I18N` object with two top-level maps:
- `languages` — ISO 639-1 code → native display name. 17 languages: en, es, zh, hi, ar, pt, fr, de, ja, ru, ko, it, tr, nl, pl, vi, uk.
- `strings` — language code → flat `{key: translatedString}` dictionary, dot-namespaced keys (e.g. `nav.studio`, `cam.blur`, `play.status`).

English (`en`) is the reference/fallback locale. Product and tool names (Aura, Whisper, Ollama, ComfyUI) are intentionally left untranslated.

This is loaded by `public/index.html` and read against `auraConfig.uiLanguage` (see `src/config/auraConfig.js`, one of the allowlisted settings keys) to pick a display language, falling back to English for missing keys.

## How this maps to the stated principles (CLAUDE.md §9)

- **Single language selection in Settings** — matches: `uiLanguage` is a single allowlisted `auraConfig` key.
- **Local whenever practical** — matches: it's a static bundled dictionary, no network calls.
- **Invisible to the user / no workflow changes** — matches for UI chrome (menus, labels, status text swap based on the selected language).
- **Universal** — only partially true today: it covers UI chrome strings, not user-generated content (record summaries, trigger texts, transcripts), which stay in whatever language they were created/spoken in. If "universal" is meant to include translating user content, that is not implemented — flag this gap before assuming translation coverage extends beyond the UI when working on related features.

## Adding a new UI string

Add the key to every language map in `public/i18n/translations.js` (English first, as the fallback). There's no build step or extraction tooling — it's hand-maintained.
