# Aura Third-Party Licensing Report

**Scope:** Every third-party software component Aura depends on — bundled/shipped
in the installer, and external services/tools it talks to but does not
redistribute. Prepared to inform commercial-distribution decisions.

**Not legal advice.** This is an engineering-level inventory and general
guidance on well-established license categories, not a legal opinion. Before
any commercial launch, have counsel review at minimum: the SerpAPI Terms of
Service, and the GPL-3.0/ComfyUI note in Section 3 if the ComfyUI-bundling
architecture ever changes.

---

## 1. Summary / Bottom Line

| Category | Status |
|---|---|
| Code actually **shipped inside the Aura installer** (138 npm packages + Electron/Chromium + Node.js + bundled native `.exe`) | All permissive licenses (MIT, Apache-2.0, ISC, BSD-2/3-Clause, BlueOak-1.0.0). **No GPL/AGPL/LGPL code is bundled.** Commercially safe as-is, subject to the attribution obligations in Section 5. |
| **SerpAPI** | Not open source — a paid API service under its own Terms of Service. No license file; a ToS review is needed for commercial use, especially around caching/displaying results. |
| **Ollama, ComfyUI, Whisper/faster-whisper** | External programs the user installs separately; Aura talks to them over local HTTP and does not bundle or redistribute them. **ComfyUI is GPL-3.0** — safe under the current "separate process over network" architecture, but this changes if Aura ever bundles ComfyUI directly (see Section 3). |

---

## 2. Code shipped inside the Aura installer

This is the surface that actually gets distributed to end users and carries
real redistribution obligations.

### 2.1 Direct npm dependencies

| Package | Version | License | Notes |
|---|---|---|---|
| `adm-zip` | 0.5.17 | MIT | |
| `archiver` | 8.0.0 | MIT | |
| `better-sqlite3` | 12.10.0 | MIT | Bundles SQLite itself, which is **public domain** — the most permissive license possible, no obligations at all. |
| `dotenv` | 17.4.2 | BSD-2-Clause | |
| `express` | 5.2.1 | MIT | |
| `multer` | 2.1.1 | MIT | |

### 2.2 Full transitive dependency tree (what's actually in the installer)

