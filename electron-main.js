const net = require('net');
const fs = require('fs');
const { app, BrowserWindow, ipcMain, shell } = require('electron');
const {
    spawn,
    execFileSync
} = require('child_process');
const path = require('path');

// Aura is a live virtual camera: the whole frame pipeline (camera capture,
// PsySeg segmentation, compositing, and export to the native bridge) runs in
// the renderer. By default Chromium treats a minimized/occluded window as a
// background page -- it pauses requestAnimationFrame / requestVideoFrameCallback
// and throttles timers to ~1/second, which collapses the virtual camera to
// ~1 FPS the moment the user minimizes Aura. per-window backgroundThrottling
// (set below) is not enough on its own; these process-level switches stop the
// renderer from ever being backgrounded so the pipeline keeps running at full
// rate while minimized. Must be set before app is ready.
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');

// Without this, nothing stops a second Aura instance from launching
// alongside a first one that's already running (e.g. an old instance that
// never fully closed, still sitting in the background). Both would spawn
// their own server.js, race for port 5150, and produce exactly the kind of
// intermittent, hard-to-reproduce breakage that showed up during testing:
// one instance's requests landing on a server tied to a different state
// than expected. requestSingleInstanceLock() must be checked before any
// other startup work -- there's nothing to clean up yet if we lose it.
const gotSingleInstanceLock = app.requestSingleInstanceLock();

if (!gotSingleInstanceLock) {
    // app.quit() only *schedules* a graceful quit -- it does not stop the
    // rest of this script from executing synchronously. Without an
    // immediate hard exit here, a blocked second instance would still run
    // through the entire file (spawning its own ComfyUI/server/speech
    // processes) before the quit ever took effect, which is exactly what
    // this lock exists to prevent.
    app.quit();
    process.exit(0);
} else {
    app.on('second-instance', () => {
        // Someone tried to launch a second copy -- surface the existing
        // window instead of letting a second one spin up alongside it.
        if (mainWindow) {
            if (mainWindow.isMinimized()) {
                mainWindow.restore();
            }

            mainWindow.focus();
        }
    });
}

// Packaged apps run inside a read-only app.asar; writable data (DB, config,
// session/PID file) needs to live in a real per-user directory instead.
// This must run before requiring sessionTracker (or anything else that
// reads paths.js), since that module resolves data paths at load time.
if (app.isPackaged) {
    process.env.AURA_DATA_DIR = app.getPath('userData');
}

const sessionTracker = require('./src/electron/sessionTracker');

// .env holds machine-specific paths (ComfyUI/Python venv locations) and
// secrets (PsySeg license, SerpAPI key). None of that belongs inside the
// installed app folder: it would ship the developer's own secrets to every
// tester, get silently overwritten on every upgrade, and be wrong on any
// machine laid out differently. Packaged builds instead keep .env in
// userData (durable across upgrades, never bundled into the installer),
// seeded from the bundled .env.example template on first run so there's
// something to edit. Dev mode is unchanged: .env stays pinned to
// electron-main.js's own directory rather than process.cwd(), which depends
// on how the app was launched and isn't reliable.
let envPath = path.join(__dirname, '.env');
if (app.isPackaged) {
    envPath = path.join(app.getPath('userData'), '.env');
    if (!fs.existsSync(envPath)) {
        fs.copyFileSync(path.join(__dirname, '.env.example'), envPath);
    }
}
require('dotenv').config({ path: envPath });

/*
    Fail loudly on a missing/incomplete .env.

    dotenv is silent when the file isn't there, so every key just becomes
    undefined and the failures surface far from the cause: no PsySeg license
    means the virtual camera emits BLACK FRAMES, and COMFYUI_AUTOSTART being
    undefined means ComfyUI is simply never launched. Both look like broken
    features rather than missing config.

    This is especially easy to hit because dev and packaged mode read
    DIFFERENT files (see above), so a perfectly good packaged config tells
    you nothing about dev mode.
*/
function reportEnvHealth() {
    const banner = (lines) => {
        const width = Math.max(...lines.map((l) => l.length)) + 4;
        console.warn('\n' + '='.repeat(width));
        lines.forEach((l) => console.warn('  ' + l));
        console.warn('='.repeat(width) + '\n');
    };

    if (!fs.existsSync(envPath)) {
        banner([
            'AURA CONFIG MISSING',
            '',
            `No .env found at: ${envPath}`,
            `(${app.isPackaged ? 'packaged' : 'dev'} mode reads that exact path)`,
            '',
            'Nothing is configured, so expect:',
            '  * virtual camera = BLACK SCREEN (no PsySeg license)',
            '  * ComfyUI never starts (COMFYUI_AUTOSTART unset)',
            '  * ComfyUI / Whisper indicators stay red',
            '',
            'Fix: run the Aura Prerequisites wizard, or copy an existing',
            'config into place, e.g.',
            `  copy "%APPDATA%\\Aura\\.env" "${path.join(__dirname, '.env')}"`
        ]);
        return;
    }

    // Present but hollow is just as broken, and harder to spot.
    const required = {
        PSYSEG_LICENSE: 'virtual camera will be a black screen',
        PSYSEG_ACCESS_KEY: 'virtual camera will be a black screen',
        PSYSEG_ACCESS_TOKEN: 'virtual camera will be a black screen',
        COMFYUI_WORKING_DIR: 'ComfyUI cannot be started',
        COMFYUI_PYTHON: 'ComfyUI cannot be started',
        SPEECH_PYTHON: 'Whisper falls back to a dev-only path and will not start',
        SPEECH_SCRIPT: 'Whisper falls back to a dev-only path and will not start'
    };

    const missing = Object.keys(required).filter(
        (k) => !process.env[k] || !String(process.env[k]).trim()
    );

    if (missing.length) {
        banner([
            'AURA CONFIG INCOMPLETE',
            '',
            `Loaded: ${envPath}`,
            '',
            'These keys are empty or missing:',
            ...missing.map((k) => `  * ${k}  ->  ${required[k]}`),
            '',
            'Fix: run the Aura Prerequisites wizard and click',
            '"Save my keys + config (.env)".'
        ]);
    }

    // A path that is configured but no longer on disk fails the same silent
    // way (moved/renamed/uninstalled ComfyUI, deleted venv).
    const paths = ['COMFYUI_WORKING_DIR', 'COMFYUI_PYTHON', 'SPEECH_PYTHON', 'SPEECH_SCRIPT'];
    const broken = paths.filter((k) => {
        const v = process.env[k];
        return v && String(v).trim() && !fs.existsSync(v);
    });

    if (broken.length) {
        banner([
            'AURA CONFIG POINTS AT MISSING FILES',
            '',
            'These are set in .env but do not exist on disk:',
            ...broken.map((k) => `  * ${k} = ${process.env[k]}`),
            '',
            'The matching service will fail to start.',
            'Fix: re-run the Aura Prerequisites wizard to re-detect them.'
        ]);
    }

    if (!missing.length && !broken.length) {
        console.log(`[AURA CONFIG] Loaded ${envPath} - config looks good.`);
    }
}
reportEnvHealth();

