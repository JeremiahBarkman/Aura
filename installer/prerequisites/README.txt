========================================================================
 Aura Prerequisites Setup  (for testers)
========================================================================

WHAT THIS IS
  A wizard that checks for the external software Aura needs, helps you
  install what's missing, sets up Aura's local speech service, and writes
  Aura's configuration file (.env).

  This is NOT the Aura application itself. Install the Aura app separately
  by running "Aura Installer vx.y.z.exe" (sent to you alongside this folder).
  Order does not matter, but nothing in Aura will work until BOTH the app
  is installed AND these prerequisites are satisfied.

BEFORE YOU START  (IMPORTANT - do this first)
  Because this folder arrived from the internet/email, Windows marks its
  files as "blocked" and may pop a blue "Windows protected your PC" warning.
  To avoid getting stuck:

    1. BEFORE extracting: right-click the .zip you received ->
       Properties -> check "Unblock" (bottom right) -> Apply -> OK.
       (Unblocking the zip clears the block from everything inside it.)
    2. THEN extract the zip to a real folder (e.g. your Desktop).
       Do NOT run the files straight out of the zip preview window.
    3. If a "Windows protected your PC" box still appears when you launch,
       click "More info" -> "Run anyway". This is expected for an
       unsigned tester tool.

HOW TO RUN
  Double-click:  Install Aura Prerequisites.bat

  A window opens listing each prerequisite with a status:
      [OK]  ready
      [!]   partially set up (usually: installed but not running)
      [X]   missing - use its button to install or get instructions

WHAT THE WIZARD DOES FOR YOU (buttons)
  - Ollama                 downloads and runs the official installer
  - nomic-embed-text       pulls the embedding model (~275 MB)
  - Python 3               installs via winget
  - FFmpeg                 installs via winget
  - Speech service         creates a Python venv, installs the speech
                           packages, and places speech_server.py
  - Text model             pick one from a list; the wizard downloads it
                           and sets it in your config. No typing commands.
  - SDXL checkpoint        downloads it (6.5 GB) straight into ComfyUI's
                           checkpoints folder, with the exact filename
                           Aura needs. Progress is shown as it goes.
  - ComfyUI paths          found automatically when the wizard starts, if
                           ComfyUI is already installed anywhere obvious.

  - ComfyUI                click "Set up ComfyUI..." -> "Install it for me".
                           It detects your graphics card, downloads the
                           matching build (~2 GB), unpacks it, and fills in
                           the paths. If ComfyUI is already on the machine,
                           the wizard usually finds it at startup with no
                           clicks at all.
                           You do NOT need to start ComfyUI yourself:
                           Aura launches it automatically.

  You do not need to press Save after these - they save themselves.

CLEANING UP AFTER ITSELF
  Downloaded installers and archives go to a single work folder:
      %LOCALAPPDATA%\Aura\installer-cache
  They are sent to the RECYCLE BIN as soon as they are no longer needed,
  and any leftovers are swept when the wizard next opens or closes. Nothing
  is permanently deleted - if you ever need one back, it's in the bin.

ABOUT COMFYUI (this is the step people get stuck on)
  - The portable download is a .7z. Windows' built-in unzip CANNOT open it.
    Install 7-Zip (7-zip.org) and extract with that. A partial extraction
    is the usual cause of "it won't start".
  - Extract to a short, simple path (C:\AI is ideal). Very long paths or
    OneDrive-synced folders cause trouble.
  - Do NOT launch run_nvidia_gpu.bat with "Run as administrator". That
    makes Windows use C:\Windows\System32 as the working folder, and the
    script - which uses relative paths - fails with:
        .\python_embeded\python.exe ...
        The system cannot find the path specified.
    If you want to test ComfyUI by hand, just double-click the .bat
    normally from inside the extracted folder.
  - Aura does not use that .bat at all, so this cannot affect Aura. Aura
    starts ComfyUI itself using the paths you set in the wizard.

WHAT YOU MUST PROVIDE (paste into the Configuration field, then Save):
  - SerpAPI key            (from serpapi.com - required for Image Search)
    The camera/segmentation feature needs no key: Aura ships its own
    local model.

FINISHING
  Fill in the Configuration fields, click "Save configuration (.env)", then
  "Re-check all". When every row is [OK] (or the only [!] items are things
  that simply aren't running yet), launch Aura.

NOTES
  - The .env file is written to:  %APPDATA%\aura\.env
    Re-running the wizard never erases keys you already entered.
  - Some installs show a Windows permission (UAC) prompt - that's expected.
  - "winget" is required for the Python and FFmpeg buttons. It ships with
    Windows 10 (1809+) and Windows 11. If a button reports winget is
    missing, install "App Installer" from the Microsoft Store, or install
    those tools manually.
  - Advanced: run a text-only status check with
        powershell -ExecutionPolicy Bypass -File Aura-Prerequisites.ps1 -Check