Scanned directly from `dist\win-unpacked\resources\app\node_modules` — the
real shipped output, not the larger dev-time `node_modules` (which also
contains `electron-builder`'s own huge toolchain that never ships).

**138 packages total, all permissive:**

| License | Count |
|---|---|
| MIT | 112 |
| Apache-2.0 | 13 |
| ISC | 7 |
| BSD-3-Clause | 2 |
| BSD-2-Clause | 1 |
| BlueOak-1.0.0 | 1 |
| (MIT OR WTFPL) | 1 |
| (BSD-2-Clause OR MIT OR Apache-2.0) | 1 |

No copyleft (GPL/LGPL/AGPL/MPL) packages anywhere in the shipped tree.

**Apache-2.0 packages** (13) — permissive, but Apache-2.0 carries a NOTICE-file
attribution requirement if the package ships one (see Section 5):
`b4a`, `bare-events`, `bare-fs`, `bare-os`, `bare-path`, `bare-stream`,
`bare-url`, `crc-32`, `detect-libc`, `events-universal`, `readdir-glob`,
`text-decoder`, `tunnel-agent`

**BSD-3-Clause:** `ieee754`, `qs`
**BSD-2-Clause:** `dotenv`
**BlueOak-1.0.0** (a modern, deliberately simple permissive license,
functionally similar to MIT): `minimatch`
**Dual-licensed, permissive either way:** `expand-template` (MIT or WTFPL),
`rc` (BSD-2-Clause, MIT, or Apache-2.0 — your choice)

### 2.3 Electron / Chromium / V8 (the application runtime itself)

`Aura.exe` **is** a repackaged Electron binary — Electron isn't in the
`node_modules` scan above because it's a devDependency used at *build* time,
but its compiled runtime is the actual core of the shipped application.

- **Electron**: MIT license.
- **Chromium** (embedded in Electron): predominantly BSD-3-Clause, with a
  large set of bundled third-party components that are individually
  documented in Electron's own licensing files. All permissive; no copyleft.
- **V8** (JavaScript engine, embedded in Electron): BSD-3-Clause.

### 2.4 Node.js (bundled as `resources\node.exe`)

Node.js core is effectively MIT-licensed, and bundles its own set of
third-party components (V8, OpenSSL, zlib, c-ares, etc.), all permissive.
Node ships a consolidated `LICENSE` file listing every bundled component if
a full audit trail is ever needed.

### 2.5 Bundled native executables

| Component | Source | License |
|---|---|---|
| `VCamSample.exe` (`native/external/VCamSample`) | Derived from Simon Mourier's open-source Windows virtual-camera sample | **MIT** — copyright notice confirmed directly in `native/external/VCamSample/LICENSE`. |
| `AuraFrameBridge.exe` | First-party Aura code | N/A — your own code, not third-party. |

**Action needed:** MIT requires the copyright notice and license text to be
included "in all copies or substantial portions of the Software." Since
`VCamSample.exe` is shipped in every install, its `LICENSE` file should be
included in the installer's third-party notices (see Section 5).

---

## 3. External services — installed separately, not bundled

These are not inside the Aura installer. Aura talks to them over local HTTP
after the user installs and starts them independently (per the install
guide). This matters because redistribution obligations generally attach to
*what you ship*, not what a user separately installs and your app happens to
call over a network.

| Service | License | Commercial-use notes |
|---|---|---|
| **Ollama** | MIT | Fully permissive, no concerns. |
| **ComfyUI** | **GPL-3.0** | See callout below — important. |
| **faster-whisper** (speech transcription library) | MIT | Fully permissive. |
| **OpenAI Whisper model weights** (the `base` model loaded by faster-whisper) | MIT (both code and released checkpoints) | Fully permissive. |
| **Flask** (speech service web framework) | BSD-3-Clause | Fully permissive. |
| **flask-cors** | MIT | Fully permissive. |

### ComfyUI / GPL-3.0 — the one real architectural consideration

ComfyUI is copyleft (GPL-3.0). Under the **current architecture** — Aura
never bundles ComfyUI, never links against its code, and only communicates
with an independently-installed, independently-running ComfyUI instance over
`localhost:8188` HTTP — this is the standard "mere aggregation / separate
process over a network" pattern that does not trigger GPL's copyleft
obligations on Aura's own code. Aura ships its own workflow JSON
(`comfy/workflows/aura_background_api.json`), not any of ComfyUI's source.

**This conclusion would need to be revisited if the architecture changes** —
specifically, if Aura ever bundles/embeds ComfyUI directly into a turnkey
installer (rather than requiring users to install it separately), or begins
importing/linking ComfyUI's Python code directly instead of calling it over
HTTP. Either of those would introduce real GPL distribution obligations for
the ComfyUI portion, and depending on how tightly coupled the integration
becomes, potentially broader copyleft exposure. Flag this explicitly to
counsel before any packaging change along those lines.

---

## 4. SerpAPI — commercial API, not open source

SerpAPI (used for image search/import) is a paid third-party API service,
not software you install or distribute — there's no open-source license to
evaluate. What matters instead is their **Terms of Service**, which govern
things like: whether search results/images can be cached and re-displayed
to end users, rate limits, and commercial-use tier requirements. Since
SerpAPI itself proxies Google search results, their ToS (and by extension
Google's own policies on scraped result usage) should be reviewed for any
restriction relevant to how Aura displays/stores imported images
long-term in a commercial product.

---

## 5. Compliance checklist before commercial distribution

- [ ] **Third-party notices file**: MIT/BSD/Apache-licensed dependencies
      generally require their license text/copyright notice to travel with
      the distributed binary. Bundle a consolidated `THIRD-PARTY-NOTICES.txt`
      (or similar) in the installer covering: the 138 shipped npm packages,
      Electron/Chromium/V8, Node.js, and `VCamSample.exe`'s MIT license.
      This can be generated automatically (e.g. via `license-checker` in
      CI) rather than maintained by hand.
- [ ] **Apache-2.0 NOTICE files**: confirm none of the 13 Apache-2.0 packages
      ship a `NOTICE` file requiring separate reproduction (most don't, but
      worth a quick check since this is easy to automate).
- [ ] **SerpAPI ToS**: confirm commercial tier and caching/display terms.
- [ ] **ComfyUI architecture**: keep it as a separately-installed, separately
      running process (current state is fine); revisit this section if that
      ever changes.

---

## 6. How this was gathered

- Shipped npm dependency licenses: scanned directly from the actual built
  installer output (`dist\win-unpacked\resources\app\node_modules`), not
  just the dev-time tree — so devDependencies-only tooling like
  `electron-builder` (which never ships) is correctly excluded.
- Electron/Node/Chromium/V8: based on their well-documented public licensing.
- `VCamSample.exe`: confirmed directly from the `LICENSE` file present in
  this repo's `native/external/VCamSample/` folder.
- External services (Ollama, ComfyUI, faster-whisper, Flask, flask-cors):
  confirmed against each project's current GitHub/PyPI license metadata.
- SerpAPI: inferred from how it is integrated (a paid API) — its actual
  contractual terms are not something I have access to and need to be pulled
  from the vendor relationship directly.