/*
    Per-service log files.

    A packaged Electron app has no console, so every console.log in a child's
    exit handler goes nowhere, and stdio:'inherit' inherits handles that are
    not real. The result: when a service fails to start, there is no error
    message anywhere - the only symptom is a red dot in the UI, which is
    exactly the position we were in with Whisper.

    Each service now gets an appendable log under <userData>\logs, and spawn
    failures are captured explicitly ('error' is emitted for ENOENT and
    friends; with no listener Node turns that into an unhandled throw that
    tells the user nothing).
*/
const auraLogDir = path.join(
    app.isPackaged ? app.getPath('userData') : __dirname,
    'logs'
);

try {
    fs.mkdirSync(auraLogDir, { recursive: true });
} catch (error) {
    console.warn('[AURA] Could not create log directory:', error.message);
}

function attachServiceLogging(child, name, command, args) {
    const logPath = path.join(auraLogDir, `${name}.log`);

    let stream = null;
    try {
        stream = fs.createWriteStream(logPath, { flags: 'a' });
    } catch (error) {
        console.warn(`[AURA] Could not open ${logPath}:`, error.message);
    }

    const write = (text) => {
        if (stream) {
            try { stream.write(text); } catch {}
        }
        // Still echo to a real console when there is one (dev mode).
        try { process.stdout.write(text); } catch {}
    };

    write(
        `\n=== ${name} started ${new Date().toISOString()} (pid ${child.pid}) ===\n` +
        `    command: ${command}\n` +
        `    args:    ${JSON.stringify(args)}\n`
    );

    if (child.stdout) { child.stdout.on('data', (d) => write(d.toString())); }
    if (child.stderr) { child.stderr.on('data', (d) => write(d.toString())); }

    child.on('error', (error) => {
        write(
            `!!! ${name} FAILED TO START: ${error.message}\n` +
            `    code: ${error.code}\n` +
            `    path: ${command}\n` +
            (error.stack ? `    ${error.stack}\n` : '')
        );
    });

    child.once('exit', (code, signal) => {
        write(`=== ${name} exited code=${code} signal=${signal} at ${new Date().toISOString()} ===\n`);
    });

    return logPath;
}

// stdio for a logged service: no stdin, pipe the rest so we can capture it.
const SERVICE_STDIO = ['ignore', 'pipe', 'pipe'];

// comfyProcess/serverProcess/speechProcess all spawn with shell:true, and on
// Windows that inconsistently reports either the cmd.exe wrapper's PID or
// the real target executable's PID -- observed both ways across runs.
// Accept either name; the command-line substring does the real
// discriminating. auraFrameBridgeProcess/auraCameraHostProcess spawn with
// shell:false, so their PID is always the real executable directly.
const EXPECTED_CHILD_PROCESSES = {
    comfyProcess: { names: ['cmd.exe', 'python.exe'], commandLineIncludes: 'main.py' },
    serverProcess: { names: ['cmd.exe', 'node.exe'], commandLineIncludes: 'server.js' },
    speechProcess: { names: ['cmd.exe', 'python.exe'], commandLineIncludes: 'speech_server.py' },
    auraFrameBridgeProcess: { name: 'AuraFrameBridge.exe' },
    auraCameraHostProcess: { name: path.basename(getAuraCameraHostPath()) }
};

let serverProcess = null;
let speechProcess = null;
let comfyProcess = null;
let auraFrameBridgeProcess = null;
let auraCameraHostProcess = null;
let mainWindow = null;
let outputWindow = null;
let auraFramePipeClient = null;
let auraFramePipeConnecting = null;

async function checkOllama() {
    try {
        const response = await fetch(
    `${process.env.OLLAMA_URL}/api/tags`
);

        if (!response.ok) {
            console.warn('Ollama check failed:', response.status);
            return;
        }

        console.log('Ollama is running.');
    } catch (error) {
        console.warn('Ollama is not reachable. Start Ollama before using AI text processing.');
    }
}

async function ensureComfyUiRunning() {
    const comfyUrl = new URL(
        process.env.COMFYUI_URL || 'http://127.0.0.1:8188'
    );

    const alreadyRunning = await isTcpPortOpen(
        comfyUrl.hostname,
        Number(comfyUrl.port) || 80
    );

    if (alreadyRunning) {
        console.log(
            'ComfyUI is already running externally. Skipping autostart.'
        );
        return;
    }

    console.log(
        'Starting ComfyUI:',
        process.env.COMFYUI_WORKING_DIR
    );

    /*
        No shell:true here (or on the other two Aura-owned services below):
        each target is a plain .exe invoked with a plain argument array, no
        shell syntax involved, and shell:true wraps the real process in a
        cmd.exe layer that can die independently of its child when the
        parent goes away uncleanly -- leaving the real process orphaned
        under a PID the session tracker never recorded.
    */
    comfyProcess = spawn(
        process.env.COMFYUI_PYTHON,
        ['main.py', '--listen', '127.0.0.1'],
        {
            cwd: process.env.COMFYUI_WORKING_DIR,
            // Without this, a console child launched from a GUI process (the
            // Start Menu shortcut, which has no console of its own) opens its
            // OWN terminal window. Three services = three stray windows the
            // user has to look at and can't safely close.
            //
            // This does NOT hide output in dev: with stdio 'inherit' and a
            // parent that already has a console (npm run electron), the child
            // still writes into that same console. It only suppresses
            // ALLOCATING A NEW one.
            windowsHide: true,
            stdio: SERVICE_STDIO,
            // See startSpeechService: unbuffered so a crash during startup
            // still leaves its explanation in the log.
            env: { ...process.env, PYTHONUNBUFFERED: '1', PYTHONIOENCODING: 'utf-8' }
        }
    );

    attachServiceLogging(
        comfyProcess,
        'comfyui',
        process.env.COMFYUI_PYTHON,
        ['main.py', '--listen', '127.0.0.1']
    );

    sessionTracker.recordChildProcess('comfyProcess', comfyProcess.pid);

    comfyProcess.once('exit', (code, signal) => {
        console.log(
            `ComfyUI exited. code=${code} signal=${signal}`
        );

        comfyProcess = null;
        sessionTracker.recordChildProcess('comfyProcess', null);
    });
}

