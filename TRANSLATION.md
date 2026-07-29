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

**Get this wrong and the UI silently reverts your edit.** `applyTranslations()` runs on load and does `el.textContent = t(el.dataset.i18n)` for every `[data-i18n]` element, unconditionally overwriting whatever's in the HTML — so editing an element's visible text without also updating (or adding) its key in `translations.js` has no lasting effect; the dictionary lookup just stomps it back on the next load. If a key has no entry in any locale, `t()` falls back to returning the raw key string itself, which renders as broken literal text (e.g. `set.logs`) rather than failing loudly.

**Known gap as of the DB Manager/Studio/Library redesign (2026-07-28):** several UI text changes from that session only got English (`en`) entries added — `set.logs`, `set.logsSelect`, `set.logsRefresh`, `set.logsFolder`, `set.logsCopy`, and `studio.sub`'s new value — the other 16 locales still have the old/missing strings for those keys (harmless: `t()` falls back to English for a locale missing a key, so non-English UIs show correct English text there rather than broken output, just not translated). The same redesign also removed several UI elements without removing their now-unused dictionary keys (`lib.refreshBtn`, `imp.status`, `imp.onImport`, `imp.onImportHint`, `set.presentation`, `set.presentationHint`, `set.semanticHint`, `set.negativeHint`, `set.modelHint`, `set.logsHint`, `set.logsView`, `db.view`, `db.bulk`, `db.maintenance`, `db.portability`, `play.status`, `play.stopped`, `studio.online`) — dead weight in the dictionary, not a functional bug. Both are worth a cleanup pass but weren't blocking.