// If port 5150 is already held when we start up, the app would silently talk
// to that stranger instead of its own server -- and our spawned server would
// just fail with EADDRINUSE and exit. That stranger is almost always a stale
// Aura server (an orphaned child from a previous run, or a bare
// `node src/web/server.js` left running), which serves old code and/or the
// wrong data directory. Detect that case and terminate the stale Aura server
// so ours can bind cleanly. Only processes actually running Aura's
// src/web/server.js are touched; anything else on the port is left alone and
// merely warned about. All best-effort and fully isolated -- nothing here may
// break startup.
async function clearStaleAuraServer() {
    const port = Number(process.env.PORT) || 5150;

    try {
        if (!(await isTcpPortOpen('127.0.0.1', port))) {
            return; // port free, nothing to clear
        }

        console.warn(
            `[AURA] Port ${port} is already in use before starting the server. ` +
            `Checking for a stale Aura server to clear...`
        );

        let pidOutput = '';

        try {
            pidOutput = execFileSync(
                'powershell.exe',
                [
                    '-NoProfile',
                    '-NonInteractive',
                    '-Command',
                    "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | " +
                    "Where-Object { $_.CommandLine -like '*src*web*server.js*' } | " +
                    'Select-Object -ExpandProperty ProcessId'
                ],
                { encoding: 'utf8', windowsHide: true }
            );
        } catch (error) {
            console.warn('[AURA] Could not enumerate stale servers:', error.message);
        }

        const pids = pidOutput
            .split(/\s+/)
            .map(value => value.trim())
            .filter(Boolean);

        for (const pid of pids) {
            console.warn(`[AURA] Terminating stale Aura server PID ${pid}.`);
            try {
                execFileSync('taskkill.exe', ['/F', '/T', '/PID', pid], { windowsHide: true });
            } catch (error) {
                console.warn(`[AURA] Could not kill PID ${pid}:`, error.message);
            }
        }

        // Wait briefly for the port to actually free up.
        for (let attempt = 0; attempt < 20; attempt++) {
            if (!(await isTcpPortOpen('127.0.0.1', port))) {
                return;
            }
            await new Promise(resolve => setTimeout(resolve, 100));
        }

        if (await isTcpPortOpen('127.0.0.1', port)) {
            console.error(
                `[AURA] Port ${port} is STILL in use by a process that is not an ` +
                `Aura server. Aura may show stale data. Close whatever is using ` +
                `port ${port} and relaunch.`
            );
        }
    } catch (error) {
        console.warn('[AURA] Stale-server check failed (continuing):', error.message);
    }
}

async function startAuraServer() {
    // A stale server squatting on the port makes the app talk to the wrong
    // process; clear it first so our own server binds cleanly.
    await clearStaleAuraServer();

    // Don't rely on a system-wide 'node' on PATH when packaged -- a normal
    // end user won't have Node.js installed at all. A bundled copy of
    // node.exe ships as an extraResource for that case instead.
    //
    // This deliberately does NOT use Electron's own binary as a Node
    // runtime (spawn(process.execPath, ..., {env:{ELECTRON_RUN_AS_NODE:1}}))
    // even though that's the more common pattern for this problem: Electron
    // bundles a newer Node ABI than this machine's native modules
    // (better-sqlite3) are compiled against, and rebuilding against
    // Electron's ABI needs a node-gyp-recognized Visual Studio install,
    // which isn't available here. A real standalone node.exe matches the
    // ABI the existing compiled native modules already work with.
    //
    // cwd can't be __dirname when packaged: that resolves inside the
    // virtual app.asar archive, which is asar-transparent for requires/fs
    // reads but not for a child process's actual OS-level working
    // directory -- Windows can't CreateProcess with a cwd pointing into a
    // packed archive. The script path itself stays __dirname-relative
    // (fine, since Node loading a script IS asar-transparent); only cwd
    // needs to be a real directory.
    const nodeExe = app.isPackaged
        ? path.join(process.resourcesPath, 'node.exe')
        : 'node';

    serverProcess = spawn(
        nodeExe,
        [path.join(__dirname, 'src', 'web', 'server.js')],
        {
            cwd: app.isPackaged ? process.resourcesPath : __dirname,
            // See startComfyUi: suppresses a stray console window without
            // losing output when a real console is already attached.
            windowsHide: true,
            stdio: SERVICE_STDIO
        }
    );

    attachServiceLogging(
        serverProcess,
        'aura-server',
        nodeExe,
        [path.join(__dirname, 'src', 'web', 'server.js')]
    );

    sessionTracker.recordChildProcess('serverProcess', serverProcess.pid);

    serverProcess.once('exit', (code, signal) => {
        console.log(
            `Aura server exited. code=${code} signal=${signal}`
        );

        serverProcess = null;
        sessionTracker.recordChildProcess('serverProcess', null);
    });
}

function startSpeechService() {
    // Matches COMFYUI_PYTHON/COMFYUI_WORKING_DIR: the speech venv is a real
    // Python environment too large to bundle, so it stays an external
    // prerequisite. Unset, this resolves relative to __dirname exactly as
    // it always has in dev mode.
    const speechPython =
        process.env.SPEECH_PYTHON ||
        path.join(__dirname, 'services', 'speech', 'venv', 'Scripts', 'python.exe');

    const speechScript =
        process.env.SPEECH_SCRIPT ||
        path.join(__dirname, 'services', 'speech', 'speech_server.py');

    // Fail loudly if the configured interpreter/script is not actually there.
    // Otherwise spawn emits ENOENT into the void and Whisper just stays red.
    for (const [label, target] of [['SPEECH_PYTHON', speechPython], ['SPEECH_SCRIPT', speechScript]]) {
        if (!fs.existsSync(target)) {
            console.error(`[AURA] Speech service cannot start: ${label} does not exist: ${target}`);
        }
    }

    speechProcess = spawn(
        speechPython,
        [speechScript],
        {
            // See startAuraServer for why this can't be __dirname when packaged.
            cwd: app.isPackaged ? process.resourcesPath : __dirname,
            // See startComfyUi.
            windowsHide: true,
            stdio: SERVICE_STDIO,
            env: {
                ...process.env,
                // Piped stdout is not a TTY, so Python switches to block
                // buffering: a crash during model load would discard every
                // print that explained it, leaving an empty log. Unbuffered
                // means whatever it managed to say actually reaches the file.
                PYTHONUNBUFFERED: '1',
                // Avoid a UnicodeEncodeError masquerading as a startup crash
                // when a dependency prints non-ASCII to a non-console stream.
                PYTHONIOENCODING: 'utf-8'
            }
        }
    );

    const speechLogPath = attachServiceLogging(speechProcess, 'speech', speechPython, [speechScript]);

    sessionTracker.recordChildProcess('speechProcess', speechProcess.pid);

    /*
        Verify it actually comes up.

        ComfyUI gets ensureComfyUiRunning(), which polls its port and reports
        failure. The speech service was pure fire-and-forget: if it died, the
        only evidence anywhere was a red dot in the UI. First load can take a
        while (faster-whisper loads the model BEFORE Flask binds), so this
        polls patiently and then says exactly what it found.
    */
    (async () => {
        const timeoutMs = 90000;
        const startedAt = Date.now();
        const whisperPort = (() => {
            try { return Number(new URL(process.env.WHISPER_URL || 'http://127.0.0.1:8765').port) || 8765; }
            catch { return 8765; }
        })();

        while (Date.now() - startedAt < timeoutMs) {
            if (await isTcpPortOpen('127.0.0.1', whisperPort)) {
                console.log(`[AURA] Speech service is listening on ${whisperPort}.`);
                return;
            }

            // Exited already? Then waiting longer is pointless.
            if (!speechProcess || speechProcess.exitCode !== null) {
                console.error(
                    `[AURA] Speech service exited before binding port ${whisperPort}. ` +
                    `See ${speechLogPath} for the reason.`
                );
                return;
            }

            await new Promise(resolve => setTimeout(resolve, 500));
        }

        console.error(
            `[AURA] Speech service did not bind port ${whisperPort} within ` +
            `${timeoutMs / 1000}s, and the process is still running. ` +
            `See ${speechLogPath}.`
        );
    })();

    speechProcess.once('exit', (code, signal) => {
        console.log(
            `Speech service exited. code=${code} signal=${signal}`
        );

        speechProcess = null;
        sessionTracker.recordChildProcess('speechProcess', null);
    });
}

function createMainWindow() {
    mainWindow = new BrowserWindow({
        width: 1600,
        height: 950,
        backgroundColor: '#0f1117',
        title: 'Aura Control Panel',

        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            webSecurity: false,
            preload: path.join(__dirname, 'electron-preload.js'),

            // Keep Aura camera rendering active while the window is minimized.
            backgroundThrottling: false
        }
    });

    mainWindow.loadURL(
    `http://localhost:${process.env.PORT}`
);

/*
    Chromium persists zoom level per-origin across restarts (e.g. a stray
    Ctrl+- ends up silently saved for localhost:PORT forever after). Force
    it back to 100% on every load so the UI always renders at the font
    sizes it's actually styled for, instead of a shrunk leftover zoom.
*/
mainWindow.webContents.on('did-finish-load', () => {
    mainWindow.webContents.setZoomFactor(1);
});

mainWindow.webContents.on(
    'render-process-gone',
    (event, details) => {
        console.error(
            'MAIN WINDOW RENDERER CRASHED:',
            details
        );
    }
);

    mainWindow.on('closed', () => {
        mainWindow = null;
    });
}

function notifyOutputWindowState(open) {
    if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send(
            'aura-output-window:state',
            { open }
        );
    }
}

function createOutputWindow() {
    outputWindow = new BrowserWindow({
        width: 1280,
        height: 720,
        backgroundColor: '#000000',
        title: 'Aura Output',
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            webSecurity: false,

            // The output window mirrors live frames too; keep it rendering
            // when minimized/backgrounded for the same reason as the main
            // window.
            backgroundThrottling: false
        }
    });

    outputWindow.loadURL(
    `http://localhost:${process.env.PORT}/aura-output/`
);

    notifyOutputWindowState(true);

    outputWindow.webContents.on(
        'render-process-gone',
        (event, details) => {
            console.error(
                'OUTPUT WINDOW RENDERER CRASHED:',
                details
            );
        }
    );

    outputWindow.on('closed', () => {
        outputWindow = null;
        notifyOutputWindowState(false);
    });
}

function openOutputWindow() {
if (outputWindow && !outputWindow.isDestroyed()) {
    outputWindow.show();
    outputWindow.focus();
    notifyOutputWindowState(true);
    return;
}

    createOutputWindow();
}

// -----------------------------------------------------------------------------
// Aura Native Output Process
// -----------------------------------------------------------------------------
// AuraFrameBridge is a normal runtime process. Virtual-camera registration is
// an installation task and is deliberately not performed here.

const AURA_FRAME_BRIDGE_HOST = '127.0.0.1';
const AURA_FRAME_BRIDGE_PORT = 5151;

function getAuraFrameBridgePath() {
    if (process.env.AURA_FRAME_BRIDGE_EXE) {
        return path.resolve(
            process.env.AURA_FRAME_BRIDGE_EXE
        );
    }

    // Native .exe files can't live inside app.asar (Windows can't
    // CreateProcess a path into an archive) -- packaged builds ship them
    // as extraResources instead, flattened under resources/native/.
    if (app.isPackaged) {
        return path.join(
            process.resourcesPath,
            'native',
            'AuraFrameBridge.exe'
        );
    }

    return path.join(
        __dirname,
        'native',
        'AuraFrameBridge',
        'AuraFrameBridge',
        'x64',
        'Debug',
        'AuraFrameBridge.exe'
    );
}

function isTcpPortOpen(host, port, timeoutMs = 500) {
    return new Promise(resolve => {
        const socket = new net.Socket();
        let completed = false;

        function finish(result) {
            if (completed) {
                return;
            }

            completed = true;
            socket.destroy();
            resolve(result);
        }

        socket.setTimeout(timeoutMs);

        socket.once('connect', () => {
            finish(true);
        });

        socket.once('timeout', () => {
            finish(false);
        });

        socket.once('error', () => {
            finish(false);
        });

        socket.connect(port, host);
    });
}

async function waitForAuraFrameBridge(
    timeoutMs = 5000,
    pollIntervalMs = 100
) {
    const startedAt = Date.now();

    while (Date.now() - startedAt < timeoutMs) {
        const ready = await isTcpPortOpen(
            AURA_FRAME_BRIDGE_HOST,
            AURA_FRAME_BRIDGE_PORT
        );

        if (ready) {
            return true;
        }

        await new Promise(resolve => {
            setTimeout(resolve, pollIntervalMs);
        });
    }

    return false;
}

async function waitForAuraServer(
    timeoutMs = 15000,
    pollIntervalMs = 100
) {
    const startedAt = Date.now();
    const port = Number(process.env.PORT) || 5150;

    while (Date.now() - startedAt < timeoutMs) {
        const ready = await isTcpPortOpen('127.0.0.1', port);

        if (ready) {
            return true;
        }

        await new Promise(resolve => {
            setTimeout(resolve, pollIntervalMs);
        });
    }

    return false;
}

async function ensureAuraFrameBridgeRunning() {
    const alreadyRunning = await isTcpPortOpen(
        AURA_FRAME_BRIDGE_HOST,
        AURA_FRAME_BRIDGE_PORT
    );

    if (alreadyRunning) {
        return {
            success: true,
            started: false,
            alreadyRunning: true,
            message: 'AuraFrameBridge is already running.'
        };
    }

    const bridgePath = getAuraFrameBridgePath();

    if (!fs.existsSync(bridgePath)) {
        return {
            success: false,
            error:
                'AuraFrameBridge.exe was not found at: ' +
                bridgePath
        };
    }

    if (
        auraFrameBridgeProcess &&
        auraFrameBridgeProcess.exitCode === null &&
        !auraFrameBridgeProcess.killed
    ) {
        const becameReady =
            await waitForAuraFrameBridge();

        return becameReady
            ? {
                success: true,
                started: false,
                alreadyRunning: true,
                message: 'AuraFrameBridge is running.'
            }
            : {
                success: false,
                error:
                    'AuraFrameBridge process exists, but TCP port 5151 did not become ready.'
            };
    }

    console.log(
        'Starting AuraFrameBridge:',
        bridgePath
    );

    auraFrameBridgeProcess = spawn(
        bridgePath,
        [],
        {
            cwd: path.dirname(bridgePath),
            shell: false,
            windowsHide: true,
            // windowsHide already suppresses this console app's window, but
            // with 'inherit' that also silently discarded its output in a
            // packaged run - including the once-per-second frame heartbeat
            // ("Received Aura frame N | WxH | bytes=") that is the clearest
            // evidence of whether frames are reaching the virtual camera.
            stdio: SERVICE_STDIO
        }
    );

    attachServiceLogging(auraFrameBridgeProcess, 'frame-bridge', bridgePath, []);

    auraFrameBridgeProcess.once('error', error => {
        console.error(
            'AuraFrameBridge process error:',
            error
        );
    });

    sessionTracker.recordChildProcess(
        'auraFrameBridgeProcess',
        auraFrameBridgeProcess.pid
    );

    auraFrameBridgeProcess.once('exit', (code, signal) => {
        console.log(
            `AuraFrameBridge exited. code=${code} signal=${signal}`
        );

        auraFrameBridgeProcess = null;
        sessionTracker.recordChildProcess('auraFrameBridgeProcess', null);
    });

    const ready =
        await waitForAuraFrameBridge();

    if (!ready) {
        if (
            auraFrameBridgeProcess &&
            auraFrameBridgeProcess.exitCode === null
        ) {
            auraFrameBridgeProcess.kill();
        }

        auraFrameBridgeProcess = null;

        return {
            success: false,
            error:
                'AuraFrameBridge did not become ready on 127.0.0.1:5151.'
        };
    }

    return {
        success: true,
        started: true,
        alreadyRunning: false,
        message: 'AuraFrameBridge started.'
    };
}

// -----------------------------------------------------------------------------
// Aura Virtual Camera Host
// -----------------------------------------------------------------------------
// This currently launches the Microsoft-sample-derived host executable.
// It runs invisibly after the VCamSample UI and startup dialog are removed.

function getAuraCameraHostPath() {
    if (process.env.AURA_CAMERA_HOST_EXE) {
        return path.resolve(
            process.env.AURA_CAMERA_HOST_EXE
        );
    }

    if (app.isPackaged) {
        return path.join(
            process.resourcesPath,
            'native',
            'VCamSample.exe'
        );
    }

    return path.join(
        __dirname,
        'native',
        'external',
        'VCamSample',
        'x64',
        'Debug',
        'VCamSample.exe'
    );
}

function isOwnedProcessRunning(processHandle) {
    return Boolean(
        processHandle &&
        processHandle.exitCode === null &&
        !processHandle.killed
    );
}

function isWindowsProcessRunning(executableName) {
    try {
        const output = execFileSync(
            'tasklist.exe',
            [
                '/FI',
                `IMAGENAME eq ${executableName}`,
                '/NH'
            ],
            {
                encoding: 'utf8',
                windowsHide: true
            }
        );

        return output
            .toLowerCase()
            .includes(
                executableName.toLowerCase()
            );

    } catch (error) {
        console.warn(
            `Could not check for ${executableName}:`,
            error.message
        );

        return false;
    }
}

// -----------------------------------------------------------------------------
// Hide Aura Camera Host Windows
// -----------------------------------------------------------------------------
// VCamSample's original TaskDialog is retained because it provides the stable
// Media Foundation host lifetime. Aura hides every top-level window belonging
// to that exact process after launch, while leaving the process running.

function hideAuraCameraHostWindows(processId) {
    if (!processId) {
        return;
    }

    const powershellScript = `
Add-Type @"
using System;
using System.Runtime.InteropServices;

public static class AuraWindowControl
{
    public delegate bool EnumWindowsProc(IntPtr hwnd, IntPtr lParam);

    [DllImport("user32.dll")]
    public static extern bool EnumWindows(
        EnumWindowsProc callback,
        IntPtr lParam
    );

    [DllImport("user32.dll")]
    public static extern uint GetWindowThreadProcessId(
        IntPtr hwnd,
        out uint processId
    );

    [DllImport("user32.dll")]
    public static extern bool IsWindowVisible(
        IntPtr hwnd
    );

    [DllImport("user32.dll")]
    public static extern bool ShowWindow(
        IntPtr hwnd,
        int command
    );
}
"@

$targetProcessId = ${processId}
$hideCommand = 0

for ($attempt = 0; $attempt -lt 50; $attempt++) {
    [AuraWindowControl]::EnumWindows(
        {
            param($windowHandle, $parameter)

            [uint32]$windowProcessId = 0

            [AuraWindowControl]::GetWindowThreadProcessId(
                $windowHandle,
                [ref]$windowProcessId
            ) | Out-Null

            if (
                $windowProcessId -eq $targetProcessId -and
                [AuraWindowControl]::IsWindowVisible($windowHandle)
            ) {
                [AuraWindowControl]::ShowWindow(
                    $windowHandle,
                    $hideCommand
                ) | Out-Null
            }

            return $true
        },
        [IntPtr]::Zero
    ) | Out-Null

    Start-Sleep -Milliseconds 100
}
`;

    const windowHiderProcess =
        spawn(
            'powershell.exe',
            [
                '-NoProfile',
                '-NonInteractive',
                '-ExecutionPolicy',
                'Bypass',
                '-WindowStyle',
                'Hidden',
                '-Command',
                powershellScript
            ],
            {
                shell: false,
                windowsHide: true,
                detached: false,
                stdio: 'ignore'
            }
        );

    windowHiderProcess.once(
        'error',
        error => {
            console.error(
                'Aura Camera window hiding failed:',
                error
            );
        }
    );
}

async function ensureAuraCameraHostRunning() {
    if (isOwnedProcessRunning(auraCameraHostProcess)) {
        return {
            success: true,
            started: false,
            alreadyRunning: true,
            message: 'Aura Camera host is already running.'
        };
    }

    /*
        A camera host may have been launched manually or by another Aura
        instance. Do not start a duplicate session virtual camera.
    */
    if (isWindowsProcessRunning('VCamSample.exe')) {
        return {
            success: true,
            started: false,
            alreadyRunning: true,
            message:
                'Aura Camera host is already running externally.'
        };
    }

    const cameraHostPath =
        getAuraCameraHostPath();

    if (!fs.existsSync(cameraHostPath)) {
        return {
            success: false,
            error:
                'Aura Camera host was not found at: ' +
                cameraHostPath
        };
    }

    console.log(
        'Starting Aura Camera host:',
        cameraHostPath
    );

    const cameraHostProcess =
        spawn(
            cameraHostPath,
            [],
            {
                cwd: path.dirname(cameraHostPath),
                shell: false,
                windowsHide: true,
                detached: false,
                // See ensureAuraFrameBridgeRunning.
                stdio: SERVICE_STDIO
            }
        );

    attachServiceLogging(cameraHostProcess, 'camera-host', cameraHostPath, []);

auraCameraHostProcess =
    cameraHostProcess;

sessionTracker.recordChildProcess(
    'auraCameraHostProcess',
    cameraHostProcess.pid
);

/*
    The original VCamSample window and TaskDialog may briefly appear while
    Media Foundation creates the virtual camera. Hide both without closing
    them, because the TaskDialog keeps the session camera host alive.
*/
hideAuraCameraHostWindows(
    cameraHostProcess.pid
);

cameraHostProcess.once(
    'error',
        error => {
            console.error(
                'Aura Camera host process error:',
                error
            );

            if (
                auraCameraHostProcess ===
                cameraHostProcess
            ) {
                auraCameraHostProcess = null;
            }
        }
    );

    cameraHostProcess.once(
        'exit',
        (code, signal) => {
            console.log(
                `Aura Camera host exited. code=${code} signal=${signal}`
            );

            if (
                auraCameraHostProcess ===
                cameraHostProcess
            ) {
                auraCameraHostProcess = null;
            }

            sessionTracker.recordChildProcess('auraCameraHostProcess', null);
        }
    );

    /*
        Give Media Foundation a brief moment to create the session-lifetime
        virtual camera. If the process exits immediately, startup failed.
    */
    await new Promise(resolve => {
        setTimeout(resolve, 750);
    });

    if (!isOwnedProcessRunning(cameraHostProcess)) {
        return {
            success: false,
            error:
                'Aura Camera host exited before the virtual camera became ready.'
        };
    }

    return {
        success: true,
        started: true,
        alreadyRunning: false,
        message: 'Aura Camera host started.'
    };
}

ipcMain.handle(
    'aura-native:ensure-running',
    async () => {
        try {
            const bridgeResult =
                await ensureAuraFrameBridgeRunning();

            if (!bridgeResult.success) {
                return bridgeResult;
            }

            const cameraHostResult =
                await ensureAuraCameraHostRunning();

            if (!cameraHostResult.success) {
                return cameraHostResult;
            }

            return {
                success: true,

                bridgeStarted:
                    bridgeResult.started === true,

                cameraHostStarted:
                    cameraHostResult.started === true,

                message:
                    `${bridgeResult.message} ` +
                    `${cameraHostResult.message}`
            };

        } catch (error) {
            console.error(
                'Aura native startup failed:',
                error
            );

            return {
                success: false,
                error:
                    error?.message ||
                    'Aura native startup failed.'
            };
        }
    }
);
// -----------------------------------------------------------------------------
// Aura Frame Export Transport
// -----------------------------------------------------------------------------
// Proof-test version:
// Opens pipe, sends one complete AFTS frame, closes pipe.

const AURA_FRAME_PIPE_PATH =
    '\\\\.\\pipe\\AuraFrameBridgePipe';

const AURA_FRAME_HEADER_SIZE = 44;

// Wraps the incoming pixel bytes as a Buffer VIEW (no copy) and builds the
// 44-byte header separately. Previously this allocated a fresh
// header+pixels buffer (~3.7 MB at 1280x720) and memcpy'd the pixels into
// it on every single frame -- a large per-frame allocation + copy + GC
// churn on the main process. The header and pixel view are now written to
// the pipe as two ordered writes instead (see sendAuraFrameToPipe).
function buildAuraFrameParts(frame) {
    if (!frame || !frame.pixels) {
        throw new Error('Invalid Aura frame: missing pixels.');
    }

    const pixels = frame.pixels;

    const pixelView =
        Buffer.from(
            pixels.buffer || pixels,
            pixels.byteOffset || 0,
            pixels.byteLength !== undefined ? pixels.byteLength : pixels.length
        );

    if (!pixelView.length) {
        throw new Error('Invalid Aura frame: empty pixel buffer.');
    }

    const header = Buffer.allocUnsafe(AURA_FRAME_HEADER_SIZE);

    header.writeUInt32LE(0x41555241, 0); // 'AURA'
    header.writeUInt32LE(1, 4);
    header.writeUInt32LE(frame.width, 8);
    header.writeUInt32LE(frame.height, 12);
    header.writeUInt32LE(frame.stride, 16);
    header.writeUInt32LE(1, 20); // BGRA32
    header.writeBigUInt64LE(BigInt(frame.frameNumber), 24);
    header.writeBigUInt64LE(BigInt(frame.timestampMs), 32);
    header.writeUInt32LE(pixelView.length, 40);

    return { header, pixelView };
}

/*
    Frame export runs at ~30 FPS. Reconnecting a new named-pipe handle for
    every frame (create/connect/disconnect) is expensive on Windows and was
    stalling the Electron main process, which in turn froze the renderer UI
    whenever a streaming feature (camera / Play Mode) was active.

    Instead, keep a single pipe connection open for the life of the camera
    session and only reconnect if it drops.
*/
function connectAuraFramePipe() {
    return new Promise((resolve, reject) => {
        /*
            AuraFrameBridge's pipe is PIPE_ACCESS_INBOUND (server can only
            read). Node's client still probes the read direction and sees an
            immediate phantom EOF, which fires 'end'. With the default
            allowHalfOpen:false, that auto-destroys the writable side a
            moment later, breaking the very next frame write even though
            nothing is actually wrong. allowHalfOpen:true keeps the socket
            writable for the life of the session.
        */
        const client =
            net.createConnection({
                path: AURA_FRAME_PIPE_PATH,
                allowHalfOpen: true
            });

        const onConnect = () => {
            client.removeListener('error', onInitialError);
            resolve(client);
        };

        const onInitialError = error => {
            client.removeListener('connect', onConnect);
            reject(error);
        };

        client.once('connect', onConnect);
        client.once('error', onInitialError);

        client.on('error', () => {
            if (auraFramePipeClient === client) {
                auraFramePipeClient = null;
            }
        });

        client.on('close', () => {
            if (auraFramePipeClient === client) {
                auraFramePipeClient = null;
            }
        });
    });
}

function getAuraFramePipeClient() {
    if (auraFramePipeClient && !auraFramePipeClient.destroyed) {
        return Promise.resolve(auraFramePipeClient);
    }

    if (!auraFramePipeConnecting) {
        auraFramePipeConnecting =
            connectAuraFramePipe()
                .then(client => {
                    auraFramePipeClient = client;
                    return client;
                })
                .finally(() => {
                    auraFramePipeConnecting = null;
                });
    }

    return auraFramePipeConnecting;
}

async function sendAuraFrameToPipe(frame) {
    let parts;

    try {
        parts = buildAuraFrameParts(frame);
    } catch (error) {
        return {
            success: false,
            error: error.message
        };
    }

    let client;

    try {
        client = await getAuraFramePipeClient();
    } catch (error) {
        return {
            success: false,
            error: error.message
        };
    }

    // Two ordered writes on the same stream: header, then pixels. A stream
    // socket preserves write order, so the reader still sees a contiguous
    // 44-byte header immediately followed by its pixel payload -- identical
    // bytes on the wire to the old single-buffer path, without the big
    // per-frame allocation and copy. The renderer awaits this reply and only
    // sends one frame at a time, so nothing queues unbounded.
    return new Promise(resolve => {
        client.write(parts.header);

        client.write(parts.pixelView, error => {
            if (error) {
                resolve({
                    success: false,
                    error: error.message
                });

                return;
            }

            resolve({
                success: true,
                bytesSent: parts.header.length + parts.pixelView.length
            });
        });
    });
}

ipcMain.handle(
    'aura-frame-export:send-frame',
    async (event, frame) => {
        return sendAuraFrameToPipe(frame);
    }
);

// -----------------------------------------------------------------------------
// Diagnostic logs (Settings -> Diagnostic Logs)
// -----------------------------------------------------------------------------
// Service failures are otherwise invisible: a packaged app has no console, so
// the only way a user (or a tester who cannot run PowerShell) can see WHY
// something is red is to read these files. Surfacing them in the UI means a
// tester can copy the relevant lines straight out of the app.

// Only ever serve *.log from the log directory itself. `name` arrives from the
// renderer, so a path separator or ".." in it must not be able to reach out of
// that folder and read arbitrary files.
function resolveLogPath(name) {
    if (typeof name !== 'string' || !name) { return null; }
    if (name !== path.basename(name)) { return null; }
    if (path.extname(name).toLowerCase() !== '.log') { return null; }

    const full = path.join(auraLogDir, name);
    const rel = path.relative(auraLogDir, full);
    if (rel.startsWith('..') || path.isAbsolute(rel)) { return null; }

    return full;
}

ipcMain.handle('aura-logs:list', () => {
    try {
        if (!fs.existsSync(auraLogDir)) {
            return { success: true, dir: auraLogDir, logs: [] };
        }

        const logs = fs.readdirSync(auraLogDir)
            .filter(f => path.extname(f).toLowerCase() === '.log')
            .map(f => {
                const stat = fs.statSync(path.join(auraLogDir, f));
                return {
                    name: f,
                    size: stat.size,
                    modified: stat.mtime.toISOString()
                };
            })
            .sort((a, b) => b.modified.localeCompare(a.modified));

        return { success: true, dir: auraLogDir, logs };
    } catch (error) {
        return { success: false, error: error.message, dir: auraLogDir, logs: [] };
    }
});

ipcMain.handle('aura-logs:read', (event, name) => {
    const full = resolveLogPath(name);

    if (!full) {
        return { success: false, error: 'Invalid log name.' };
    }

    try {
        if (!fs.existsSync(full)) {
            return { success: false, error: 'That log does not exist yet.' };
        }

        // These grow unbounded (ComfyUI is chatty). Read only the tail, or a
        // long session would push megabytes through IPC and freeze the UI.
        const maxBytes = 512 * 1024;
        const stat = fs.statSync(full);
        const start = Math.max(0, stat.size - maxBytes);

        const fd = fs.openSync(full, 'r');
        const length = stat.size - start;
        const buffer = Buffer.alloc(length);
        fs.readSync(fd, buffer, 0, length, start);
        fs.closeSync(fd);

        let text = buffer.toString('utf8');
        if (start > 0) {
            text = `[... truncated - showing the last ${Math.round(maxBytes / 1024)} KB of ${Math.round(stat.size / 1024)} KB ...]\n\n` + text;
        }

        return {
            success: true,
            name,
            path: full,
            size: stat.size,
            modified: stat.mtime.toISOString(),
            text
        };
    } catch (error) {
        return { success: false, error: error.message };
    }
});

ipcMain.handle('aura-logs:open-folder', async () => {
    try {
        fs.mkdirSync(auraLogDir, { recursive: true });
        await shell.openPath(auraLogDir);
        return { success: true, dir: auraLogDir };
    } catch (error) {
        return { success: false, error: error.message };
    }
});

ipcMain.handle('open-output-window', () => {
    openOutputWindow();

    return {
        success: true
    };
});

ipcMain.handle('aura-output-window:get-state', () => {
    return {
        open: !!(outputWindow && !outputWindow.isDestroyed())
    };
});

app.whenReady().then(async () => {

process.on('uncaughtException', error => {
    console.error('UNCAUGHT EXCEPTION');
    console.error(error);
});

process.on('unhandledRejection', error => {
    console.error('UNHANDLED REJECTION');
    console.error(error);
});

// -----------------------------------------------------------------------------
// Session Cleanup
// -----------------------------------------------------------------------------
// Detect and kill anything a previous, uncleanly-ended Aura session left
// running (crash, force-kill, Task Manager) before starting fresh.

    await sessionTracker.cleanupAbandonedSession(EXPECTED_CHILD_PROCESSES);

    sessionTracker.writeSession({
        pid: process.pid,
        startedAt: new Date().toISOString(),
        children: {
            comfyProcess: null,
            serverProcess: null,
            speechProcess: null,
            auraFrameBridgeProcess: null,
            auraCameraHostProcess: null
        }
    });

// -----------------------------------------------------------------------------
// Connect to AuraFrameBridge
// -----------------------------------------------------------------------------

    if (process.env.COMFYUI_AUTOSTART === 'true') {
    ensureComfyUiRunning().catch(console.error);
}
    await startAuraServer();
    startSpeechService();
    checkOllama();

    // A fixed delay here is a race: on a slower or cold-cache launch (first
    // run after install, ComfyUI/Whisper competing for startup time),
    // server.js may not be listening yet when the window tries to load it,
    // and loadURL doesn't retry -- the window is left showing a dead page.
    // Poll for the actual port instead of guessing a delay.
    const serverReady = await waitForAuraServer();

    if (!serverReady) {
        console.error(
            'Aura server did not become ready in time. Opening the window anyway.'
        );
    }

    createMainWindow();
});

function stopOwnedAuraNativeProcesses() {
    /*
        Only processes launched by this Electron instance have handles stored
        here. Manually launched processes are therefore left alone.
    */

    if (isOwnedProcessRunning(auraCameraHostProcess)) {
        console.log(
            'Stopping Aura Camera host.'
        );

        auraCameraHostProcess.kill();
    }

    auraCameraHostProcess = null;

    if (isOwnedProcessRunning(auraFrameBridgeProcess)) {
        console.log(
            'Stopping AuraFrameBridge.'
        );

        auraFrameBridgeProcess.kill();
    }

    auraFrameBridgeProcess = null;
}

/*
    Kill a child and everything it spawned.

    child.kill() only terminates the direct child. ComfyUI in particular
    spawns its own workers, so a plain kill leaves grandchildren running --
    holding port 8188 and (before windowsHide) a console window that outlives
    the app. taskkill /T walks the whole tree; /F because a console app that
    is mid-work will not always honour a polite request.
*/
function killProcessTree(child, label) {
    if (!child || child.exitCode !== null) {
        return;
    }

    console.log(`Stopping ${label} (pid ${child.pid}).`);

    if (process.platform === 'win32' && child.pid) {
        try {
            execFileSync('taskkill.exe', ['/F', '/T', '/PID', String(child.pid)], {
                windowsHide: true,
                stdio: 'ignore'
            });
            return;
        } catch (error) {
            // Already gone, or taskkill unavailable -- fall through to kill().
        }
    }

    try {
        child.kill();
    } catch (error) {
        console.warn(`Could not stop ${label}:`, error.message);
    }
}

/*
    One shutdown path used by EVERY quit route.

    This used to live only in window-all-closed, so quitting any other way
    (before-quit, taskbar close, second-instance handoff) tore down the native
    processes but left the server, speech service and ComfyUI running --
    abandoned, still holding their ports, and invisible to the next launch
    except through the session tracker's cleanup.

    Safe to call more than once: each kill is guarded and each handle nulled.
*/
let servicesStopped = false;

function stopAuraServices() {
    stopOwnedAuraNativeProcesses();

    killProcessTree(serverProcess, 'Aura server');
    serverProcess = null;

    killProcessTree(speechProcess, 'speech service');
    speechProcess = null;

    killProcessTree(comfyProcess, 'ComfyUI');
    comfyProcess = null;

    if (!servicesStopped) {
        servicesStopped = true;
        sessionTracker.clearSession();
    }
}

app.on('before-quit', () => {
    stopAuraServices();
});

app.on('will-quit', () => {
    stopAuraServices();
});

app.on('window-all-closed', () => {
    stopAuraServices();
    app.quit();
});
